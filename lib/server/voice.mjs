import { createHash, randomUUID } from "node:crypto";
import { retrieveAgentContext } from "./context-retrieval.mjs";
import {
  VOICE_MODEL,
  VOICE_API_VERSION,
  VOICE_BILLING_NOTICE,
  sanitizeDiagnostic,
  sanitizeUsage,
} from "../voice/diagnostics.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const validText = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export class VoiceService {
  constructor(runtime) {
    this.runtime = runtime;
  }

  tasksForContext(context) {
    return this.runtime.db
      .tasksForSession(context.sessionKey)
      .filter(
        (task) =>
          task.gatewayId === this.runtime.gatewayId &&
          task.agentId === context.agentId &&
          task.seatId === context.seatId &&
          task.bindingRevision === context.bindingRevision,
      );
  }

  /** Voice for a seat or call held by a peer runtime goes to that runtime's voice manager. */
  peer({ seatId, callId } = {}) {
    for (const peer of this.runtime.peers ?? [])
      if (
        (typeof callId === "string" && peer.db.record("voiceCall", callId)) ||
        (typeof seatId === "string" && peer.db.getSeat(seatId)?.assigned)
      )
        return peer.voice;
    return null;
  }

  retrieveContext(input) {
    const peer = this.peer(input ?? {});
    if (peer) return peer.retrieveContext(input);
    return retrieveAgentContext(this, input);
  }

  async action(input) {
    const peer = this.peer({ callId: input?.callId });
    if (peer) return peer.action(input);
    const allowed = [
      "assign_task",
      "get_agent_context",
      "get_task_progress",
      "cancel_task",
      "open_pending_review",
    ];
    if (
      !input ||
      !allowed.includes(input.tool) ||
      !validText(input.callId, 100) ||
      !validText(input.actionId, 200) ||
      !input.args ||
      typeof input.args !== "object" ||
      Array.isArray(input.args)
    )
      throw fail(
        400,
        "Unsupported or invalid voice action. Review decisions require explicit user action.",
      );
    const runtime = this.runtime;
    const call = runtime.db.record("voiceCall", input.callId);
    if (!call || call.gatewayId !== runtime.gatewayId) throw fail(404, "Voice call not found.");
    if (call.endedAt) throw fail(409, "Voice call has ended. No action was taken.");
    const seat = runtime.db.getSeat(call.seatId);
    if (
      !seat?.assigned ||
      seat.binding?.revision !== call.bindingRevision ||
      seat.binding?.agentId !== call.agentId
    )
      throw fail(409, "Agent binding changed; select the agent again.");
    const ownsTask = (task) =>
      task &&
      task.gatewayId === call.gatewayId &&
      task.agentId === call.agentId &&
      task.seatId === call.seatId &&
      task.sessionKey === call.sessionKey &&
      task.bindingRevision === call.bindingRevision;
    const view = (task) => ({
      taskId: task.taskId,
      message: task.message.slice(0, 1200),
      status: task.status,
      result: task.result?.slice(0, 2500),
      error: task.error?.slice(0, 1000),
      cancelState: task.cancelState,
      cancellationError: task.cancellationError,
    });
    if (input.tool === "get_agent_context")
      return {
        agent: await this.retrieveContext({
          ...call,
          ...(typeof input.args.query === "string" && input.args.query.length <= 500
            ? { query: input.args.query }
            : {}),
        }),
      };
    if (["get_task_progress", "cancel_task"].includes(input.tool)) {
      if (!validText(input.args.taskId, 100)) throw fail(400, "Choose a recorded task ID first.");
      const task = runtime.db.getTask(input.args.taskId);
      if (!ownsTask(task)) throw fail(404, "Task not found in this call's seat and session.");
      if (input.tool === "get_task_progress") return { task: view(task) };
      // The durable cancellation ledger handles duplicates and uncertain outcomes.
      // Speech cannot retry a rejected or ambiguous cancellation automatically.
      const cancelled = await runtime.cancel(task.taskId);
      return {
        task: view(cancelled),
        note: ["completed", "failed", "stopped", "interrupted"].includes(cancelled.status)
          ? `Task is recorded as ${cancelled.status}.`
          : "Cancellation was checked or requested. Only a terminal task status confirms execution has ended.",
      };
    }
    if (input.tool === "open_pending_review") {
      const review = runtime.reviews
        .snapshot()
        .find(
          (item) =>
            item.status === "pending" &&
            item.sessionKey === call.sessionKey &&
            item.agentId === call.agentId &&
            (!item.taskId || ownsTask(runtime.db.getTask(item.taskId))),
        );
      if (!review) throw fail(404, "No pending review recorded for this conversation.");
      return {
        reviewId: review.id,
        note: "User must review and respond explicitly in the dialog. No decision has been submitted.",
      };
    }
    const message = typeof input.args.message === "string" ? input.args.message.trim() : "";
    if (!validText(message, 8000))
      throw fail(400, "A task description of up to 8000 characters is required.");
    if (input.sourceMessageId !== undefined && !validText(input.sourceMessageId, 200))
      throw fail(400, "Invalid source transcript ID.");
    const source = input.sourceMessageId && runtime.db.getMessage(input.sourceMessageId);
    if (
      source &&
      (source.source !== "voice" ||
        source.runId !== call.id ||
        source.role !== "user" ||
        source.seatId !== call.seatId ||
        source.sessionKey !== call.sessionKey ||
        source.bindingRevision !== call.bindingRevision)
    )
      throw fail(409, "Source transcript belongs to another conversation.");
    // Stable IDs survive HTTP retries and runtime restarts. One spoken turn cannot
    // enqueue the same request twice through repeated model tool calls.
    const normalized = message.toLowerCase().replace(/\s+/g, " ");
    const taskId = `voice_task_${createHash("sha256")
      .update(JSON.stringify([call.id, input.sourceMessageId ?? input.actionId, normalized]))
      .digest("hex")}`;
    const actionKey = createHash("sha256")
      .update(JSON.stringify([call.id, input.actionId]))
      .digest("hex");
    const previousAction = runtime.db.record("voiceAction", actionKey);
    if (previousAction && previousAction.taskId !== taskId)
      throw fail(409, "Voice action ID was already used for another request.");
    let task = runtime.db.getTask(taskId);
    if (task && !ownsTask(task))
      throw fail(409, "Task identity conflicts with another conversation.");
    if (!task) {
      const context = this.context(call);
      if (!context.execution.canSubmit)
        throw fail(409, "Agent execution is unavailable or requires reconciliation.");
      const background = context.conversation
        .map(
          (turn) =>
            `${turn.role === "user" ? "User" : call.name}${turn.interrupted ? " (interrupted)" : ""}: ${turn.text}`,
        )
        .join("\n")
        .slice(-6000);
      if (!previousAction)
        runtime.db.saveRecord("voiceAction", actionKey, { callId: call.id, taskId });
      task = runtime.submit({
        taskId,
        seatId: call.seatId,
        sessionKey: call.sessionKey,
        bindingRevision: call.bindingRevision,
        message,
        sourceMessageId: input.sourceMessageId,
        ...(background ? { context: background } : {}),
      });
    } else if (!previousAction)
      runtime.db.saveRecord("voiceAction", actionKey, { callId: call.id, taskId });
    return {
      accepted: true,
      taskId: task.taskId,
      agent: call.name,
      task: view(task),
      status: task.status,
      note: "Recorded in the durable task queue. Acceptance does not confirm completion.",
    };
  }

  context(input) {
    if (
      !input ||
      !validText(input.seatId, 256) ||
      !Number.isSafeInteger(input.bindingRevision) ||
      input.bindingRevision < 1 ||
      (input.sessionKey !== undefined && !validText(input.sessionKey, 256)) ||
      (input.taskIds !== undefined &&
        (!Array.isArray(input.taskIds) ||
          input.taskIds.length > 20 ||
          input.taskIds.some((id) => !validText(id, 100))))
    )
      throw fail(400, "A seat and binding revision are required for voice.");
    const runtime = this.runtime;
    const { seat, agentId, sessionKey } = runtime.resolve(input.seatId, input.sessionKey);
    if (seat.binding.revision !== input.bindingRevision)
      throw fail(409, "Agent binding changed; select the agent again.");
    const tasks = this.tasksForContext({
      sessionKey,
      agentId,
      seatId: seat.seatId,
      bindingRevision: seat.binding.revision,
    });
    const active = tasks.filter(
      (task) => !["completed", "failed", "stopped", "interrupted"].includes(task.status),
    );
    // An older task can finish while a call is in progress. Keep requested outcomes and
    // active work in the bounded snapshot instead of letting newer queued work hide them.
    const requestedIds = new Set(input.taskIds ?? []);
    const visibleTasks = [
      ...new Map(
        [
          ...tasks.filter((task) => requestedIds.has(task.taskId)),
          ...active,
          ...tasks.slice(0, 5),
        ].map((task) => [task.taskId, task]),
      ).values(),
    ].slice(0, 30);
    const blocked =
      runtime.roleLocks.has(seat.seatId) ||
      runtime.management.busyAgent(agentId) ||
      runtime.management.busySession(sessionKey);
    const gatewayConnected =
      runtime.gateway.status === "connected" &&
      runtime.gateway.capabilities()["chat.send"]?.available === true;
    const ownTaskIds = new Set(tasks.map((task) => task.taskId));
    const ownRuns = new Set(tasks.map((task) => task.runId).filter(Boolean));
    return {
      seatId: seat.seatId,
      agentId,
      bindingRevision: seat.binding.revision,
      name: seat.label,
      role: seat.roleTitle || "AI teammate",
      sessionKey,
      gatewayConnected,
      status: blocked
        ? "configuration_pending"
        : (active.find((task) => task.status !== "queued")?.status ?? active[0]?.status ?? "idle"),
      execution: {
        canSubmit: gatewayConnected && !blocked,
        configurationPending: !!blocked,
        reviewRequired: runtime.reviews.blocksLane(sessionKey),
        activeTaskIds: active.map((task) => task.taskId),
      },
      tasks: visibleTasks.map((task) => ({
        taskId: task.taskId,
        message: task.message.slice(0, 1200),
        status: task.status,
        result: (task.result ?? task.error)?.slice(0, 2500),
        createdAt: task.createdAt,
      })),
      conversation: runtime.db
        .messages(sessionKey)
        .filter(
          (message) =>
            message.sessionKey === sessionKey &&
            (message.agentId === undefined || message.agentId === agentId) &&
            (message.gatewayId === undefined || message.gatewayId === runtime.gatewayId) &&
            (message.seatId === undefined || message.seatId === seat.seatId) &&
            (message.bindingRevision === undefined ||
              message.bindingRevision === seat.binding.revision) &&
            !message.streaming &&
            ["user", "assistant"].includes(message.role) &&
            (message.source === "voice"
              ? message.seatId === seat.seatId &&
                message.bindingRevision === seat.binding.revision &&
                message.gatewayId === runtime.gatewayId
              : message.taskId
                ? ownTaskIds.has(message.taskId)
                : ownRuns.has(message.runId)),
        )
        .slice(-6)
        .map((message) => ({
          role: message.role,
          text: message.content.slice(0, 1000),
          ...(message.interrupted ? { interrupted: true } : {}),
        })),
    };
  }

  createCall(input) {
    const peer = this.peer(input ?? {});
    if (peer) return peer.createCall(input);
    const context = this.context(input);
    const id = `voice_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.runtime.db.saveSession({ key: context.sessionKey, createdAt }, context.agentId);
    this.runtime.db.saveRecord("voiceCall", id, {
      seatId: context.seatId,
      name: context.name,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      bindingRevision: context.bindingRevision,
      gatewayId: this.runtime.gatewayId,
      createdAt,
      model: VOICE_MODEL,
      apiVersion: VOICE_API_VERSION,
      status: "provisioned",
      durationMs: 0,
      usageReports: [],
    });
    return id;
  }

  snapshot() {
    return {
      billingNotice: VOICE_BILLING_NOTICE,
      calls: this.runtime.db
        .records("voiceCall")
        .filter((call) => call.gatewayId === this.runtime.gatewayId)
        .slice(-100)
        .reverse(),
    };
  }

  recordFailure(selection, diagnostic) {
    const peer = this.peer(selection ?? {});
    if (peer) return peer.recordFailure(selection, diagnostic);
    const callId = this.createCall(selection);
    return this.report({ callId, sequence: 1, status: "error", durationMs: 0, diagnostic });
  }

  report(input) {
    const peer = this.peer({ callId: input?.callId });
    if (peer) return peer.report(input);
    if (
      !input ||
      !validText(input.callId, 100) ||
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 1 ||
      !["connected", "ended", "error"].includes(input.status) ||
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 0 ||
      input.durationMs > 660000
    )
      throw fail(400, "Invalid voice usage report.");
    const db = this.runtime.db;
    const call = db.record("voiceCall", input.callId);
    if (!call || call.gatewayId !== this.runtime.gatewayId)
      throw fail(404, "Voice call not found.");
    // Finalization wins over delayed uploads, retries, and close/error races.
    if (call.endedAt || input.sequence <= (call.sequence ?? 0)) return call;
    const now = new Date().toISOString();
    const usage =
      Number.isSafeInteger(input.usageSequence) && input.usageSequence > (call.usageSequence ?? 0)
        ? sanitizeUsage(input.usage)
        : undefined;
    return db.saveRecord("voiceCall", call.id, {
      ...call,
      sequence: input.sequence,
      status: input.status,
      updatedAt: now,
      ...(input.status !== "connected" ? { endedAt: now } : {}),
      durationMs: Math.max(call.durationMs ?? 0, input.durationMs),
      ...(input.diagnostic ? { diagnostic: sanitizeDiagnostic(input.diagnostic) } : {}),
      usageReports: usage
        ? [
            ...(call.usageReports ?? []),
            { sequence: input.sequence, reportedAt: now, usage },
          ].slice(-100)
        : (call.usageReports ?? []),
      usageSequence: usage ? input.usageSequence : (call.usageSequence ?? 0),
      usageSource: "provider_reported_client_relayed",
    });
  }

  finalize(input) {
    const peer = this.peer({ callId: input?.callId });
    if (peer) return peer.finalize(input);
    if (
      !input ||
      !validText(input.callId, 100) ||
      !validText(input.id, 200) ||
      !["user", "assistant"].includes(input.role) ||
      (input.interrupted !== undefined &&
        (input.interrupted !== true || input.role !== "assistant")) ||
      (input.streaming !== undefined && input.streaming !== false) ||
      !validText(input.content, 32000) ||
      !input.content.trim() ||
      typeof input.timestamp !== "string" ||
      !Number.isFinite(Date.parse(input.timestamp))
    )
      throw fail(400, "Invalid finalized voice transcript.");
    const db = this.runtime.db;
    const call = db.record("voiceCall", input.callId);
    if (!call || call.gatewayId !== this.runtime.gatewayId)
      throw fail(404, "Voice call not found.");
    // A completed turn is immutable and retry-safe, even after the seat is rebound.
    const previous = db.getMessage(input.id);
    if (previous) {
      if (
        previous.runId !== call.id ||
        previous.role !== input.role ||
        previous.content !== input.content ||
        previous.interrupted !== input.interrupted
      )
        throw fail(409, "Transcript ID was already finalized with different content.");
      return previous;
    }
    const task = db
      .tasksForSession(call.sessionKey)
      .find(
        (task) =>
          task.sourceMessageId === input.id &&
          task.seatId === call.seatId &&
          task.bindingRevision === call.bindingRevision,
      );
    const message = {
      id: input.id,
      runId: call.id,
      source: "voice",
      role: input.role,
      content: input.content,
      timestamp: input.timestamp,
      streaming: false,
      ...(input.interrupted ? { interrupted: true } : {}),
      seatId: call.seatId,
      actorName: call.name,
      sessionKey: call.sessionKey,
      agentId: call.agentId,
      bindingRevision: call.bindingRevision,
      gatewayId: call.gatewayId,
      ...(task ? { taskId: task.taskId } : {}),
    };
    db.saveMessage(message);
    return message;
  }
}
