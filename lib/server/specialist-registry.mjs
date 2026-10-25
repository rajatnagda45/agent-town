import { createHash } from "node:crypto";
import { assertOperationContract } from "../operations-contracts.mjs";
import { sessionAgent } from "./task-runtime.mjs";
import { SPECIALIST_CATALOGUE, validateCatalogue } from "./specialist-catalogue.mjs";
import { reviewedSkill } from "./specialist-skills.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const identifier = (value, max = 128) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value) && value.length <= max;
const capabilityId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const legacyDispatchHash = (selection, task) => {
  const oldSelection = { ...selection };
  const oldTask = { ...task };
  delete oldSelection.selectionReason;
  delete oldTask.requester;
  return digest({ selection: oldSelection, task: oldTask });
};
const terminal = new Set(["completed", "failed", "stopped", "interrupted"]);
const unresolved = new Set(["sending", "outcome_unknown", "binding_pending"]);

const exactPermissions = (manifest, requested) =>
  manifest.permissions.dataAccess === requested.dataAccess &&
  manifest.permissions.sensitiveWrites === requested.sensitiveWrites;

/** Registry selection is synchronous so Lane A can repeat it immediately before dispatch. */
export class SpecialistRegistry {
  constructor({
    runtime,
    journal,
    catalogue = SPECIALIST_CATALOGUE,
    grants = /** @type {Array<{manifestId: string, seatId: string, sessionKey?: string}>} */ ([]),
    profiles = {},
    enforcement,
    evidence = null,
    now = () => Date.now(),
  }) {
    this.runtime = runtime;
    this.journal = journal;
    this.catalogue = validateCatalogue(catalogue);
    this.grants = grants.map((grant) => ({ ...grant }));
    this.profiles = profiles;
    this.enforcement = enforcement;
    this.evidence = evidence;
    this.now = now;
    this.verifiedSessions = new Set();
    this.timers = new Map();
    if (
      !journal ||
      !["get", "list", "put"].every((method) => typeof journal[method] === "function")
    )
      throw new Error("Specialist journal is required for durable idempotency.");
    const ids = new Set(this.catalogue.map((entry) => entry.manifest.id));
    if (this.grants.some((grant) => !ids.has(grant.manifestId) || !identifier(grant.seatId)))
      throw new Error("Invalid reviewed specialist binding grant.");
    this.recover();
    this.unsubscribe = runtime.db.subscribe?.((event) => {
      if (!["task", "message"].includes(event.kind)) return;
      const taskId = event.kind === "task" ? event.data?.taskId : event.data?.taskId;
      if (!taskId) return;
      for (const row of this.journal.list("dispatch").filter((item) => item.taskId === taskId))
        void this.reconcileDispatch(row.id).catch(() => {});
      if (event.kind === "task")
        for (const row of this.journal
          .list("message")
          .filter((item) => item.childTaskId === taskId))
          this.reconcileMessage(row.correlationId);
    });
  }

  close() {
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Refresh session identity from the audited sessions.list method when isolated sessions are used. */
  async refreshSessions() {
    this.runtime.require("sessions.list");
    const result = await this.runtime.gateway.request("sessions.list", {});
    if (!Array.isArray(result?.sessions)) throw fail(502, "Invalid backend session listing.");
    this.verifiedSessions = new Set(
      result.sessions
        .filter(
          (row) =>
            typeof row?.key === "string" &&
            sessionAgent(row.key) &&
            (!row.agentId || row.agentId === sessionAgent(row.key)),
        )
        .map((row) => row.key),
    );
    return this.verifiedSessions.size;
  }

  entry(id) {
    return this.catalogue.find((item) => item.manifest.id === id);
  }

  binding(grant, manifest = this.entry(grant.manifestId)?.manifest) {
    if (!this.runtime.agentsReady || !manifest) return null;
    try {
      if (this.runtime.gateway.provider === "nightshift") {
        if (manifest.provider !== "meterless-nightshift" || !grant.sessionKey) return null;
        const role = manifest.id.replace(/^nightshift-/, "");
        const { seat, agentId, sessionKey } = this.runtime.resolve(grant.seatId, grant.sessionKey);
        if (
          seat.seatType !== "worker" ||
          agentId !== this.runtime.gateway.agentId ||
          sessionKey !== grant.sessionKey
        )
          return null;
        const context = this.runtime.gateway.registerReasoningContext({
          runtime: this.runtime,
          role,
          seatId: grant.seatId,
          sessionKey,
        });
        if (context.bindingRevision !== seat.binding.revision) return null;
        return {
          seatId: seat.seatId,
          agentId,
          sessionKey,
          gatewayId: this.runtime.gatewayId,
          bindingRevision: seat.binding.revision,
        };
      }
      if (this.runtime.gateway.provider !== "openclaw" || manifest.provider !== "openclaw")
        return null;
      const resolved = this.runtime.resolve(grant.seatId, grant.sessionKey);
      if (!this.runtime.agents.some((agent) => agent.agentId === resolved.agentId)) return null;
      if (resolved.seat.seatType !== "agent" && !this.verifiedSessions.has(resolved.sessionKey))
        return null;
      return {
        seatId: resolved.seat.seatId,
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        gatewayId: this.runtime.gatewayId,
        bindingRevision: resolved.seat.binding.revision,
      };
    } catch {
      return null;
    }
  }

  grantsFor(manifestId) {
    const dynamic = this.journal
      .list("provision")
      .filter((row) => row.manifestId === manifestId && row.status === "bound")
      .map((row) => ({ manifestId, seatId: row.seatId, sessionKey: row.sessionKey }));
    return [...this.grants.filter((grant) => grant.manifestId === manifestId), ...dynamic];
  }

  selectionReason(manifestId, assignment) {
    return this.grants.some(
      (grant) =>
        grant.manifestId === manifestId &&
        grant.seatId === assignment.seatId &&
        (!grant.sessionKey || grant.sessionKey === assignment.sessionKey),
    )
      ? "reviewed_grant"
      : "confirmed_provision";
  }

  /** Exact permission match prevents a read-only request from silently choosing Executor. */
  match(requirements) {
    const capabilities = requirements?.capabilities ?? [];
    const tools = requirements?.tools ?? [];
    const permissions = requirements?.permissions;
    if (
      !Array.isArray(capabilities) ||
      !Array.isArray(tools) ||
      !permissions ||
      !["none", "read_only", "scoped_write"].includes(permissions.dataAccess) ||
      !["denied", "approval_required"].includes(permissions.sensitiveWrites)
    )
      throw fail(400, "Invalid specialist requirements.");
    const candidates = this.catalogue
      .filter(
        ({ manifest }) =>
          manifest.provider ===
            (this.runtime.gateway.provider === "nightshift"
              ? "meterless-nightshift"
              : this.runtime.gateway.provider) &&
          exactPermissions(manifest, permissions) &&
          capabilities.every((item) => manifest.capabilities.includes(item)) &&
          tools.every((item) => manifest.tools.includes(item)) &&
          (requirements.maxRetries ?? 0) <= manifest.limits.maxRetries &&
          (requirements.maxRuntimeSeconds ?? 0) <= manifest.limits.maxRuntimeSeconds &&
          (requirements.maxToolCalls ?? 0) <= manifest.limits.maxToolCalls,
      )
      .flatMap(({ manifest }) =>
        this.grantsFor(manifest.id)
          .map((grant) => ({ manifest, assignment: this.binding(grant, manifest) }))
          .filter((candidate) => candidate.assignment),
      )
      .sort(
        (a, b) =>
          a.manifest.capabilities.length - b.manifest.capabilities.length ||
          a.manifest.tools.length - b.manifest.tools.length ||
          a.manifest.id.localeCompare(b.manifest.id) ||
          a.assignment.agentId.localeCompare(b.assignment.agentId) ||
          a.assignment.sessionKey.localeCompare(b.assignment.sessionKey),
      );
    return candidates[0]
      ? { status: "assigned", ...candidates[0] }
      : {
          status: "no_eligible_agent",
          reason: "No reviewed, currently bound specialist meets every requirement.",
        };
  }

  /** Select the least capable reviewed template that satisfies a task, reusing a bound seat first. */
  selectTask({ role = null, requirements }) {
    if (!requirements) return this.assign({ task: { role } });
    const {
      capabilities,
      tools,
      permissions,
      skillIds = [],
      maxRetries = 0,
      maxRuntimeSeconds = 0,
      maxToolCalls = 0,
    } = requirements;
    if (
      !Array.isArray(capabilities) ||
      capabilities.length > 16 ||
      !capabilities.every(capabilityId) ||
      !Array.isArray(tools) ||
      tools.length > 16 ||
      !tools.every(capabilityId) ||
      !Array.isArray(skillIds) ||
      skillIds.length > 8 ||
      !skillIds.every(capabilityId) ||
      new Set(skillIds).size !== skillIds.length ||
      !permissions ||
      !["none", "read_only", "scoped_write"].includes(permissions.dataAccess) ||
      !["denied", "approval_required"].includes(permissions.sensitiveWrites) ||
      ![maxRetries, maxRuntimeSeconds, maxToolCalls].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw fail(400, "Invalid specialist task requirements.");
    const provider =
      this.runtime.gateway.provider === "nightshift"
        ? "meterless-nightshift"
        : this.runtime.gateway.provider;
    const options = this.catalogue
      .filter(({ manifest }) => !role || manifest.id === role)
      .filter(
        ({ manifest }) => manifest.provider === provider && exactPermissions(manifest, permissions),
      )
      .filter(
        ({ manifest }) =>
          maxRetries <= manifest.limits.maxRetries &&
          maxRuntimeSeconds <= manifest.limits.maxRuntimeSeconds &&
          maxToolCalls <= manifest.limits.maxToolCalls,
      )
      .filter(({ manifest }) => tools.every((item) => manifest.tools.includes(item)))
      .map(({ manifest }) => {
        const skills = skillIds.map((id) => reviewedSkill(id, manifest.id, manifest.provider));
        if (
          skills.some(
            (skill) => !skill || skill.tools.length || !manifest.skills.includes(skill.id),
          )
        )
          return null;
        const effective = new Set([
          ...manifest.capabilities,
          ...skills.flatMap((skill) => skill.capabilities),
        ]);
        return capabilities.every((item) => effective.has(item)) ? { manifest, skills } : null;
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.manifest.capabilities.length - b.manifest.capabilities.length ||
          a.manifest.tools.length - b.manifest.tools.length ||
          a.manifest.id.localeCompare(b.manifest.id),
      );
    for (const candidate of options) {
      const assigned = this.assign({ task: { role: candidate.manifest.id } });
      if (assigned.status === "assigned")
        return { ...assigned, skills: candidate.skills, selectionReason: "reuse_verified_binding" };
    }
    const spawnable = options.find(
      ({ manifest }) => manifest.provider === "openclaw" && this.profiles[manifest.id],
    );
    return spawnable
      ? {
          status: "provision_required",
          manifest: spawnable.manifest,
          skills: spawnable.skills,
          reason: "No eligible bound specialist; an approved OpenClaw profile is available.",
        }
      : {
          status: "no_eligible_agent",
          reason: options.length
            ? "No verified binding or approved provider provisioning profile is available."
            : "No reviewed provider template satisfies the task requirements.",
        };
  }

  taskSkills(manifest, skillIds = []) {
    if (
      !Array.isArray(skillIds) ||
      skillIds.length > 8 ||
      new Set(skillIds).size !== skillIds.length
    )
      throw fail(400, "Invalid reviewed skill selection.");
    return skillIds.map((id) => {
      const skill = reviewedSkill(id, manifest.id, manifest.provider);
      if (!skill || !manifest.skills.includes(id) || skill.tools.length)
        throw fail(403, "Skill is not reviewed for this specialist or would require more tools.");
      return skill;
    });
  }

  /** Lane A calls this again before dispatch to detect changed permissions and bindings. */
  assign({ task }) {
    const entry = this.entry(task?.role);
    if (!entry)
      return { status: "no_eligible_agent", reason: "No reviewed specialist has this role." };
    const manifest = assertOperationContract("agentManifest", entry.manifest);
    if (
      manifest.provider !==
      (this.runtime.gateway.provider === "nightshift"
        ? "meterless-nightshift"
        : this.runtime.gateway.provider)
    )
      return {
        status: "no_eligible_agent",
        reason: "Specialist provider does not match the configured gateway.",
      };
    const candidates = this.grantsFor(manifest.id)
      .map((grant) => this.binding(grant, manifest))
      .filter(Boolean)
      .sort(
        (a, b) => a.agentId.localeCompare(b.agentId) || a.sessionKey.localeCompare(b.sessionKey),
      );
    return candidates[0]
      ? {
          status: "assigned",
          manifest,
          assignment: candidates[0],
          selectionReason: this.selectionReason(manifest.id, candidates[0]),
        }
      : { status: "no_eligible_agent", reason: "Specialist has no verified backend identity." };
  }

  sameAssignment(a, b) {
    return (
      !!a &&
      !!b &&
      ["seatId", "agentId", "sessionKey", "gatewayId", "bindingRevision"].every(
        (key) => a[key] === b[key],
      )
    );
  }

  revalidate(selection) {
    const latest = this.assign({ task: { role: selection?.manifest?.id } });
    if (
      latest.status !== "assigned" ||
      !this.sameAssignment(latest.assignment, selection.assignment) ||
      digest(latest.manifest) !== digest(selection.manifest)
    )
      throw fail(409, "Specialist permission or runtime binding changed.");
    return latest;
  }

  /** Provision only through the already audited, durable management operation. */
  async provision({ requestId, manifestId, requester = { kind: "user" } }) {
    if (!identifier(requestId, 80) || !this.entry(manifestId))
      throw fail(400, "A stable request ID and reviewed specialist are required.");
    const manifest = this.entry(manifestId).manifest;
    if (manifest.provider !== "openclaw" || this.runtime.gateway.provider !== "openclaw")
      throw fail(403, "This provider does not support reviewed specialist provisioning.");
    const profile = this.profiles[manifestId];
    if (!profile || !identifier(profile.seatId) || !profile.name || !profile.workspace)
      throw fail(403, "Specialist provisioning is not explicitly permitted.");
    const requestHash = digest({ manifestId, profile, requester });
    const legacyHash = digest({ manifestId, profile });
    const id = `lane-d-${requestId}`;
    const prior = this.journal.get("provision", id);
    if (prior) {
      if (prior.requestHash !== requestHash && prior.requestHash !== legacyHash)
        throw fail(409, "Provision ID was reused for another request.");
      return prior;
    }
    if (this.grantsFor(manifestId).some((grant) => this.binding(grant)))
      throw fail(409, "An existing specialist binding is available for reuse.");
    const seat = this.runtime.db.getSeat(profile.seatId);
    if (seat?.assigned)
      throw fail(409, "Approved specialist seat is occupied; no agent was created.");
    if (
      this.journal
        .list("provision")
        .some((row) => row.manifestId === manifestId && unresolved.has(row.status))
    )
      throw fail(409, "A specialist provision is pending or unresolved.");
    this.runtime.require("agents.create");
    this.runtime.require("agents.list");
    if (!this.runtime.gateway.audit.validators.has("AgentsCreateResultSchema"))
      throw fail(503, "Installed agent creation result contract is unavailable.");
    this.journal.put("provision", id, {
      requestHash,
      manifestId,
      templateVersion: manifest.version,
      templateSource: manifest.source,
      selectionReason: "provision_required",
      requester,
      permissions: manifest.permissions,
      limits: manifest.limits,
      seatId: profile.seatId,
      status: "sending",
      createdAt: new Date(this.now()).toISOString(),
    });
    let operation;
    try {
      operation = await this.runtime.management.mutate({
        operationId: id,
        method: "agents.create",
        params: { name: profile.name, workspace: profile.workspace },
      });
    } catch (error) {
      const status = error?.rejected ? "rejected" : "outcome_unknown";
      return this.journal.put("provision", id, {
        requestHash,
        manifestId,
        templateVersion: manifest.version,
        templateSource: manifest.source,
        selectionReason: "provision_required",
        requester,
        permissions: manifest.permissions,
        limits: manifest.limits,
        seatId: profile.seatId,
        status,
        createdAt: new Date(this.now()).toISOString(),
      });
    }
    const status = operation.status === "confirmed" ? "binding_pending" : operation.status;
    const saved = this.journal.put("provision", id, {
      requestHash,
      manifestId,
      templateVersion: manifest.version,
      templateSource: manifest.source,
      selectionReason: "provision_required",
      requester,
      permissions: manifest.permissions,
      limits: manifest.limits,
      seatId: profile.seatId,
      status,
      agentId: operation.agentId,
      createdAt: new Date(this.now()).toISOString(),
    });
    return status === "binding_pending" ? this.finishBinding(saved) : saved;
  }

  finishBinding(record) {
    const profile = this.profiles[record.manifestId];
    if (
      !profile ||
      !record.agentId ||
      !this.runtime.agentsReady ||
      !this.runtime.agents.some((agent) => agent.agentId === record.agentId)
    )
      return record;
    const existing = this.runtime.db.getSeat(record.seatId);
    if (existing?.assigned && existing.binding?.agentId !== record.agentId) return record;
    try {
      const seat = existing?.assigned
        ? existing
        : this.runtime.saveSeat({
            seatId: record.seatId,
            label: profile.label ?? profile.name,
            seatType: "agent",
            assigned: true,
            revision: existing?.binding?.revision,
            roleTitle: record.manifestId,
            spriteKey: existing?.spriteKey,
            spritePath: existing?.spritePath,
            agentConfig: { agentId: record.agentId },
          });
      const assignment = this.binding({ seatId: seat.seatId, manifestId: record.manifestId });
      if (!assignment || assignment.agentId !== record.agentId) return record;
      return this.journal.put("provision", record.id, {
        ...record,
        status: "bound",
        sessionKey: assignment.sessionKey,
        boundAt: new Date(this.now()).toISOString(),
      });
    } catch {
      return record;
    }
  }

  /** A second process can reconstruct pending work from the journal and runtime ledger. */
  recover() {
    for (const row of this.journal.list("provision")) {
      if (row.status === "sending")
        this.journal.put("provision", row.id, { ...row, status: "outcome_unknown" });
      else if (row.status === "binding_pending") this.finishBinding(row);
    }
    for (const row of this.journal.list("dispatch")) {
      if (row.status === "sending" && !this.runtime.db.getTask(row.taskId))
        this.journal.put("dispatch", row.id, { ...row, status: "outcome_unknown" });
      else if (["sending", "accepted", "outcome_unknown"].includes(row.status)) {
        void this.reconcileDispatch(row.id).catch(() => {});
        this.schedule(row);
      }
    }
    for (const row of this.journal.list("message"))
      if (["sending", "awaiting_response", "outcome_unknown"].includes(row.status)) {
        try {
          this.reconcileMessage(row.correlationId);
        } catch {
          this.journal.put("message", row.id, { ...row, status: "unresolved" });
        }
      }
  }

  schedule(record) {
    if (!record?.deadlineAt || this.timers.has(record.id)) return;
    const remaining = Math.max(0, Date.parse(record.deadlineAt) - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(record.id);
      void this.reconcileDispatch(record.id).catch(() => {});
    }, remaining);
    timer.unref?.();
    this.timers.set(record.id, timer);
  }

  /** Synchronous orchestration entry point. Async policy hooks fail closed. */
  dispatchOrchestration({ requestId, selection, task }) {
    if (!identifier(requestId, 80) || !identifier(task?.taskId, 100) || !task.message?.trim())
      throw fail(400, "Stable dispatch and task IDs are required.");
    const requestHash = digest({ selection, task });
    const legacyHash = legacyDispatchHash(selection, task);
    const id = `lane-d-${requestId}`;
    const prior = this.journal.get("dispatch", id);
    if (prior) {
      if (prior.requestHash !== requestHash && prior.requestHash !== legacyHash)
        throw fail(409, "Dispatch ID was reused for another task.");
      return prior;
    }
    const latest = this.revalidate(selection);
    const manifest = latest.manifest;
    const skills = this.taskSkills(manifest, task.skillIds);
    if (
      !Number.isSafeInteger(task.retryCount ?? 0) ||
      (task.retryCount ?? 0) > manifest.limits.maxRetries
    )
      throw fail(403, "Specialist retry limit exceeded.");
    if (
      this.runtime.db
        .activeTasks()
        .filter(
          (row) =>
            row.gatewayId === latest.assignment.gatewayId &&
            row.agentId === latest.assignment.agentId,
        ).length >= manifest.limits.maxParallelTasks
    )
      throw fail(409, "Specialist concurrency limit reached.");
    if (
      typeof this.enforcement?.authorizeSync !== "function" ||
      this.enforcement.authorizeSync({ manifest, assignment: latest.assignment, task }) !== true
    )
      throw fail(403, "Provider tool, write and time limits are not enforced for this specialist.");
    this.revalidate(selection);
    if (
      this.runtime.db
        .activeTasks()
        .filter(
          (row) =>
            row.gatewayId === latest.assignment.gatewayId &&
            row.agentId === latest.assignment.agentId,
        ).length >= manifest.limits.maxParallelTasks
    )
      throw fail(409, "Specialist concurrency limit reached.");
    const startedAt = this.now();
    this.journal.put("dispatch", id, {
      requestHash,
      taskId: task.taskId,
      manifestId: manifest.id,
      templateVersion: manifest.version,
      templateSource: manifest.source,
      skills: skills.map(({ id, version, source, digest }) => ({ id, version, source, digest })),
      selectionReason: selection.selectionReason ?? latest.selectionReason,
      requester: task.requester ?? { kind: "user" },
      task: { taskId: task.taskId, retryCount: task.retryCount ?? 0 },
      permissions: manifest.permissions,
      limits: manifest.limits,
      assignment: latest.assignment,
      status: "sending",
      deadlineAt: new Date(startedAt + manifest.limits.maxRuntimeSeconds * 1000).toISOString(),
      createdAt: new Date(startedAt).toISOString(),
    });
    let accepted;
    let permitted = false;
    try {
      if (manifest.provider === "meterless-nightshift") {
        const role = {
          "nightshift-planner": "planner",
          "nightshift-analyst": "analyst",
          "nightshift-critic": "critic",
        }[manifest.id];
        if (!role || typeof this.runtime.gateway.permitReasoningDispatch !== "function")
          throw fail(403, "Nightshift reasoning dispatch permit is unavailable.");
        this.runtime.gateway.permitReasoningDispatch({
          taskId: task.taskId,
          role,
          ...latest.assignment,
          maxRuntimeSeconds: manifest.limits.maxRuntimeSeconds,
        });
        permitted = true;
      }
      accepted = this.runtime.submit({
        taskId: task.taskId,
        message: skills.length
          ? `${task.message}\n\nReviewed task skills (instructions only; no additional tools or permissions):\n${skills.map((skill) => `[${skill.id}@${skill.version}] ${skill.instructions}`).join("\n")}`
          : task.message,
        seatId: latest.assignment.seatId,
        sessionKey: latest.assignment.sessionKey,
        bindingRevision: latest.assignment.bindingRevision,
      });
    } catch (error) {
      if (permitted) this.runtime.gateway.revokeReasoningDispatch?.(task.taskId);
      return this.journal.put("dispatch", id, {
        ...this.journal.get("dispatch", id),
        status:
          error?.rejected || (error?.status >= 400 && error?.status < 500)
            ? "rejected"
            : "outcome_unknown",
      });
    }
    const saved = this.journal.put("dispatch", id, {
      ...this.journal.get("dispatch", id),
      status: "accepted",
      runtimeTaskId: accepted.taskId,
    });
    this.schedule(saved);
    return saved;
  }

  async dispatch({ requestId, selection, task, beforeSubmit = null }) {
    if (
      !identifier(requestId, 80) ||
      !identifier(task?.taskId, 100) ||
      typeof task.message !== "string" ||
      !task.message.trim()
    )
      throw fail(400, "Stable dispatch and task IDs are required.");
    const requestHash = digest({ selection, task });
    const legacyHash = legacyDispatchHash(selection, task);
    const id = `lane-d-${requestId}`;
    const prior = this.journal.get("dispatch", id);
    if (prior) {
      if (prior.requestHash !== requestHash && prior.requestHash !== legacyHash)
        throw fail(409, "Dispatch ID was reused for another task.");
      return prior;
    }
    const latest = this.revalidate(selection);
    const manifest = latest.manifest;
    if (
      !Number.isSafeInteger(task.retryCount ?? 0) ||
      (task.retryCount ?? 0) > manifest.limits.maxRetries
    )
      throw fail(403, "Specialist retry limit exceeded.");
    if (
      this.runtime.db
        .activeTasks()
        .filter(
          (row) =>
            row.gatewayId === latest.assignment.gatewayId &&
            row.agentId === latest.assignment.agentId,
        ).length >= manifest.limits.maxParallelTasks
    )
      throw fail(409, "Specialist concurrency limit reached.");
    if (
      typeof this.enforcement?.authorize !== "function" ||
      (await this.enforcement.authorize({ manifest, assignment: latest.assignment, task })) !== true
    )
      throw fail(403, "Provider tool and time limits are not enforced for this specialist.");
    // Authorization may have awaited an external gateway. Check current state again before queueing.
    this.revalidate(selection);
    if (
      this.runtime.db
        .activeTasks()
        .filter(
          (row) =>
            row.gatewayId === latest.assignment.gatewayId &&
            row.agentId === latest.assignment.agentId,
        ).length >= manifest.limits.maxParallelTasks
    )
      throw fail(409, "Specialist concurrency limit reached.");
    if (beforeSubmit) beforeSubmit();
    const startedAt = this.now();
    this.journal.put("dispatch", id, {
      requestHash,
      taskId: task.taskId,
      manifestId: manifest.id,
      templateVersion: manifest.version,
      selectionReason: latest.selectionReason,
      requester: task.requester ?? { kind: "user" },
      task: { taskId: task.taskId, retryCount: task.retryCount ?? 0 },
      permissions: manifest.permissions,
      limits: manifest.limits,
      assignment: latest.assignment,
      status: "sending",
      deadlineAt: new Date(startedAt + manifest.limits.maxRuntimeSeconds * 1000).toISOString(),
      createdAt: new Date(startedAt).toISOString(),
    });
    let accepted;
    try {
      accepted = this.runtime.submit({
        taskId: task.taskId,
        message: task.message,
        seatId: latest.assignment.seatId,
        sessionKey: latest.assignment.sessionKey,
        bindingRevision: latest.assignment.bindingRevision,
      });
    } catch (error) {
      return this.journal.put("dispatch", id, {
        ...this.journal.get("dispatch", id),
        status:
          error?.rejected || (error?.status >= 400 && error?.status < 500)
            ? "rejected"
            : "outcome_unknown",
      });
    }
    const saved = this.journal.put("dispatch", id, {
      ...this.journal.get("dispatch", id),
      status: "accepted",
      runtimeTaskId: accepted.taskId,
    });
    this.schedule(saved);
    return saved;
  }

  async reconcileDispatch(id) {
    const record = this.journal.get("dispatch", id);
    if (!record) throw fail(404, "Specialist dispatch not found.");
    const task = this.runtime.db.getTask(record.taskId);
    if (!task) return record;
    if (record.status === "outcome_unknown" || task.status === "outcome_unknown")
      return record.status === "outcome_unknown"
        ? record
        : this.journal.put("dispatch", id, { ...record, status: "outcome_unknown" });
    if (terminal.has(task.status)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      return this.journal.put("dispatch", id, {
        ...record,
        status: task.status,
        runId: task.runId,
      });
    }
    const manifest = this.entry(record.manifestId)?.manifest;
    if (!manifest)
      return this.journal.put("dispatch", id, { ...record, status: "outcome_unknown" });
    const toolCount = this.runtime.db
      .messages(task.sessionKey)
      .filter((message) => message.taskId === task.taskId && message.role === "tool").length;
    if (toolCount <= manifest.limits.maxToolCalls && this.now() < Date.parse(record.deadlineAt))
      return record;
    try {
      await this.runtime.cancel(task.taskId);
    } catch {
      /* uncertain cancellation remains unresolved */
    }
    return this.journal.put("dispatch", id, {
      ...record,
      status: "outcome_unknown",
      reason: toolCount > manifest.limits.maxToolCalls ? "tool_limit" : "timeout",
    });
  }

  async send({
    correlationId,
    incidentId,
    fromManifestId,
    toManifestId,
    parentTaskId,
    childTaskId,
    message,
    evidenceIds = /** @type {string[]} */ ([]),
  }) {
    if (
      ![correlationId, incidentId, parentTaskId, childTaskId].every((value) => identifier(value)) ||
      typeof message !== "string" ||
      !message.trim() ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.some((id) => !identifier(id))
    )
      throw fail(400, "A correlated parent and child task are required.");
    const id = `lane-d-${correlationId}`;
    const requestHash = digest({
      incidentId,
      fromManifestId,
      toManifestId,
      parentTaskId,
      childTaskId,
      message,
      evidenceIds,
    });
    const prior = this.journal.get("message", id);
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw fail(409, "Correlation ID was reused for another message.");
      return prior;
    }
    if (evidenceIds.some((id) => this.evidence?.get?.(id)?.incidentId !== incidentId))
      throw fail(409, "Message evidence is unavailable or belongs to another incident.");
    const fromEntry = this.entry(fromManifestId);
    const toEntry = this.entry(toManifestId);
    if (
      !fromEntry?.mayMessage.includes(toManifestId) ||
      !fromEntry.manifest.tools.includes("agent.message") ||
      !toEntry
    )
      throw fail(403, "This specialist pairing is not permitted.");
    const from = this.assign({ task: { role: fromManifestId } });
    const to = this.assign({ task: { role: toManifestId } });
    if (
      from.status !== "assigned" ||
      to.status !== "assigned" ||
      (from.assignment.agentId === to.assignment.agentId &&
        from.assignment.sessionKey === to.assignment.sessionKey)
    )
      throw fail(409, "Agent-to-agent message requires two distinct verified runtime identities.");
    const parent = this.runtime.db.getTask(parentTaskId);
    if (
      !parent ||
      parent.gatewayId !== from.assignment.gatewayId ||
      parent.agentId !== from.assignment.agentId ||
      parent.sessionKey !== from.assignment.sessionKey ||
      parent.seatId !== from.assignment.seatId ||
      parent.bindingRevision !== from.assignment.bindingRevision
    )
      throw fail(409, "Sender task does not belong to the verified source agent.");
    this.journal.put("message", id, {
      correlationId,
      incidentId,
      from: from.assignment,
      to: to.assignment,
      parentTaskId,
      childTaskId,
      evidenceIds,
      requestHash,
      status: "sending",
      sentAt: new Date(this.now()).toISOString(),
    });
    let dispatch;
    try {
      dispatch = await this.dispatch({
        requestId: `message-${correlationId}`,
        selection: to,
        task: { taskId: childTaskId, message, retryCount: 0 },
        beforeSubmit: () => {
          const current = this.assign({ task: { role: fromManifestId } });
          if (
            current.status !== "assigned" ||
            !this.sameAssignment(current.assignment, from.assignment) ||
            !this.runtime.db.getTask(parentTaskId)
          )
            throw fail(409, "Sender binding changed before message dispatch.");
        },
      });
    } catch (error) {
      return this.journal.put("message", id, {
        ...this.journal.get("message", id),
        status: error?.status >= 400 && error?.status < 500 ? "rejected" : "outcome_unknown",
        sendResult: { status: "not_accepted", taskId: childTaskId },
      });
    }
    const current = this.journal.get("message", id);
    this.journal.put("message", id, {
      ...current,
      status:
        dispatch.status === "accepted"
          ? "awaiting_response"
          : dispatch.status === "rejected"
            ? "rejected"
            : "outcome_unknown",
      sendResult: { status: dispatch.status, taskId: dispatch.runtimeTaskId ?? childTaskId },
    });
    return this.reconcileMessage(correlationId);
  }

  reconcileMessage(correlationId) {
    const id = `lane-d-${correlationId}`;
    const record = this.journal.get("message", id);
    if (!record) throw fail(404, "Specialist message not found.");
    const task = this.runtime.db.getTask(record.childTaskId);
    if (!task)
      return record.status === "sending"
        ? this.journal.put("message", id, { ...record, status: "outcome_unknown" })
        : record;
    if (
      task.agentId !== record.to.agentId ||
      task.sessionKey !== record.to.sessionKey ||
      task.gatewayId !== record.to.gatewayId ||
      task.bindingRevision !== record.to.bindingRevision
    )
      throw fail(409, "Recipient task identity changed.");
    if (task.status === "completed" && typeof task.result === "string" && task.result.trim())
      return this.journal.put("message", id, {
        ...record,
        status: "responded",
        response: task.result,
        respondedAt: task.completedAt ?? new Date(this.now()).toISOString(),
        sendResult: { ...record.sendResult, status: task.status, runId: task.runId },
      });
    if (terminal.has(task.status) || task.status === "outcome_unknown")
      return this.journal.put("message", id, {
        ...record,
        status: "unresolved",
        sendResult: { ...record.sendResult, status: task.status, runId: task.runId },
      });
    return record;
  }
}
