import { createHash } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, max = 256) =>
  typeof value === "string" && !!value.trim() && value.length <= max;
const owner = (key) => /^agent:([a-zA-Z0-9_-]+):[^\s]+$/.exec(key ?? "")?.[1];
const unresolved = (op) => ["sending", "outcome_unknown"].includes(op.status);

/** All configuration mutations pass through the same runtime as task dispatch. */
export class ManagementService {
  constructor(runtime) {
    this.runtime = runtime;
    this.db = runtime.db;
    this.gateway = runtime.gateway;
    this.agentLocks = new Set();
    this.sessionLocks = new Set();
    for (const op of this.operations())
      if (op.status === "sending")
        this.saveOperation(op, {
          status: "outcome_unknown",
          error:
            "Server restarted during a configuration change. It will not be resent; refresh backend state.",
        });
  }
  operations() {
    return this.db
      .records("managementOperation")
      .filter((op) => op.gatewayId === this.runtime.gatewayId);
  }
  busyAgent(id) {
    return (
      this.agentLocks.has(id) ||
      this.operations().some((op) => op.agentId === id && !op.sessionKey && unresolved(op))
    );
  }
  busySession(key) {
    return (
      this.sessionLocks.has(key) ||
      this.operations().some((op) => op.sessionKey === key && unresolved(op))
    );
  }
  key(id) {
    return `${this.runtime.gatewayId}:${id}`;
  }
  snapshot() {
    return {
      agents: this.runtime.agents.map((agent) => ({ ...agent, configRevision: digest(agent) })),
      operations: this.operations(),
    };
  }
  captureAgents() {
    if (!this.runtime.agentsReady || this.runtime.closed) return;
    for (const agent of this.runtime.agents) {
      const key = this.key(`agent:${agent.agentId}`);
      if (this.db.record("configuration", key)?.configRevision !== digest(agent))
        this.db.saveRecord("configuration", key, {
          gatewayId: this.runtime.gatewayId,
          agent,
          configRevision: digest(agent),
        });
    }
    for (const op of this.operations())
      if (op.method === "agents.update" && unresolved(op)) {
        const agent = this.runtime.agents.find((agent) => agent.agentId === op.agentId);
        if (agent && this.matchesAgent(agent, op.params))
          this.saveOperation(op, { status: "confirmed", error: undefined });
      }
    this.db.publish(this.db.emit("management", this.snapshot()));
  }
  matchesAgent(agent, params) {
    return ["name", "workspace", "model"].every(
      (key) => !(key in params) || (agent[key] ?? null) === params[key],
    );
  }
  captureSessions(sessions) {
    if (this.runtime.closed || !Array.isArray(sessions)) return;
    for (const op of this.operations())
      if (op.method === "sessions.patch" && unresolved(op)) {
        const row = sessions.find((row) => row.key === op.sessionKey);
        // An effective model alone cannot prove whether a session override exists.
        if (!row || !("modelOverride" in row)) continue;
        const actual = row.modelOverride
          ? row.providerOverride
            ? `${row.providerOverride}/${row.modelOverride}`
            : row.modelOverride
          : null;
        if (actual === op.params.model)
          this.saveOperation(op, { status: "confirmed", error: undefined });
      }
  }
  saveOperation(op, patch) {
    return this.db.saveRecord("managementOperation", op.id, { ...op, ...patch });
  }
  idle(agentId, sessionKey) {
    if (
      this.runtime.db
        .activeTasks()
        .some(
          (task) =>
            task.gatewayId === this.runtime.gatewayId &&
            (sessionKey ? task.sessionKey === sessionKey : task.agentId === agentId),
        ) ||
      this.runtime.db
        .seats()
        .some(
          (seat) => seat.binding?.agentId === agentId && this.runtime.roleLocks.has(seat.seatId),
        ) ||
      this.runtime.reviews
        .items()
        .some(
          (item) =>
            item.agentId === agentId &&
            (!sessionKey || item.sessionKey === sessionKey) &&
            ["pending", "submitting", "outcome_unknown"].includes(item.status),
        )
    )
      throw fail(409, "Finish or reconcile outstanding work before editing backend configuration.");
  }
  async models(agentId, sessionKey) {
    this.runtime.require("models.list");
    if (
      !this.runtime.agentsReady ||
      !this.runtime.agents.some((agent) => agent.agentId === agentId)
    )
      throw fail(409, "Agent has not been verified by discovery.");
    if (sessionKey && owner(sessionKey) !== agentId)
      throw fail(409, "Session belongs to another agent.");
    const params = { agentId, ...(sessionKey ? { sessionKey } : {}) };
    // Older contracts may only allow the unscoped catalog; validate that explicitly.
    const result = await this.gateway.request(
      "models.list",
      this.gateway.audit.validate("models.list", params) ? params : {},
    );
    if (
      !Array.isArray(result?.models) ||
      result.models.some((model) => !text(model.id) || !text(model.provider))
    )
      throw fail(502, "Gateway returned an incompatible model catalog.");
    return {
      models: result.models.map((model) => ({
        id: model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`,
        name: model.name ?? model.id,
        verification: "listed_unverified",
      })),
      note: "Gateway-listed models are unverified. Listing and saving do not verify authentication, billing, or execution. No paid probe is performed.",
    };
  }
  async session(key, agentId) {
    this.runtime.require("sessions.list");
    if (
      !owner(key) ||
      owner(key) !== agentId ||
      !this.runtime.agents.some((agent) => agent.agentId === agentId)
    )
      throw fail(409, "Session belongs to another or unavailable agent.");
    const result = await this.gateway.request("sessions.list", {});
    const row = result?.sessions?.find(
      (session) => session.key === key && (!session.agentId || session.agentId === agentId),
    );
    if (!row)
      throw fail(
        404,
        "Session is not present in the verified backend listing. Run it once before configuring an override.",
      );
    const config = {
      key,
      agentId,
      sessionId: row.sessionId,
      lifecycleRevision: row.lifecycleRevision,
      overrideKnown: Object.prototype.hasOwnProperty.call(row, "modelOverride"),
      effectiveModel:
        typeof row.model === "string"
          ? row.modelProvider && !row.model.startsWith(`${row.modelProvider}/`)
            ? `${row.modelProvider}/${row.model}`
            : row.model
          : null,
      modelOverride:
        typeof row.modelOverride === "string" &&
        row.providerOverride &&
        !row.modelOverride.startsWith(`${row.providerOverride}/`)
          ? `${row.providerOverride}/${row.modelOverride}`
          : row.modelOverride,
      providerOverride: row.providerOverride,
    };
    return { ...config, configRevision: digest(config) };
  }
  async mutate(input) {
    if (!text(input.operationId, 100) || !/^[a-zA-Z0-9_-]+$/.test(input.operationId))
      throw fail(400, "A stable configuration operation ID is required.");
    if (!["agents.create", "agents.update", "sessions.patch"].includes(input.method))
      throw fail(400, "Unsupported management operation.");
    const method = input.method;
    const params = input.params;
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw fail(400, "Invalid configuration.");
    const allowed =
      method === "agents.create"
        ? ["name", "workspace", "model"]
        : method === "agents.update"
          ? ["agentId", "name", "workspace", "model"]
          : ["key", "model", "agentId"];
    if (
      Object.keys(params).some((key) => !allowed.includes(key)) ||
      Object.entries(params).some(
        ([key, value]) =>
          !(value === null && key === "model") && !text(value, key === "workspace" ? 4096 : 256),
      )
    )
      throw fail(400, "Invalid configuration fields.");
    const hash = digest({ method, params });
    const id = this.key(input.operationId);
    const prior = this.db.record("managementOperation", id);
    if (prior) {
      if (prior.requestHash !== hash)
        throw fail(409, "Operation ID was already used for another change.");
      return prior;
    }
    this.runtime.require(method);
    this.runtime.require("agents.list");
    if (
      method !== "sessions.patch" &&
      !this.gateway.audit.validators.has(
        method === "agents.create" ? "AgentsCreateResultSchema" : "AgentsUpdateResultSchema",
      )
    )
      throw fail(503, "Installed agent mutation response schema is unavailable.");
    if (method === "agents.update" && Object.keys(params).length < 2)
      throw fail(400, "Choose a configuration field to change.");
    if (method === "sessions.patch" && !("model" in params))
      throw fail(400, "Choose a session model or inherit the agent default.");
    const agentId = method === "sessions.patch" ? owner(params.key) : params.agentId;
    const sessionKey = method === "sessions.patch" ? params.key : undefined;
    if (sessionKey && params.agentId !== agentId)
      throw fail(409, "Session belongs to another backend agent.");
    if (this.busyAgent(agentId) || (sessionKey && this.busySession(sessionKey)))
      throw fail(409, "Another configuration change is pending or needs reconciliation.");
    if (method !== "agents.create") this.idle(agentId, sessionKey);
    this.agentLocks.add(agentId ?? id);
    if (sessionKey) this.sessionLocks.add(sessionKey);
    try {
      // Refresh from the backend before comparing the user's reviewed revision.
      await this.runtime.refresh();
      if (!this.runtime.agentsReady)
        throw fail(
          503,
          "Backend agent discovery could not be refreshed; no configuration change was sent.",
        );
      let currentSession;
      if (method === "agents.update") {
        const agent = this.runtime.agents.find((agent) => agent.agentId === agentId);
        if (!agent || input.configRevision !== digest(agent))
          throw fail(409, "Backend agent changed. Refresh and review the current configuration.");
      }
      if (sessionKey) {
        currentSession = await this.session(sessionKey, agentId);
        if (input.configRevision !== currentSession.configRevision)
          throw fail(409, "Backend session changed. Refresh and review again.");
      }
      if (method !== "agents.create") this.idle(agentId, sessionKey);
      if (typeof params.model === "string") {
        const catalog = await this.models(agentId ?? this.runtime.sharedAgentId, sessionKey);
        if (!catalog.models.some((model) => model.id === params.model))
          throw fail(400, "Select a model from the current gateway catalog.");
      }
      const backendParams = { ...params };
      if (currentSession) {
        if (
          currentSession.sessionId &&
          this.gateway.audit.validate(method, {
            ...backendParams,
            expectedSessionId: currentSession.sessionId,
          })
        )
          backendParams.expectedSessionId = currentSession.sessionId;
        if (
          currentSession.lifecycleRevision &&
          this.gateway.audit.validate(method, {
            ...backendParams,
            expectedLifecycleRevision: currentSession.lifecycleRevision,
          })
        )
          backendParams.expectedLifecycleRevision = currentSession.lifecycleRevision;
      }
      if (!this.gateway.audit.validate(method, backendParams))
        throw fail(400, "Configuration does not match the installed gateway schema.");
      let op = this.db.saveRecord(
        "managementOperation",
        id,
        {
          gatewayId: this.runtime.gatewayId,
          operationId: input.operationId,
          requestHash: hash,
          method,
          params: backendParams,
          agentId,
          sessionKey,
          status: "sending",
          createdAt: new Date().toISOString(),
        },
        0,
      );
      try {
        const result = await this.gateway.request(method, backendParams);
        if (this.runtime.closed) return op;
        if (method === "sessions.patch") {
          if (
            result?.ok !== true ||
            result.key !== sessionKey ||
            !result.entry ||
            typeof result.entry !== "object"
          )
            throw new Error("Unverified session patch response");
          const override = result.entry.modelOverride;
          if (
            params.model === null
              ? !!override || !!result.entry.providerOverride
              : !override ||
                !(
                  params.model === override ||
                  params.model === `${result.entry.providerOverride}/${override}`
                )
          )
            throw new Error("Session override was not confirmed");
          this.db.saveRecord("configuration", this.key(`session:${sessionKey}`), {
            gatewayId: this.runtime.gatewayId,
            sessionKey,
            agentId,
            modelOverride: params.model,
            confirmedAt: new Date().toISOString(),
          });
        } else {
          if (
            !this.gateway.audit.validate(
              method === "agents.create" ? "AgentsCreateResultSchema" : "AgentsUpdateResultSchema",
              result,
            ) ||
            (agentId && result.agentId !== agentId)
          )
            throw new Error("Unverified agent mutation response");
          op = this.saveOperation(op, { agentId: result.agentId });
        }
        this.saveOperation(op, { status: "confirmed", error: undefined });
        await this.runtime.refresh();
      } catch (error) {
        if (this.runtime.closed) return op;
        const latest = this.db.record("managementOperation", id);
        if (latest.status !== "confirmed")
          this.saveOperation(latest, {
            status: error.rejected ? "rejected" : "outcome_unknown",
            error: error.rejected
              ? "Gateway rejected this configuration change. Refresh before editing again."
              : "Configuration outcome unknown. The operation will not be resent; refresh backend state before making another change.",
          });
      }
      this.db.publish(this.db.emit("management", this.snapshot()));
      return this.db.record("managementOperation", id);
    } finally {
      this.agentLocks.delete(agentId ?? id);
      if (sessionKey) this.sessionLocks.delete(sessionKey);
      void this.runtime.pump();
    }
  }
}
