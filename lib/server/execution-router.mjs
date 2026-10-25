const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const RUNTIMES = new Set(["nightshift", "openclaw", "auggie"]);
const name = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);

/** Explicit provider policy. Unspecified fields allow any authorized, eligible option;
 * explicit restrictions are never relaxed. Legacy `allowFallback: false` means "preferred only". */
export function providerPolicy(requirements) {
  const {
    requiredRuntime,
    requiredModelProvider,
    allowedRuntimes,
    preferredRuntime,
    preferredModelProvider,
    allowFallback,
  } = requirements;
  if (
    (requiredRuntime !== undefined && !RUNTIMES.has(requiredRuntime)) ||
    (preferredRuntime !== undefined && !RUNTIMES.has(preferredRuntime)) ||
    (requiredModelProvider !== undefined && !name(requiredModelProvider)) ||
    (preferredModelProvider !== undefined && !name(preferredModelProvider)) ||
    (allowedRuntimes !== undefined &&
      (!Array.isArray(allowedRuntimes) ||
        !allowedRuntimes.length ||
        !allowedRuntimes.every((runtime) => RUNTIMES.has(runtime)))) ||
    (allowFallback !== undefined && typeof allowFallback !== "boolean")
  )
    throw fail("Invalid provider policy.", 400);
  if (allowFallback === false && !preferredRuntime && !preferredModelProvider)
    throw fail("Provider restriction has no target: allowFallback false needs a preference.", 400);
  return {
    ...(requiredRuntime ? { requiredRuntime } : {}),
    ...(requiredModelProvider ? { requiredModelProvider } : {}),
    ...(allowedRuntimes ? { allowedRuntimes: [...allowedRuntimes] } : {}),
    ...(preferredRuntime ? { preferredRuntime } : {}),
    ...(preferredModelProvider ? { preferredModelProvider } : {}),
    restrictToPreferred: allowFallback === false,
  };
}

/** Compose existing registries; this class never sends a model request or retries an attempt.
 * Options are server-owned adapters, not client assertions or model-reported capabilities. */
export class ExecutionRouter {
  /** @param {any} primary @param {Array<any>} options
   * @param {{now?: () => number, preference?: string[], minSamples?: number}} [config] */
  /** @param {any} primary @param {Array<any>} options
   * @param {{now?: () => number, preference?: string[], minSamples?: number,
   *   failureLimit?: number, cooldownMs?: number}} [config] */
  constructor(
    primary,
    options,
    {
      now = () => Date.now(),
      preference = [],
      minSamples = 5,
      failureLimit = 3,
      cooldownMs = 10 * 60 * 1000,
    } = {},
  ) {
    this.primary = primary;
    this.options = options;
    this.now = now;
    this.preference = [...preference];
    this.minSamples = minSamples;
    this.failureLimit = failureLimit;
    this.cooldownMs = cooldownMs;
    const ids = new Set();
    const gateways = new Set();
    for (const option of options) {
      if (
        !option.id ||
        ids.has(option.id) ||
        gateways.has(option.registry.runtime.gatewayId) ||
        (option.registry !== primary &&
          option.registry.runtime.db.sharedDatabase !== primary.runtime.db) ||
        typeof option.snapshot !== "function"
      )
        throw fail(
          "Execution options require unique IDs, shared task storage and verified discovery.",
        );
      ids.add(option.id);
      gateways.add(option.registry.runtime.gatewayId);
    }
  }

  runtimeFor(assignment) {
    if (assignment?.gatewayId === this.primary.runtime.gatewayId) return this.primary.runtime;
    return this.options.find(
      (option) => option.registry.runtime.gatewayId === assignment?.gatewayId,
    )?.registry.runtime;
  }

  /** Runtime identity comes from the adapter; model identity only from verified discovery. */
  identity(option, snapshot) {
    return {
      runtime: option.registry.runtime.gateway.provider,
      modelProvider: name(snapshot?.modelProvider) ? snapshot.modelProvider : "unknown",
      model: typeof snapshot?.model === "string" && snapshot.model ? snapshot.model : null,
    };
  }

  eligible(option, requirements, policy, selection, { task, preflight }) {
    const snapshot = option.snapshot(selection.assignment, selection.manifest);
    const identity = this.identity(option, snapshot);
    const missing = [];
    const runtime = option.registry.runtime;
    if (policy.requiredRuntime && identity.runtime !== policy.requiredRuntime)
      missing.push(`required runtime ${policy.requiredRuntime}`);
    if (policy.allowedRuntimes && !policy.allowedRuntimes.includes(identity.runtime))
      missing.push(`runtime ${identity.runtime} not allowed by task policy`);
    if (
      policy.restrictToPreferred &&
      ((policy.preferredRuntime && identity.runtime !== policy.preferredRuntime) ||
        (policy.preferredModelProvider && identity.modelProvider !== policy.preferredModelProvider))
    )
      missing.push("task restricts execution to its preferred provider");
    if (
      runtime.gateway.status !== "connected" ||
      !runtime.agentsReady ||
      snapshot?.authenticated !== true
    )
      missing.push("authenticated healthy runtime");
    if (
      !Number.isFinite(snapshot?.checkedAt) ||
      this.now() - snapshot.checkedAt > 30000 ||
      snapshot.checkedAt > this.now()
    )
      missing.push(
        snapshot?.discoveryError
          ? `current capability discovery (last attempt failed: ${snapshot.discoveryError})`
          : "current capability discovery",
      );
    if (
      snapshot?.sessionKey !== selection.assignment?.sessionKey ||
      snapshot?.gatewayId !== runtime.gatewayId
    )
      missing.push("session-scoped capability evidence");
    if (policy.requiredModelProvider && identity.modelProvider !== policy.requiredModelProvider)
      missing.push(
        identity.modelProvider === "unknown"
          ? "verified model provider identity"
          : `required model provider ${policy.requiredModelProvider}`,
      );
    for (const tool of requirements.tools ?? [])
      if (!snapshot?.tools?.includes(tool)) missing.push(`tool ${tool}`);
    for (const capability of requirements.capabilities ?? [])
      if (!snapshot?.capabilities?.includes(capability)) missing.push(`capability ${capability}`);
    if (requirements.outputSchema && !snapshot?.outputSchemas?.includes(requirements.outputSchema))
      missing.push(`output schema ${requirements.outputSchema}`);
    if (
      snapshot?.permissions?.dataAccess !== requirements.permissions?.dataAccess ||
      snapshot?.permissions?.sensitiveWrites !== requirements.permissions?.sensitiveWrites
    )
      missing.push("effective permissions");
    // Enforcement is evidence from a reviewed adapter for this task, never an object's presence.
    if (!preflight) {
      let authorized = false;
      try {
        authorized =
          typeof option.authorize === "function" &&
          option.authorize({
            manifest: selection.manifest,
            assignment: selection.assignment,
            task,
          }) === true;
      } catch {
        authorized = false;
      }
      if (!authorized) missing.push("enforced tool and time budgets");
    }
    return { snapshot, identity, missing };
  }

  /** Observed execution completion only. It is not evidence of answer quality. */
  metrics(option) {
    const tasks = this.primary.runtime.db
      .listTasks(2000)
      .filter((task) => task.gatewayId === option.registry.runtime.gatewayId);
    const settled = tasks.filter((task) => ["completed", "failed"].includes(task.status));
    const completed = settled.filter((task) => task.status === "completed");
    const latencies = completed
      .map((task) => Date.parse(task.completedAt) - Date.parse(task.createdAt))
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    // Newest first: the leading run of failures since the last success.
    const recent = [...settled].sort(
      (a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt),
    );
    const streak = recent.findIndex((task) => task.status !== "failed");
    const consecutiveFailures = streak === -1 ? recent.length : streak;
    const lastFailure = consecutiveFailures
      ? Date.parse(recent[0].completedAt ?? recent[0].createdAt)
      : null;
    return {
      samples: settled.length,
      completionRate: settled.length ? completed.length / settled.length : null,
      latencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
      consecutiveFailures,
      lastFailureAt: Number.isFinite(lastFailure) ? new Date(lastFailure).toISOString() : null,
    };
  }

  /** Circuit breaker adapted from hermes-agent's kanban failure limit and fallback cooldown
   * (MIT): after repeated failures an option rests for a cooldown instead of absorbing more
   * work. It never retries anything itself; it only changes eligibility, with a reason. */
  circuit(metrics) {
    if (metrics.consecutiveFailures < this.failureLimit || !metrics.lastFailureAt) return null;
    const reopensAt = Date.parse(metrics.lastFailureAt) + this.cooldownMs;
    if (reopensAt <= this.now()) return null;
    return `circuit open after ${metrics.consecutiveFailures} consecutive failures; retry after ${new Date(reopensAt).toISOString()}`;
  }

  rank(candidate, requirements, policy) {
    const { option, snapshot, identity, metrics } = candidate;
    const preferredTools = requirements.preferredTools ?? [];
    const configured = [option.id, identity.runtime, identity.modelProvider]
      .map((key) => this.preference.indexOf(key))
      .filter((index) => index >= 0);
    const measured = metrics.samples >= this.minSamples;
    return {
      toolFit: preferredTools.filter((tool) => snapshot?.tools?.includes(tool)).length,
      taskPreference: Number(
        (!!policy.preferredRuntime && identity.runtime === policy.preferredRuntime) ||
          (!!policy.preferredModelProvider &&
            identity.modelProvider === policy.preferredModelProvider),
      ),
      configured: configured.length ? Math.min(...configured) : Infinity,
      latencyMs: measured ? (metrics.latencyMs ?? Infinity) : Infinity,
      completionRate: measured ? (metrics.completionRate ?? 0) : null,
    };
  }

  explain(winner, others, requirements) {
    const reason = [];
    const { rank, identity } = winner;
    if ((requirements.preferredTools ?? []).length)
      reason.push(
        `optional tool fit ${rank.toolFit}/${requirements.preferredTools.length} (verified discovery)`,
      );
    if (rank.taskPreference) reason.push("matches the task's preferred provider");
    if (Number.isFinite(rank.configured))
      reason.push(`configured preference position ${rank.configured + 1}`);
    if (Number.isFinite(rank.latencyMs))
      reason.push(`measured mean latency ${Math.round(rank.latencyMs)} ms`);
    if (rank.completionRate !== null)
      reason.push(
        `execution completion rate ${Math.round(rank.completionRate * 100)}% over ${winner.metrics.samples} tasks (completion, not answer quality)`,
      );
    reason.unshift(
      others.length
        ? `eligible alongside ${others.map((item) => item.option.id).join(", ")}; ranked first`
        : "only eligible option for the required capabilities, tools and permissions",
    );
    reason.push(`runtime ${identity.runtime}, model provider ${identity.modelProvider}`);
    return reason;
  }

  /** @param {{role?: string|null, requirements?: any, pinned?: any, task?: any, preflight?: boolean}} input */
  selectTask({ role = null, requirements, pinned, task = null, preflight = false }) {
    if (!requirements) return this.primary.assign({ task: { role } });
    const policy = providerPolicy(requirements);
    const alternatives = Array.isArray(requirements.anyOf) ? requirements.anyOf : [requirements];
    if (!alternatives.length || alternatives.length > 4)
      throw fail("Invalid requirement alternatives.", 400);
    const eligible = [];
    const rejected = [];
    for (const option of this.options) {
      if (pinned && option.registry.runtime.gatewayId !== pinned.gatewayId) continue;
      const open = this.circuit(this.metrics(option));
      if (open) {
        rejected.push({ optionId: option.id, missing: [open] });
        continue;
      }
      const missing = [];
      let found = null;
      for (const alternative of alternatives) {
        const selection = option.registry.selectTask({ role, requirements: alternative });
        if (selection.status !== "assigned") {
          missing.push(selection.reason ?? selection.status);
          continue;
        }
        if (
          pinned &&
          (selection.assignment.sessionKey !== pinned.sessionKey ||
            selection.assignment.seatId !== pinned.seatId)
        ) {
          missing.push("pinned session is no longer selected");
          continue;
        }
        const result = this.eligible(option, alternative, policy, selection, { task, preflight });
        if (result.missing.length) {
          missing.push(...result.missing);
          continue;
        }
        found = { option, selection, alternative, ...result, metrics: this.metrics(option) };
        break;
      }
      if (found) eligible.push(found);
      else rejected.push({ optionId: option.id, missing: [...new Set(missing)] });
    }
    for (const candidate of eligible)
      candidate.rank = this.rank(candidate, candidate.alternative, policy);
    eligible.sort(
      (a, b) =>
        b.rank.toolFit - a.rank.toolFit ||
        b.rank.taskPreference - a.rank.taskPreference ||
        a.rank.configured - b.rank.configured ||
        a.rank.latencyMs - b.rank.latencyMs ||
        (b.rank.completionRate ?? 0) - (a.rank.completionRate ?? 0) ||
        a.option.id.localeCompare(b.option.id),
    );
    const winner = eligible[0];
    if (!winner)
      return {
        status: "no_eligible_agent",
        reason: rejected.length
          ? rejected.map((item) => `${item.optionId}: ${item.missing.join(", ")}`).join("; ")
          : "No configured execution option matched this task.",
        rejected,
      };
    const preferred = !!(policy.preferredRuntime || policy.preferredModelProvider);
    return {
      ...winner.selection,
      requirements: winner.alternative,
      executionDecision: {
        optionId: winner.option.id,
        ...winner.identity,
        checkedAt: winner.snapshot.checkedAt,
        preferenceMatched: preferred ? winner.rank.taskPreference === 1 : null,
        authorization: preflight ? "deferred_to_dispatch" : "verified_for_task",
        policy,
        reason: this.explain(winner, eligible.slice(1), winner.alternative),
        metrics: winner.metrics,
        rejected,
      },
    };
  }

  assign(input) {
    return this.primary.assign(input);
  }

  dispatchOrchestration(input) {
    const registry = this.options.find(
      (option) => option.registry.runtime.gatewayId === input.selection.assignment.gatewayId,
    )?.registry;
    if (!registry) return this.primary.dispatchOrchestration(input);
    return registry.dispatchOrchestration(input);
  }
}
