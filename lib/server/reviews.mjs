import { createHash } from "node:crypto";
import { TERMINAL } from "./task-db.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const active = (item) => ["pending", "submitting", "outcome_unknown"].includes(item.status);
const owner = (key) => /^agent:([a-zA-Z0-9_-]+):[^\s]+$/.exec(key ?? "")?.[1];

/** Reviewer data never goes through Gemini. Only this service can resolve it. */
export class ReviewService {
  constructor(runtime) {
    this.runtime = runtime;
    this.db = runtime.db;
    this.gateway = runtime.gateway;
    this.recovery = {};
    this.subscriptions = new Set();
    this.lookups = new Set();
    for (const item of this.items())
      if (item.status === "submitting")
        this.save(item, {
          status: "outcome_unknown",
          error:
            "The server restarted during submission. Check backend state; this decision will not be resent.",
        });
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
  }
  items() {
    return this.db.records("review").filter((item) => item.gatewayId === this.runtime.gatewayId);
  }
  key(kind, id) {
    return createHash("sha256").update(`${this.runtime.gatewayId}:${kind}:${id}`).digest("hex");
  }
  save(item, patch) {
    return this.db.saveRecord("review", item.id, { ...item, ...patch });
  }
  snapshot() {
    this.expire();
    return this.items();
  }
  blocksLane(sessionKey) {
    return this.items().some(
      (item) =>
        item.sessionKey === sessionKey &&
        active(item) &&
        (!item.taskId || !TERMINAL.has(this.db.getTask(item.taskId)?.status)),
    );
  }
  disconnected() {
    this.subscriptions.clear();
    this.recovery = {
      ...this.recovery,
      connection:
        "Disconnected. Saved requests may have been resolved elsewhere; reconnect to verify.",
    };
  }
  expire() {
    if (this.runtime.closed) return;
    for (const item of this.items())
      if (active(item) && item.expiresAtMs <= Date.now())
        this.save(item, {
          status: "expired",
          error: "Request expired. Expiry does not confirm that its task finished.",
        });
  }
  put(kind, payload, sessionKey, runId) {
    if (this.runtime.closed) return;
    const id = this.key(kind, payload.id);
    const previous = this.db.record("review", id);
    const session = previous?.sessionKey ?? payload.sessionKey ?? sessionKey;
    const agentId = payload.agentId ?? payload.presentation?.agentId ?? owner(session);
    if (agentId && owner(session) && agentId !== owner(session)) return;
    if (previous?.sessionKey && sessionKey && sessionKey !== previous.sessionKey) return;
    const backendStatus = payload.status;
    if (!backendStatus) return;
    const pending = backendStatus === "pending";
    if (previous && !active(previous) && pending) return; // Late event/list must not reopen a decision.
    const exactRun = payload.runId ?? runId ?? previous?.runId;
    const candidates = this.db
      .activeTasks()
      .filter(
        (task) =>
          task.gatewayId === this.runtime.gatewayId &&
          task.sessionKey === session &&
          (!agentId || task.agentId === agentId) &&
          (exactRun
            ? task.runId === exactRun
            : !!task.runId && Date.parse(task.createdAt) <= payload.createdAtMs),
      );
    const task = candidates.length === 1 ? candidates[0] : undefined;
    // Preserve only reviewer-safe presentation; secret answers are never saved.
    const safePayload =
      kind === "approval"
        ? payload
        : {
            id: payload.id,
            questions: payload.questions,
            createdAtMs: payload.createdAtMs,
            expiresAtMs: payload.expiresAtMs,
            status: payload.status,
          };
    const next = {
      ...previous,
      id,
      gatewayId: this.runtime.gatewayId,
      backendId: payload.id,
      kind,
      sessionKey: session,
      agentId,
      runId: exactRun,
      taskId: task?.taskId ?? previous?.taskId,
      association: task ? (exactRun ? "run" : "session") : previous?.association,
      createdAtMs: payload.createdAtMs ?? previous?.createdAtMs,
      expiresAtMs: payload.expiresAtMs ?? previous?.expiresAtMs,
      payload: safePayload,
      backendStatus,
      status: pending
        ? (previous?.status ?? "pending")
        : backendStatus === "expired"
          ? "expired"
          : "resolved",
      error: pending ? previous?.error : undefined,
    };
    if (
      JSON.stringify({ ...previous, revision: undefined }) !==
      JSON.stringify({ ...next, revision: undefined })
    )
      this.db.saveRecord("review", id, next);
    if (
      task &&
      !TERMINAL.has(task.status) &&
      task.status !== "outcome_unknown" &&
      !task.cancelRequestedAt
    ) {
      this.db.updateTask(task.taskId, {
        status: pending
          ? kind === "approval"
            ? "waiting_approval"
            : "waiting_question"
          : this.taskStatus(task),
      });
    }
    this.expire();
  }
  taskStatus(task) {
    const remaining = this.items().find((item) => item.taskId === task.taskId && active(item));
    return remaining
      ? remaining.kind === "approval"
        ? "waiting_approval"
        : "waiting_question"
      : "running";
  }
  associate() {
    for (const item of this.items())
      if (active(item) && !item.taskId)
        this.put(
          item.kind,
          { ...item.payload, agentId: item.agentId, runId: item.runId },
          item.sessionKey,
          item.runId,
        );
  }
  receive(frame) {
    const caps = this.gateway.capabilities();
    if (
      frame.event === "session.approval" &&
      caps["approval.events"]?.available &&
      this.gateway.audit.validate("SessionApprovalEventSchema", frame.payload)
    )
      this.put(
        "approval",
        frame.payload.approval,
        frame.payload.sourceSessionKey ?? frame.payload.sessionKey,
      );
    if (
      frame.event === "question.requested" &&
      caps["question.events"]?.available &&
      this.gateway.audit.validate("QuestionRequestedEventSchema", frame.payload)
    )
      this.put("question", frame.payload, frame.payload.sessionKey);
    if (
      frame.event === "question.resolved" &&
      caps["question.resolvedEvents"]?.available &&
      this.gateway.audit.validate("QuestionResolvedEventSchema", frame.payload)
    ) {
      const previous = this.db.record("review", this.key("question", frame.payload.id));
      if (previous)
        this.put(
          "question",
          { ...previous.payload, ...frame.payload, answers: undefined },
          previous.sessionKey,
          previous.runId,
        );
    }
    // Installed agent execution events identify an approval by id, but do not
    // contain the requested action. Fetch its verified reviewer-safe snapshot.
    if (
      frame.event === "agent" &&
      frame.payload?.stream === "execution" &&
      this.gateway.audit.validate("AgentEventSchema", frame.payload)
    ) {
      const id = frame.payload.data?.approval?.id;
      if (typeof id === "string" && caps["approval.get"]?.available && !this.lookups.has(id)) {
        this.lookups.add(id);
        void this.fetchApproval(id, frame.payload.sessionKey, frame.payload.runId)
          .catch(() => {
            if (!this.runtime.closed) {
              this.recovery.approvalLookup =
                "An execution event reports a review, but its requested action could not be retrieved. Review it in the backend client; no decision was submitted.";
              this.db.publish({ kind: "reviewRecovery", data: this.recovery });
            }
          })
          .finally(() => this.lookups.delete(id));
      }
    }
  }
  async fetchApproval(id, sessionKey, runId) {
    const result = await this.gateway.request("approval.get", { id });
    if (
      !this.gateway.audit.validate("ApprovalGetResultSchema", result) ||
      result.approval.id !== id
    )
      throw fail(502, "Incompatible approval lookup response.");
    this.put("approval", result.approval, sessionKey, runId);
  }
  async subscribeSession(key) {
    if (!owner(key) || this.subscriptions.has(key)) return;
    const caps = this.gateway.capabilities();
    if (!caps["approval.events"]?.available || !caps["sessions.messages.subscribe"]?.available)
      return;
    this.subscriptions.add(key);
    try {
      const result = await this.gateway.request("sessions.messages.subscribe", {
        key,
        agentId: owner(key),
        includeApprovals: true,
      });
      if (this.runtime.closed) return;
      const replay = result?.approvalReplay;
      if (
        !result?.subscribed ||
        !this.gateway.audit.validate("SessionApprovalReplaySchema", replay) ||
        replay.sessionKey !== key
      )
        throw fail(502, "Gateway did not confirm a compatible session approval replay.");
      for (const approval of replay.approvals)
        this.put("approval", approval, approval.sourceSessionKey ?? key);
      this.recovery[`session:${key}`] = replay.truncated
        ? "Session approval replay was truncated; some requests may be missing."
        : "Session approval subscription and replay confirmed.";
    } catch (error) {
      this.subscriptions.delete(key);
      this.recovery[`session:${key}`] = error.rejected
        ? "Gateway rejected approval subscription. A paired reviewer device or additional session authority may be required."
        : "Session approval subscription/replay could not be confirmed.";
    }
    if (!this.runtime.closed)
      this.db.publish({ kind: "reviewRecovery", data: { ...this.recovery } });
  }
  async recover() {
    if (this.recovering) return this.recovering;
    this.recovering = this.doRecover().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }
  async doRecover() {
    const caps = this.gateway.capabilities();
    this.recovery = {
      ...Object.fromEntries(
        Object.entries(this.recovery).filter(([key]) => key.startsWith("session:")),
      ),
      approvals: caps["exec.approval.list"]?.available
        ? "Approval listing requires a verified result adapter."
        : `${caps["exec.approval.list"]?.reason} Global pending-approval recovery is unavailable; saved items and confirmed session replay cover only observed sessions.`,
    };
    if (
      caps["exec.approval.list"]?.available &&
      this.gateway.audit.validators.has("ExecApprovalListResultSchema")
    ) {
      try {
        const result = await this.gateway.request("exec.approval.list", {});
        if (
          !this.gateway.audit.validate("ExecApprovalListResultSchema", result) ||
          !Array.isArray(result.approvals)
        )
          throw new Error();
        for (const approval of result.approvals)
          if (this.gateway.audit.validate("ApprovalSnapshotSchema", approval))
            this.put("approval", approval, approval.sourceSessionKey);
        this.recovery.approvals = "Verified approval listing loaded.";
      } catch {
        this.recovery.approvals = "Approval listing failed; saved requests may be stale.";
      }
    }
    if (
      caps["question.list"]?.available &&
      this.gateway.audit.validators.has("QuestionListResultSchema")
    ) {
      try {
        const result = await this.gateway.request("question.list", {});
        if (!this.gateway.audit.validate("QuestionListResultSchema", result)) throw new Error();
        for (const question of result.questions)
          this.put("question", question, question.sessionKey);
        this.recovery.questions =
          "Verified question listing loaded. Missing records are not assumed resolved.";
      } catch {
        this.recovery.questions =
          "Question listing failed. Saved requests may be stale; reconnect or check again.";
      }
    } else
      this.recovery.questions = `${caps["question.list"]?.reason} Question recovery by listing is unavailable.`;
    if (this.runtime.closed) return;
    const keys = new Set([
      ...this.db.sessions().map((session) => session.key),
      ...this.db.seats().map((seat) => seat.binding?.sessionKey),
      ...this.items().map((item) => item.sessionKey),
    ]);
    await Promise.all([...keys].filter(Boolean).map((key) => this.subscribeSession(key)));
    if (this.runtime.closed) return;
    for (const item of this.items().filter(active)) {
      try {
        if (item.kind === "approval" && caps["approval.get"]?.available)
          await this.fetchApproval(item.backendId, item.sessionKey, item.runId);
        if (item.kind === "question" && caps["question.get"]?.available) {
          const result = await this.gateway.request("question.get", { id: item.backendId });
          if (
            !this.gateway.audit.validate("QuestionGetResultSchema", result) ||
            result.question?.id !== item.backendId
          )
            throw new Error();
          this.put("question", result.question, item.sessionKey, item.runId);
        }
      } catch {
        if (!this.runtime.closed)
          this.save(this.db.record("review", item.id), {
            error:
              "Backend state could not be refreshed. This request may have been resolved elsewhere.",
          });
      }
    }
    if (!this.runtime.closed) this.db.publish({ kind: "reviewRecovery", data: this.recovery });
  }
  async decide(id, input) {
    this.expire();
    let item = this.db.record("review", id);
    if (!item || item.gatewayId !== this.runtime.gatewayId)
      throw fail(404, "Review request not found.");
    if (typeof input.operationId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId))
      throw fail(400, "A stable decision identifier is required.");
    const choice =
      item.kind === "approval"
        ? { decision: input.decision }
        : input.cancel === true
          ? { cancel: true }
          : { answers: input.answers };
    const fingerprint = createHash("sha256").update(JSON.stringify(choice)).digest("hex");
    if (item.operationId === input.operationId) {
      if (item.decisionHash !== fingerprint)
        throw fail(409, "Decision identifier already used for another response.");
      return item;
    }
    if (item.status !== "pending")
      throw fail(
        409,
        "Request is expired, resolved, or a decision is already in progress. Check backend state.",
      );
    if (input.revision !== item.revision)
      throw fail(409, "Request changed. Refresh and review again.");
    let method, params, schema;
    if (item.kind === "approval") {
      this.runtime.require("approvals");
      const presentation = item.payload.presentation;
      if (!presentation.allowedDecisions.includes(input.decision))
        throw fail(400, "This decision is not permitted by the backend presentation.");
      if (presentation.externalResolution?.decisions?.includes(input.decision))
        throw fail(409, `Resolve this decision through ${presentation.externalResolution.label}.`);
      method = "approval.resolve";
      params = { id: item.backendId, kind: presentation.kind, decision: input.decision };
      schema = "ApprovalResolveResultSchema";
    } else {
      this.runtime.require("questions");
      method = "question.resolve";
      schema = "QuestionResolveResultSchema";
      if (input.cancel === true) params = { id: item.backendId, cancel: true };
      else {
        const answers = input.answers;
        if (
          !answers ||
          typeof answers !== "object" ||
          Array.isArray(answers) ||
          Object.keys(answers).some(
            (key) => !item.payload.questions.some((q) => q.questionId === key),
          )
        )
          throw fail(400, "Invalid question answers.");
        for (const question of item.payload.questions) {
          if (question.isSecret || question.secretStore || question.resource)
            throw fail(
              409,
              "This question needs a secure/resource-capable backend client. Answer it there or cancel it here.",
            );
          const values = answers[question.questionId];
          const allowed = question.options.map((option) => option.value ?? option.label);
          if (
            !Array.isArray(values) ||
            (!question.allowEmpty && !values.length) ||
            (!question.multiSelect && values.length > 1) ||
            new Set(values).size !== values.length ||
            values.some(
              (value) =>
                typeof value !== "string" ||
                (!question.allowEmpty && !value.trim()) ||
                value.length > 4096 ||
                (!question.isOther && allowed.length && !allowed.includes(value)),
            )
          )
            throw fail(400, "Answer does not match the question's permitted choices.");
        }
        params = { id: item.backendId, answers: { answers } };
      }
    }
    this.runtime.require(method);
    if (!this.gateway.audit.validate(method, params))
      throw fail(400, "Decision does not match the installed backend schema.");
    // Transactional claim precedes every network await. Secret/resource answers
    // were rejected above; ordinary user decisions remain in the audit record.
    item = this.db.saveRecord(
      "review",
      id,
      {
        ...item,
        status: "submitting",
        operationId: input.operationId,
        decisionHash: fingerprint,
        decision: choice,
        error: undefined,
      },
      input.revision,
    );
    try {
      const result = await this.gateway.request(method, params);
      if (this.runtime.closed) return item;
      if (!this.gateway.audit.validate(schema, result))
        throw new Error("Unverified decision response");
      if (item.kind === "approval") {
        if (result.approval.id !== item.backendId) throw new Error("Mismatched approval response");
        this.put("approval", result.approval, item.sessionKey, item.runId);
      } else
        this.put(
          "question",
          { ...item.payload, status: result.status },
          item.sessionKey,
          item.runId,
        );
    } catch (error) {
      if (this.runtime.closed) return item;
      const latest = this.db.record("review", id);
      if (active(latest))
        this.save(latest, {
          status: error.rejected ? "pending" : "outcome_unknown",
          error: error.rejected
            ? "Gateway rejected the decision. Refresh to check whether it was resolved elsewhere before trying again."
            : "Decision outcome unknown. It will not be resent; check backend state.",
        });
      if (error.rejected) await this.recover();
    }
    void this.runtime.pump();
    return this.db.record("review", id);
  }
  close() {
    clearInterval(this.timer);
  }
}
