import { createHash, randomUUID } from "node:crypto";
import { ACTIVE, TERMINAL } from "./task-db.mjs";
import { ReviewService } from "./reviews.mjs";
import { officeLead } from "./office-lead.mjs";
import { ManagementService } from "./management.mjs";
import { VoiceService } from "./voice.mjs";
import { HmemMemory } from "./hmem-memory.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 256) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
export const sessionAgent = (key) => /^agent:([a-zA-Z0-9_-]+):[^\s]+$/.exec(key)?.[1];
const messageText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("")
      : undefined;

/** Commands and reconciliation are shared by HTTP, voice-triggered work and restart recovery. */
export class TaskRuntime {
  constructor({ db, gateway, gatewayId, sharedAgentId = "main" }) {
    this.db = db;
    this.gateway = gateway;
    this.gatewayId = gatewayId;
    this.sharedAgentId = sharedAgentId;
    this.agents = [];
    this.metricsBySession = new Map();
    this.metricsTimer = null;
    this.agentsReady = false;
    this.pumping = false;
    this.closed = false;
    this.roleLocks = new Set();
    this.roleHashes = new Map();
    this.reconciling = null;
    this.afterRefresh = new Set();
    // Secondary runtimes whose reviewed seats appear in this office beside this runtime's own.
    this.peers = [];
    // The seat that fronts the Team Lead (Alice by default); see office-lead.mjs.
    this.officeLeadSeatId = null;
    this.reviews = new ReviewService(this);
    this.management = new ManagementService(this);
    this.memory = new HmemMemory(db);
    this.voice = new VoiceService(this);
    this.unsubscribe = gateway.subscribe((kind, data) => {
      if (kind === "event") this.receive(data);
      if (kind === "status") {
        if (data !== "connected") {
          this.markUnknown();
          this.reviews.disconnected();
        }
        db.publish({ seq: db.cursor(), kind: "connection", data: this.connection() });
        if (data === "connected") void this.refresh().catch(() => {});
      }
    });
    this.markUnknown();
  }
  connection() {
    return {
      connection: this.gateway.status,
      capabilities: this.gateway.capabilities(),
      memoryRecall: this.memory.embedder?.verified
        ? "semantic"
        : this.memory.embedder
          ? `lexical (${this.memory.embedder.status})`
          : "lexical",
      ...(this.gateway.provider === "nightshift"
        ? {
            provider: "nightshift",
            model: this.gateway.model,
            providerReason: this.gateway.lastError,
          }
        : {}),
    };
  }
  require(method) {
    const cap = this.gateway.capabilities()[method];
    if (!cap?.available) throw fail(503, cap?.reason ?? "Unsupported capability");
  }
  markUnknown() {
    this.agentsReady = false;
    for (const task of this.db.activeTasks()) {
      if (
        task.gatewayId === this.gatewayId &&
        ACTIVE.includes(task.status) &&
        task.status !== "outcome_unknown"
      )
        this.db.updateTask(task.taskId, {
          status: "outcome_unknown",
          error: "Outcome unknown. Waiting for verified backend evidence.",
        });
    }
  }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async doRefresh() {
    this.agentsReady = false;
    try {
      this.require("agents.list");
      const result = await this.gateway.request("agents.list", {});
      if (this.closed) return;
      if (
        !Array.isArray(result?.agents) ||
        (this.gateway.audit.validators.has("AgentsListResultSchema") &&
          !this.gateway.audit.validate("AgentsListResultSchema", result))
      )
        throw new Error("Invalid agent list response");
      this.agents = result.agents
        .filter((agent) => agent.kind !== "system" && agent.status !== "degraded")
        .map((agent) => ({
          agentId: agent.id ?? agent.agentId,
          name: agent.name,
          identity: agent.identity,
          model: typeof agent.model === "string" ? agent.model : agent.model?.primary,
          workspace: agent.workspace,
        }))
        .filter((agent) => text(agent.agentId));
      this.agentsReady = true;
    } catch {
      this.agents = [];
    }
    this.db.publish({ seq: this.db.cursor(), kind: "connection", data: this.connection() });
    if (this.gateway.capabilities()["sessions.list"]?.available) {
      try {
        const listed = await this.gateway.request("sessions.list", {});
        if (this.closed) return;
        this.management.captureSessions(listed.sessions);
        for (const session of listed.sessions ?? []) {
          this.captureMetrics(session);
          const owner = sessionAgent(session.key);
          if (owner && this.agents.some((agent) => agent.agentId === owner))
            this.db.saveSession(
              {
                key: session.key,
                label: session.label ?? session.displayName,
                createdAt: Number.isFinite(session.updatedAt)
                  ? new Date(session.updatedAt).toISOString()
                  : new Date().toISOString(),
              },
              owner,
            );
        }
      } catch {
        /* Local session records remain available during backend history failures. */
      }
    }
    if (this.closed) return;
    this.management.captureAgents();
    await this.reviews.recover();
    await this.reconcile();
    for (const callback of this.afterRefresh) await callback();
    void this.pump();
  }
  seatView(seat) {
    const available =
      this.agentsReady && this.agents.some((agent) => agent.agentId === seat.binding?.agentId);
    return {
      ...seat,
      agentConfig:
        seat.seatType === "agent"
          ? (this.agents.find((agent) => agent.agentId === seat.binding?.agentId) ??
            seat.agentConfig)
          : undefined,
      binding: {
        ...seat.binding,
        available,
        reason: available ? undefined : "The bound agent is not verified on the connected gateway.",
      },
    };
  }
  /** The runtime whose reviewed binding holds this seat; a peer's assigned seat wins. */
  seatOwner(seatId) {
    return this.peers.find((peer) => peer.db.getSeat(seatId)?.assigned) ?? this;
  }
  /** The runtime that ran a task, by its recorded gateway. */
  taskOwner(task) {
    return this.peers.find((peer) => peer.gatewayId === task?.gatewayId) ?? this;
  }
  /** The runtime whose assigned seat is bound to this session's agent. */
  sessionOwner(sessionKey) {
    const agentId = /^agent:([^:]+):/.exec(sessionKey ?? "")?.[1];
    const bound = (runtime) =>
      runtime.db.seats().some((seat) => seat.assigned && seat.binding?.agentId === agentId);
    // This runtime's own agents (such as a shared "main") always stay here.
    if (!agentId || bound(this)) return this;
    return this.peers.find(bound) ?? this;
  }
  /** One office roster: this runtime's seats with peer-held seats overlaid by seat ID. */
  rosterSeats() {
    const seats = new Map(this.db.seats().map((seat) => [seat.seatId, this.seatView(seat)]));
    for (const peer of this.peers)
      for (const seat of peer.db.seats())
        if (seat.assigned)
          seats.set(seat.seatId, { ...peer.seatView(seat), runtime: peer.gateway.provider });
    return [...seats.values()];
  }
  captureMetrics(session) {
    const metrics = {
      fresh: session.totalTokensFresh === true,
      usedTokens: session.totalTokens,
      maxContextTokens: session.contextTokens,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      model: typeof session.model === "string" ? session.model : undefined,
      provider: session.modelProvider,
    };
    this.metricsBySession.set(session.key, metrics);
    this.db.publish({ kind: "metrics", data: { sessionKey: session.key, metrics } });
  }
  refreshMetrics() {
    clearTimeout(this.metricsTimer);
    this.metricsTimer = setTimeout(async () => {
      try {
        if (this.closed || !this.gateway.capabilities()["sessions.list"]?.available) return;
        const listed = await this.gateway.request("sessions.list", {});
        for (const session of listed.sessions ?? []) this.captureMetrics(session);
      } catch {
        /* stale metrics never determine task outcomes */
      }
    }, 400);
    this.metricsTimer.unref();
  }
  snapshot() {
    const tasks = [
      ...new Map(
        [...this.db.activeTasks(), ...this.db.listTasks()].map((task) => [task.taskId, task]),
      ).values(),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      ...this.connection(),
      cursor: this.db.cursor(),
      tasks,
      seats: this.rosterSeats(),
      sessions: this.db.sessions(),
      agents: this.agents,
      sharedAgentId: this.sharedAgentId,
      officeLead: officeLead(this),
      reviews: this.reviews.snapshot(),
      reviewRecovery: this.reviews.recovery,
      management: this.management.snapshot(),
      voice: this.voice.snapshot(),
      audit: this.gateway.audit.report(),
    };
  }
  saveSeat(input) {
    if (
      !text(input.seatId) ||
      !text(input.label, 80) ||
      !["worker", "agent"].includes(input.seatType)
    )
      throw fail(400, "Invalid seat configuration");
    if (
      this.db.activeTasks().some((task) => task.seatId === input.seatId) ||
      this.roleLocks.has(input.seatId)
    )
      throw fail(409, "Finish or reconcile this seat's tasks before changing its binding.");
    if (this.seatOwner(input.seatId) !== this)
      throw fail(409, "This seat is held by another runtime's reviewed agent.");
    const existing = this.db.getSeat(input.seatId);
    if (existing && this.management.busyAgent(existing.binding?.agentId))
      throw fail(409, "The currently bound backend agent has an unresolved configuration change.");
    if (existing && input.revision !== existing.binding.revision)
      throw fail(409, "Seat binding changed. Refresh and try again.");
    const agentId = input.seatType === "agent" ? input.agentConfig?.agentId : this.sharedAgentId;
    if (this.management.busyAgent(agentId))
      throw fail(409, "Backend agent configuration is being changed or requires reconciliation.");
    if (input.seatType === "agent" && agentId === this.sharedAgentId)
      throw fail(409, "The shared backend agent must use a Worker seat.");
    if (
      input.spritePath !== undefined &&
      (typeof input.spritePath !== "string" ||
        !/^\/characters\/[a-zA-Z0-9_.-]+\.png$/.test(input.spritePath))
    )
      throw fail(400, "Invalid character portrait");
    if (
      input.assigned &&
      (!this.agentsReady || !this.agents.some((agent) => agent.agentId === agentId))
    )
      throw fail(409, "Select an agent verified by gateway discovery.");
    if (
      input.seatType === "agent" &&
      this.db
        .seats()
        .some(
          (seat) =>
            seat.seatId !== input.seatId &&
            seat.assigned &&
            seat.seatType === "agent" &&
            seat.binding.agentId === agentId,
        )
    )
      throw fail(409, "This independent agent is already bound to a seat.");
    const seat = {
      seatId: input.seatId,
      label: input.label,
      seatType: input.seatType,
      assigned: !!input.assigned,
      roleTitle: typeof input.roleTitle === "string" ? input.roleTitle.slice(0, 160) : "",
      spriteKey: input.spriteKey,
      spritePath: input.spritePath,
      agentConfig:
        input.seatType === "agent"
          ? this.agents.find((agent) => agent.agentId === agentId)
          : undefined,
      binding: {
        seatId: input.seatId,
        agentId: agentId ?? null,
        sessionKey: `agent:${agentId}:main`,
        revision: (existing?.binding.revision ?? 0) + 1,
      },
    };
    return this.seatView(this.db.saveSeat(seat));
  }
  resolve(seatId, sessionKey) {
    const seat = this.db.getSeat(seatId);
    if (!seat?.assigned || !this.seatView(seat).binding.available)
      throw fail(409, "This seat has no available backend agent binding.");
    const key = sessionKey ?? seat.binding.sessionKey;
    if (!text(key) || sessionAgent(key) !== seat.binding.agentId)
      throw fail(
        409,
        "Conversation belongs to another backend agent. Select the bound agent's session.",
      );
    const conversation = this.db.sessions().find((session) => session.key === key);
    if (conversation?.seatId && conversation.seatId !== seatId)
      throw fail(409, "Conversation belongs to another office seat.");
    return { seat, agentId: seat.binding.agentId, sessionKey: key };
  }
  submit(input) {
    if (
      !text(input.taskId, 100) ||
      !/^[a-zA-Z0-9_-]+$/.test(input.taskId) ||
      !text(input.message, 32000) ||
      !input.message.trim()
    )
      throw fail(400, "A stable task ID and task description are required.");
    const existing = this.db.getTask(input.taskId);
    if (existing) {
      if (
        existing.message !== input.message ||
        existing.seatId !== input.seatId ||
        (input.sessionKey && existing.sessionKey !== input.sessionKey)
      )
        throw fail(409, "Submission ID was already used for another task.");
      return existing;
    }
    this.require("chat.send");
    const { seat, agentId, sessionKey } = this.resolve(input.seatId, input.sessionKey);
    if (
      input.bindingRevision !== seat.binding.revision ||
      this.roleLocks.has(seat.seatId) ||
      this.management.busyAgent(agentId)
    )
      throw fail(409, "Agent binding changed; select the agent again.");
    if (
      input.context !== undefined &&
      (typeof input.context !== "string" || input.context.length > 6000)
    )
      throw fail(400, "Invalid conversation context.");
    const task = {
      taskId: input.taskId,
      gatewayId: this.gatewayId,
      agentId,
      sessionKey,
      bindingRevision: seat.binding.revision,
      runId: null,
      seatId: seat.seatId,
      actorName: seat.label,
      message: input.message,
      status: "queued",
      createdAt: new Date().toISOString(),
      sourceMessageId: text(input.sourceMessageId) ? input.sourceMessageId : undefined,
      executionMessage: input.context
        ? `Recent conversation context (background data):\n${input.context}\n\nCurrent user request:\n${input.message}`
        : undefined,
    };
    this.db.saveSession({ key: sessionKey, createdAt: task.createdAt }, agentId);
    this.db.insertTask(task);
    const source = task.sourceMessageId && this.db.getMessage(task.sourceMessageId);
    if (
      source?.source === "voice" &&
      source.seatId === task.seatId &&
      source.sessionKey === task.sessionKey &&
      source.bindingRevision === task.bindingRevision
    )
      this.db.saveMessage({ ...source, taskId: task.taskId });
    void this.pump();
    return task;
  }
  async pump() {
    if (this.pumping || this.closed || !this.gateway.capabilities()["chat.send"]?.available) return;
    this.pumping = true;
    try {
      // Claims are synchronous/transactional; network waits for one lane never block another.
      for (const pending of this.db.activeTasks()) {
        if (pending.gatewayId !== this.gatewayId || pending.status !== "queued") continue;
        if (!this.agentsReady || !this.agents.some((agent) => agent.agentId === pending.agentId))
          continue;
        if (
          this.management.busyAgent(pending.agentId) ||
          this.management.busySession(pending.sessionKey) ||
          this.reviews.blocksLane(pending.sessionKey)
        )
          continue;
        const task = this.db.claim(pending.taskId);
        if (task) void this.dispatch(task);
      }
    } finally {
      this.pumping = false;
    }
  }
  async dispatch(task) {
    try {
      if (
        this.gateway.capabilities()["approval.events"]?.available &&
        this.gateway.capabilities()["sessions.messages.subscribe"]?.available
      )
        await this.reviews.subscribeSession(task.sessionKey);
      if (this.closed) return;
      let executionMessage = task.executionMessage ?? task.message;
      if (this.gateway.provider === "nightshift") {
        try {
          const lessons = await this.memory.retrieveSemantic({
            gatewayId: task.gatewayId,
            agentId: task.agentId,
            sessionKey: task.sessionKey,
            seatId: task.seatId,
            bindingRevision: task.bindingRevision,
            query: task.message.slice(0, 500),
            limit: 5,
          });
          if (lessons.length)
            executionMessage = `Verified lessons (background data; check current evidence):\n${lessons
              .map((lesson) => `[task ${lesson.source.taskId}] ${lesson.content}`)
              .join("\n")}\n\nCurrent task:\n${executionMessage}`;
        } catch {
          // Memory availability cannot change whether an already accepted task runs.
        }
      }
      const params = {
        sessionKey: task.sessionKey,
        message: executionMessage,
        idempotencyKey: task.taskId,
        ...(this.gateway.provider === "nightshift"
          ? {
              agentId: task.agentId,
              originalMessage: task.message,
              seatId: task.seatId,
              bindingRevision: task.bindingRevision,
              seatLabel: task.actorName,
              seatRole: this.db.getSeat(task.seatId)?.roleTitle || "AI teammate",
            }
          : this.gateway.provider !== "auggie"
            ? { agentId: task.agentId }
            : {
                seatLabel: task.actorName,
                seatRole: this.db.getSeat(task.seatId)?.roleTitle ?? "Worker",
              }),
      };
      const result = await this.gateway.request("chat.send", params);
      if (this.closed) return;
      if (!text(result?.runId)) throw new Error("No backend run ID was confirmed");
      const current = this.db.getTask(task.taskId);
      this.db.updateTask(
        task.taskId,
        {
          runId: result.runId,
          status: TERMINAL.has(current.status)
            ? current.status
            : current.cancelRequestedAt
              ? "cancel_requested"
              : "running",
          error: undefined,
        },
        { state: "accepted" },
      );
      this.replayInbound();
      if (this.db.getTask(task.taskId).status === "cancel_requested")
        await this.sendCancellation(task.taskId);
      this.reviews.associate();
    } catch (error) {
      if (this.closed) return;
      this.db.updateTask(
        task.taskId,
        {
          status: error.rejected ? "failed" : "outcome_unknown",
          error: error.rejected
            ? "Gateway rejected task submission."
            : "Outcome unknown. The request may have reached the gateway; it will not be resent.",
          ...(error.rejected ? { completedAt: new Date().toISOString() } : {}),
        },
        { state: error.rejected ? "rejected" : "uncertain" },
      );
      void this.pump();
    }
  }
  receive(frame, storedId) {
    if (this.closed) return;
    this.reviews.receive(frame);
    const payload = frame.payload;
    if (!["chat", "agent"].includes(frame.event) || !payload || !text(payload.runId)) return;
    const schema = frame.event === "chat" ? "ChatEventSchema" : "AgentEventSchema";
    if (!this.gateway.audit.validate(schema, payload)) return;
    const task = this.db
      .activeTasks()
      .find(
        (task) =>
          task.gatewayId === this.gatewayId &&
          task.runId === payload.runId &&
          (!payload.agentId || payload.agentId === task.agentId) &&
          (!payload.sessionKey || payload.sessionKey === task.sessionKey),
      );
    if (!task) {
      const pending = this.db
        .activeTasks()
        .some(
          (candidate) =>
            candidate.gatewayId === this.gatewayId &&
            !candidate.runId &&
            ACTIVE.includes(candidate.status) &&
            (!payload.sessionKey || candidate.sessionKey === payload.sessionKey),
        );
      if (!storedId && pending)
        this.db.saveInbound(
          createHash("sha256").update(JSON.stringify(frame)).digest("hex"),
          frame,
        );
      return;
    }
    let status;
    let result;
    if (frame.event === "chat") {
      status = payload.yielded
        ? undefined
        : { final: "completed", error: "failed", aborted: "stopped", uncertain: "outcome_unknown" }[
            payload.state
          ];
      result = messageText(payload.message?.content);
      const previous = this.db.getMessage(`assistant_${task.taskId}`);
      if (Number.isInteger(payload.seq) && previous?.backendSeq >= payload.seq) {
        if (storedId) this.db.deleteInbound(storedId);
        return;
      }
      if (payload.state === "delta" && typeof payload.deltaText === "string")
        result = payload.replace
          ? payload.deltaText
          : (previous?.content ?? "") + payload.deltaText;
      if (typeof result === "string")
        this.db.saveMessage({
          id: `assistant_${task.taskId}`,
          taskId: task.taskId,
          runId: payload.runId,
          sessionKey: task.sessionKey,
          seatId: task.seatId,
          actorName: task.actorName,
          role: "assistant",
          content: result,
          timestamp: previous?.timestamp ?? new Date().toISOString(),
          streaming: !status,
          backendSeq: payload.seq,
        });
    } else if (payload.stream === "lifecycle") {
      // Lifecycle end alone is insufficient: chat final or recovery confirms the outcome.
      if (payload.data?.phase === "error") status = "failed";
      if (payload.data?.phase === "start" && task.status === "outcome_unknown")
        this.db.updateTask(task.taskId, {
          status: task.cancelRequestedAt ? "cancel_requested" : "running",
          error: undefined,
        });
    } else if (payload.stream === "tool") {
      const name = payload.data?.name ?? payload.data?.tool;
      const format = (value) =>
        value === undefined
          ? undefined
          : (typeof value === "string" ? value : JSON.stringify(value)).slice(0, 8000);
      if (typeof name === "string")
        this.db.saveMessage({
          id: `tool_${task.taskId}_${payload.seq}`,
          taskId: task.taskId,
          runId: task.runId,
          role: "tool",
          toolName: name.slice(0, 200),
          content: name.slice(0, 200),
          toolInput: format(payload.data.input ?? payload.data.arguments),
          toolOutput: format(payload.data.output ?? payload.data.result),
          timestamp: new Date().toISOString(),
          sessionKey: task.sessionKey,
          seatId: task.seatId,
          actorName: task.actorName,
        });
    }
    if (status) {
      this.db.updateTask(
        task.taskId,
        {
          status,
          result: result ?? task.result,
          completedAt: status === "outcome_unknown" ? undefined : new Date().toISOString(),
          error:
            status === "outcome_unknown"
              ? "Nightshift outcome unknown. Review backend evidence before retrying."
              : undefined,
        },
        { state: status === "outcome_unknown" ? "uncertain" : "terminal" },
      );
      void this.pump();
      this.refreshMetrics();
    }
    if (storedId) this.db.deleteInbound(storedId);
  }
  replayInbound() {
    for (const item of this.db.inbound()) this.receive(item.frame, item.id);
  }
  async reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }
  async doReconcile() {
    this.replayInbound();
    await Promise.all(
      this.db
        .activeTasks()
        .filter((task) => task.gatewayId === this.gatewayId && task.status !== "queued")
        .map(async (task) => {
          try {
            if (
              task.runId &&
              this.db.ledger(task.taskId)?.state !== "imported" &&
              this.gateway.capabilities()["agent.wait"]?.available
            ) {
              const outcome = await this.gateway.request("agent.wait", {
                runId: task.runId,
                timeoutMs: 1,
              });
              if (
                outcome?.runId === task.runId &&
                ["ok", "error", "aborted"].includes(outcome.status)
              ) {
                this.db.updateTask(
                  task.taskId,
                  {
                    status:
                      outcome.status === "ok"
                        ? "completed"
                        : outcome.status === "aborted"
                          ? "stopped"
                          : "failed",
                    completedAt: new Date().toISOString(),
                    error: undefined,
                  },
                  { state: "terminal" },
                );
                return;
              }
            }
            // History can prove that a specific run is in flight, never that silence is success.
            if (task.runId && this.gateway.capabilities()["chat.history"]?.available) {
              const history = await this.gateway.request("chat.history", {
                sessionKey: task.sessionKey,
                limit: 100,
              });
              if (
                history?.inFlightRun?.runId === task.runId ||
                history?.sessionInfo?.activeRunIds?.includes(task.runId)
              ) {
                this.db.updateTask(task.taskId, {
                  status: task.cancelRequestedAt ? "cancel_requested" : "running",
                  error: undefined,
                });
                return;
              }
            }
          } catch {
            /* preserve uncertainty */
          }
          const latest = this.db.getTask(task.taskId);
          if (!TERMINAL.has(latest.status))
            this.db.updateTask(task.taskId, {
              status: "outcome_unknown",
              error:
                "Outcome unknown. No conclusive backend evidence is available; this session is held.",
            });
        }),
    );
    void this.pump();
  }
  /** @param {string} id @param {{retry?: boolean, expectedAttempt?: number}} options */
  async cancel(id, { retry = false, expectedAttempt } = {}) {
    const task = this.db.getTask(id);
    if (!task || task.gatewayId !== this.gatewayId) throw fail(404, "Task not found");
    if (TERMINAL.has(task.status)) return task;
    if (task.status === "queued" && this.db.ledger(id)?.state === "pending") {
      const stopped = this.db.updateTask(
        id,
        { status: "stopped", completedAt: new Date().toISOString() },
        { state: "cancelled" },
      );
      void this.pump();
      return stopped;
    }
    // The durable attempt is shared by tabs and survives server restarts. Ambiguous
    // sends are reconciled, never retried automatically.
    if (task.cancelRequestedAt) {
      if (!retry) return task;
      if (task.cancelState !== "rejected" || expectedAttempt !== task.cancelAttempt)
        throw fail(409, "Cancellation changed or remains uncertain. Reconcile before retrying.");
    }
    this.require("chat.abort");
    this.db.updateTask(id, {
      status: "cancel_requested",
      cancelRequestedAt: task.cancelRequestedAt ?? new Date().toISOString(),
      cancelAttempt: (task.cancelAttempt ?? 0) + 1,
      cancelState: "awaiting_run",
      cancellationError: undefined,
    });
    if (!task.runId) return this.db.getTask(id);
    return this.sendCancellation(id);
  }
  async sendCancellation(id) {
    const task = this.db.getTask(id);
    if (!task || TERMINAL.has(task.status) || !task.runId || task.cancelState !== "awaiting_run")
      return task;
    this.db.updateTask(id, { cancelState: "sending" });
    try {
      await this.gateway.request("chat.abort", {
        sessionKey: task.sessionKey,
        runId: task.runId,
        ...(this.gateway.provider !== "auggie" ? { agentId: task.agentId } : {}),
      });
      // An RPC acknowledgement is not a terminal execution event.
      if (!this.closed) {
        const latest = this.db.getTask(id);
        if (!TERMINAL.has(latest.status))
          this.db.updateTask(id, {
            cancelState: "acknowledged",
            status: this.gateway.status === "connected" ? "cancel_requested" : "outcome_unknown",
          });
      }
    } catch (error) {
      if (this.closed) return;
      const latest = this.db.getTask(id);
      if (TERMINAL.has(latest.status)) return latest;
      this.db.updateTask(id, {
        status:
          error.rejected && latest.status !== "outcome_unknown" ? "running" : "outcome_unknown",
        cancelState: error.rejected ? "rejected" : "outcome_unknown",
        cancellationError: error.rejected
          ? "Gateway rejected cancellation. Execution may still be running."
          : "Cancellation outcome unknown. The session remains held; check the backend again.",
      });
    }
    return this.db.getTask(id);
  }
  async history(key) {
    if (!text(key) || !sessionAgent(key)) throw fail(400, "Invalid session key");
    let messages = [];
    let limited = false;
    if (this.gateway.capabilities()["chat.history"]?.available) {
      const data = await this.gateway.request("chat.history", { sessionKey: key, limit: 100 });
      if (!Array.isArray(data?.messages)) throw fail(502, "Incompatible history response");
      messages = data.messages
        .filter((message) => ["user", "assistant", "system"].includes(message.role))
        .map((message, i) => ({
          id: message.id ?? `history_${key}_${i}`,
          runId: typeof message.runId === "string" ? message.runId : "",
          role: message.role,
          content: messageText(message.content) ?? "",
          sessionKey: key,
          timestamp:
            typeof message.timestamp === "string"
              ? message.timestamp
              : new Date(Number(message.timestamp) || Date.now()).toISOString(),
        }));
      limited = true;
    } else if (this.gateway.capabilities()["sessions.preview"]?.available) {
      const data = await this.gateway.request("sessions.preview", {
        keys: [key],
        limit: 50,
        maxChars: 2000,
      });
      const entry = data?.previews?.find((entry) => entry.key === key);
      messages = (entry?.items ?? []).map((message, i) => ({
        id: `preview_${key}_${i}`,
        runId: "",
        role: ["user", "assistant", "system"].includes(message.role) ? message.role : "system",
        content: message.text,
        timestamp: new Date().toISOString(),
        sessionKey: key,
      }));
      limited = true;
    }
    const local = this.db.messages(key);
    const ownTasks = this.db.tasksForSession(key);
    const matched = new Set();
    messages = messages.map((message) => {
      if (message.role !== "user" || !message.content) return message;
      const task = ownTasks.find(
        (task) =>
          !matched.has(task.taskId) &&
          (task.runId === message.runId ||
            (task.executionMessage ?? task.message) === message.content),
      );
      if (!task) return message;
      matched.add(task.taskId);
      return {
        ...message,
        content: task.message,
        taskId: task.taskId,
        seatId: task.seatId,
        ...(task.sourceMessageId ? { id: task.sourceMessageId, source: "voice" } : {}),
      };
    });
    const localRuns = new Set(local.map((message) => message.runId).filter(Boolean));
    const visible = messages.filter(
      (message) =>
        !localRuns.has(message.runId) &&
        !local.some((own) => own.id === message.id) &&
        !local.some((own) => own.role === message.role && own.content === message.content),
    );
    return {
      messages: [...visible, ...local],
      metrics: this.metricsBySession.get(key) ?? { fresh: false },
      limited,
      reason: limited
        ? "History is a limited backend window; earlier messages may be omitted."
        : "Showing server-saved task messages.",
    };
  }
  async applyRole(seatId, revision, expectedHash) {
    this.require("roleApply");
    this.require("agents.files.get");
    this.require("agents.files.set");
    const seat = this.db.getSeat(seatId);
    if (!seat || seat.seatType !== "agent" || seat.binding.revision !== revision)
      throw fail(409, "Independent agent binding changed.");
    if (this.management.busyAgent(seat.binding.agentId))
      throw fail(409, "Backend configuration requires reconciliation.");
    if (this.db.activeTasks().some((task) => task.seatId === seatId) || this.roleLocks.has(seatId))
      throw fail(409, "This agent has outstanding work.");
    this.roleLocks.add(seatId);
    try {
      const current = await this.gateway.request("agents.files.get", {
        agentId: seat.binding.agentId,
        name: "SOUL.md",
      });
      const content = current?.file?.content;
      if (typeof content !== "string")
        throw fail(502, "Gateway did not return readable role instructions.");
      const hash = current.file.hash ?? createHash("sha256").update(content).digest("hex");
      const marker = /\n?<!-- agent-town-role:start -->[\s\S]*?<!-- agent-town-role:end -->\n?/g;
      const updated = `${content.replace(marker, "").trimEnd()}\n\n<!-- agent-town-role:start -->\nRole: ${seat.roleTitle}\n<!-- agent-town-role:end -->\n`;
      if (!expectedHash) return { hash, current: content, proposed: updated, revision };
      if (expectedHash !== hash)
        throw fail(409, "Backend instructions changed. Review the new preview.");
      await this.gateway.request("agents.files.set", {
        agentId: seat.binding.agentId,
        name: "SOUL.md",
        content: updated,
        expectedHash: hash,
      });
      return { applied: true };
    } finally {
      this.roleLocks.delete(seatId);
    }
  }
  /** @param {{id: string, tasks?: Array<Record<string, any>>, seats?: Array<Record<string, any>>}} input */
  importLegacy({ id, tasks = [], seats = [] }) {
    if (
      !text(id, 100) ||
      !Array.isArray(tasks) ||
      !Array.isArray(seats) ||
      tasks.length > 200 ||
      seats.length > 64
    )
      throw fail(400, "Invalid legacy import");
    const importId = `${this.gatewayId}:${id}`;
    if (this.db.hasImport(importId)) return { imported: false };
    // Records are archived, never inserted into the dispatch queue.
    for (const old of tasks) {
      if (
        !text(old.taskId, 100) ||
        !text(old.message, 32000) ||
        !text(old.sessionKey) ||
        this.db.getTask(old.taskId)
      )
        continue;
      this.db.insertTask(
        {
          taskId: old.taskId,
          message: old.message,
          sessionKey: old.sessionKey,
          agentId: sessionAgent(old.sessionKey) ?? null,
          bindingRevision: 0,
          runId: typeof old.runId === "string" && old.runId !== old.taskId ? old.runId : null,
          gatewayId: this.gatewayId,
          status: TERMINAL.has(old.status) ? old.status : "outcome_unknown",
          seatId: old.seatId,
          actorName: old.actorName,
          createdAt: Number.isFinite(Date.parse(old.createdAt))
            ? old.createdAt
            : new Date().toISOString(),
          result: old.result,
          error: "Imported record. Remote execution and identity require reconciliation.",
        },
        { imported: true },
      );
    }
    for (const seat of seats) {
      if (this.db.getSeat(seat.seatId) || !text(seat.seatId) || !text(seat.label, 80)) continue;
      const candidate = seat.seatType === "agent" ? seat.agentConfig?.agentId : this.sharedAgentId;
      const verified = this.agentsReady && this.agents.some((agent) => agent.agentId === candidate);
      this.db.saveSeat({
        ...seat,
        binding: {
          seatId: seat.seatId,
          agentId: verified ? candidate : null,
          sessionKey: verified ? `agent:${candidate}:main` : null,
          revision: verified ? 1 : 0,
        },
      });
    }
    this.db.finishImport(importId);
    return { imported: true };
  }
  bootstrapSeats(seats) {
    if (!Array.isArray(seats) || seats.length > 64) throw fail(400, "Invalid initial seats");
    if (!this.agentsReady) throw fail(503, "Gateway agent discovery is not ready.");
    for (const seat of seats) {
      if (this.db.getSeat(seat.seatId)) continue;
      this.saveSeat({ ...seat, seatType: "worker", agentConfig: undefined, revision: 0 });
    }
    return { seats: this.db.seats().map((seat) => this.seatView(seat)) };
  }
  newSession(seatId) {
    const { agentId } = this.resolve(seatId);
    const record = {
      key: `agent:${agentId}:${randomUUID()}`,
      seatId,
      agentId,
      createdAt: new Date().toISOString(),
    };
    this.db.saveSession(record, agentId);
    void this.reviews.subscribeSession(record.key);
    return record;
  }
  close() {
    this.closed = true;
    clearTimeout(this.metricsTimer);
    this.reviews.close();
    this.unsubscribe();
    this.gateway.stop();
  }
}
