import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { boundConversationSession } from "../identity";
import { createRuntimeHandler } from "../server/runtime-api.mjs";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { assignedOperationTask } from "../operations-contracts.mjs";

// Reuse compiled fixture schemas; each gateway still owns its mutable execution state.
const fixtureAudit = new ContractAudit(fixture);
class FakeGateway {
  provider = "openclaw";
  audit = fixtureAudit;
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  listeners = new Set<(kind: string, data: unknown) => void>();
  pending: Array<{
    params: Record<string, string>;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  results = new Map<string, unknown>();
  file = "Existing backend instructions.\n";
  calls: Array<{ method: string; params: Record<string, string> }> = [];
  subscribe(fn: (kind: string, data: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  capabilities() {
    return this.audit.capabilities(this.hello, this.status === "connected");
  }
  stop() {
    this.status = "disconnected";
  }
  request(method: string, params: Record<string, string>) {
    if (!this.audit.validate(method, params))
      return Promise.reject(new Error(`Invalid ${method} parameters`));
    this.calls.push({ method, params });
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "carol" }, { id: "bob" }],
      });
    if (method === "agents.files.get")
      return Promise.resolve({
        agentId: params.agentId,
        workspace: "/fixture",
        file: {
          name: "SOUL.md",
          path: "/fixture/SOUL.md",
          missing: false,
          content: this.file,
          hash: createHash("sha256").update(this.file).digest("hex"),
        },
      });
    if (method === "agents.files.set") {
      this.file = params.content;
      return Promise.resolve({ ok: true });
    }
    if (method === "chat.send")
      return new Promise((resolve, reject) => this.pending.push({ params, resolve, reject }));
    if (method === "agent.wait")
      return Promise.resolve(
        this.results.get(params.runId) ?? { runId: params.runId, status: "timeout" },
      );
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    return Promise.resolve({ ok: true });
  }
  event(payload: unknown) {
    for (const listener of this.listeners)
      listener("event", { type: "event", event: "chat", payload });
  }
  disconnect() {
    this.status = "disconnected";
    for (const listener of this.listeners) listener("status", "disconnected");
  }
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
async function setup(path = ":memory:") {
  const db = new TaskDatabase(path);
  const gateway = new FakeGateway();
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "gateway-1" });
  await runtime.refresh();
  const seat = (id: string, agentId: string) =>
    runtime.saveSeat({
      seatId: id,
      label: id,
      assigned: true,
      seatType: agentId === "main" ? "worker" : "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  const submit = (taskId: string, seatId: string, extra = {}) =>
    runtime.submit({
      taskId,
      seatId,
      bindingRevision: db.getSeat(seatId).binding.revision,
      message: "Draft a note",
      ...extra,
    });
  cleanups.push(() => {
    runtime.close();
    db.close();
  });
  return { db, gateway, runtime, seat, submit };
}
function final(gateway: FakeGateway, runId: string, sessionKey: string, state = "final", seq = 1) {
  gateway.event({
    runId,
    sessionKey,
    state,
    seq,
    message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  });
}

describe("voice actions through the durable runtime", () => {
  it("pins task creation to the call, links transcripts, and deduplicates HTTP and model retries", async () => {
    const { runtime, seat, db, gateway } = await setup();
    seat("Carol", "carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    runtime.voice.finalize({
      callId,
      id: "spoken-request",
      role: "user",
      content: "Draft a note",
      timestamp: new Date().toISOString(),
    });
    const input = {
      callId,
      actionId: "tool-1",
      tool: "assign_task",
      sourceMessageId: "spoken-request",
      args: {
        message: "Draft a note",
        seatId: "Bob",
        sessionKey: "agent:bob:main",
        context: "Forged context",
      },
    };
    const result = await runtime.voice.action(input);
    expect(result).toMatchObject({ accepted: true, status: "queued" });
    expect(db.getTask(result.taskId)).toMatchObject({
      seatId: "Carol",
      agentId: "carol",
      sessionKey: "agent:carol:main",
      bindingRevision: 1,
      sourceMessageId: "spoken-request",
    });
    expect(db.getTask(result.taskId).executionMessage).not.toContain("Forged context");
    expect(db.getMessage("spoken-request").taskId).toBe(result.taskId);
    expect((await runtime.voice.action(input)).taskId).toBe(result.taskId);
    expect((await runtime.voice.action({ ...input, actionId: "tool-repeat" })).taskId).toBe(
      result.taskId,
    );
    expect(gateway.pending).toHaveLength(1);
    await expect(
      runtime.voice.action({ ...input, args: { message: "Different request" } }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reads recorded progress and requests cancellation once without claiming the run stopped", async () => {
    const { runtime, seat, gateway } = await setup();
    seat("Carol", "carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    const accepted = await runtime.voice.action({
      callId,
      actionId: "create",
      tool: "assign_task",
      args: { message: "Draft a note" },
    });
    gateway.pending[0].resolve({ runId: "voice-running" });
    await tick();
    const input = {
      callId,
      actionId: "progress",
      tool: "get_task_progress",
      args: { taskId: accepted.taskId },
    };
    expect(await runtime.voice.action(input)).toMatchObject({ task: { status: "running" } });
    const result = await runtime.voice.action({ ...input, tool: "cancel_task" });
    expect(result).toMatchObject({
      task: { status: "cancel_requested", cancelState: "acknowledged" },
    });
    await runtime.voice.action({
      ...input,
      tool: "cancel_task",
      actionId: "repeat-cancel",
      args: { ...input.args, retry: true },
    });
    expect(gateway.calls.filter((call) => call.method === "chat.abort")).toHaveLength(1);
    final(gateway, "voice-running", "agent:carol:main", "aborted");
    expect(await runtime.voice.action(input)).toMatchObject({ task: { status: "stopped" } });
  });

  it("can read uncertain progress and stop a queued task while disconnected", async () => {
    const { runtime, seat, submit, gateway } = await setup();
    seat("Carol", "carol");
    submit("busy-lane", "Carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    const queued = await runtime.voice.action({
      callId,
      actionId: "queued",
      tool: "assign_task",
      args: { message: "Later task" },
    });
    expect(queued.task!.status).toBe("queued");
    gateway.disconnect();
    expect(
      await runtime.voice.action({
        callId,
        actionId: "read",
        tool: "get_task_progress",
        args: { taskId: "busy-lane" },
      }),
    ).toMatchObject({ task: { status: "outcome_unknown" } });
    expect(
      await runtime.voice.action({
        callId,
        actionId: "stop",
        tool: "cancel_task",
        args: { taskId: queued.taskId },
      }),
    ).toMatchObject({ task: { status: "stopped" } });
    expect(gateway.calls.filter((call) => call.method === "chat.abort")).toHaveLength(0);
  });

  it.each([false, true])(
    "preserves a failed cancellation's uncertainty without a voice retry (rejected=%s)",
    async (rejected) => {
      const { runtime, seat, gateway } = await setup();
      seat("Carol", "carol");
      const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
      const accepted = await runtime.voice.action({
        callId,
        actionId: "create",
        tool: "assign_task",
        args: { message: "Long task" },
      });
      gateway.pending[0].resolve({ runId: "cancellation-failure" });
      await tick();
      const original = gateway.request.bind(gateway);
      const request = vi
        .spyOn(gateway, "request")
        .mockImplementation((method, params) =>
          method === "chat.abort"
            ? Promise.reject(Object.assign(new Error("backend abort failed"), { rejected }))
            : original(method, params),
        );
      const input = {
        callId,
        actionId: "cancel",
        tool: "cancel_task",
        args: { taskId: accepted.taskId, retry: true, expectedAttempt: 1 },
      };
      expect(await runtime.voice.action(input)).toMatchObject({
        task: {
          status: rejected ? "running" : "outcome_unknown",
          cancelState: rejected ? "rejected" : "outcome_unknown",
        },
      });
      await runtime.voice.action({ ...input, actionId: "retry" });
      expect(request.mock.calls.filter(([method]) => method === "chat.abort")).toHaveLength(1);
    },
  );

  it("rejects foreign worker tasks, foreign sessions, stale bindings and ended calls", async () => {
    const { runtime, seat, submit, db, gateway } = await setup();
    seat("Alice", "main");
    seat("Bob", "main");
    submit("bobs-task", "Bob");
    submit("other-session", "Alice", { sessionKey: "agent:main:other" });
    const callId = runtime.voice.createCall({ seatId: "Alice", bindingRevision: 1 });
    const input = {
      callId,
      actionId: "scoped",
      tool: "get_task_progress",
      args: { taskId: "bobs-task" },
    };
    await expect(runtime.voice.action(input)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.voice.action({ ...input, tool: "cancel_task" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      runtime.voice.action({ ...input, args: { taskId: "other-session" } }),
    ).rejects.toMatchObject({ status: 404 });
    const alice = db.getSeat("Alice");
    db.saveSeat({ ...alice, binding: { ...alice.binding, revision: 2 } });
    await expect(runtime.voice.action(input)).rejects.toMatchObject({ status: 409 });
    db.saveSeat(alice);
    runtime.voice.report({ callId, sequence: 1, status: "ended", durationMs: 1 });
    await expect(runtime.voice.action(input)).rejects.toMatchObject({ status: 409 });
    expect(gateway.calls.filter((call) => call.method === "chat.abort")).toHaveLength(0);
  });

  it("only returns a scoped review dialog ID and never submits approvals or answers", async () => {
    const { runtime, seat, db, gateway } = await setup();
    seat("Carol", "carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    const review = {
      gatewayId: "gateway-1",
      status: "pending",
      agentId: "carol",
      sessionKey: "agent:carol:main",
      expiresAtMs: Date.now() + 60000,
      payload: { commandText: "Private command" },
    };
    db.saveRecord("review", "foreign-review", { ...review, sessionKey: "agent:carol:other" });
    db.saveRecord("review", "current-review", review);
    const input = {
      callId,
      actionId: "review",
      tool: "open_pending_review",
      args: { decision: "allow-once", answers: { secret: "answer" } },
    };
    const result = await runtime.voice.action(input);
    expect(result).toMatchObject({ reviewId: "current-review" });
    expect(JSON.stringify(result)).not.toContain("Private command");
    for (const tool of ["approval.resolve", "question.resolve", "approve", "answer_question"])
      await expect(runtime.voice.action({ ...input, tool })).rejects.toMatchObject({ status: 400 });
    expect(db.record("review", "current-review").status).toBe("pending");
    expect(
      gateway.calls.filter((call) =>
        ["approval.resolve", "question.resolve"].includes(call.method),
      ),
    ).toHaveLength(0);
  });

  it("recovers the same accepted action from SQLite after a runtime restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-voice-action-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const first = await setup(path);
    first.seat("Carol", "carol");
    const callId = first.runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    const input = {
      callId,
      actionId: "stable-tool",
      tool: "assign_task",
      args: { message: "Durable request" },
    };
    const accepted = await first.runtime.voice.action(input);
    first.runtime.close();
    first.db.close();
    cleanups.pop();
    const second = await setup(path);
    expect(await second.runtime.voice.action(input)).toMatchObject({
      taskId: accepted.taskId,
      task: { status: "outcome_unknown" },
    });
    expect(second.gateway.pending).toHaveLength(0);
    expect(second.db.listTasks()).toHaveLength(1);
  });
});

describe("durable server task execution", () => {
  it("resolves voice identity, role and execution from the verified server binding", async () => {
    const { seat, submit, runtime } = await setup();
    seat("Carol", "carol");
    seat("Bob", "bob");
    const selected = { seatId: "Carol", bindingRevision: 1, sessionKey: "agent:carol:main" };
    submit("voice-context-task", "Carol");
    submit("foreign-context-task", "Bob");
    const context = runtime.voice.context({
      ...selected,
      name: "Forged",
      role: "Admin",
      tasks: [],
    });
    expect(context).toMatchObject({
      name: "Carol",
      agentId: "carol",
      role: "AI teammate",
      bindingRevision: 1,
      status: "submitted",
      execution: { canSubmit: true },
    });
    expect(context.tasks.map((task: { taskId: string }) => task.taskId)).toEqual([
      "voice-context-task",
    ]);
    expect(() => runtime.voice.context({ ...selected, bindingRevision: 0 })).toThrow();
    expect(() => runtime.voice.context({ ...selected, bindingRevision: 2 })).toThrow(
      /binding changed/,
    );
    expect(() => runtime.voice.context({ ...selected, sessionKey: "agent:bob:main" })).toThrow(
      /another backend agent/,
    );
    expect(() => runtime.voice.context({ seatId: "Carol" })).toThrow(/revision/);
  });

  it("requires verified discovery and reflects blocked execution in voice context", async () => {
    const { seat, runtime, gateway } = await setup();
    seat("Carol", "carol");
    const selected = { seatId: "Carol", bindingRevision: 1 };
    runtime.roleLocks.add("Carol");
    expect(runtime.voice.context(selected)).toMatchObject({
      gatewayConnected: true,
      status: "configuration_pending",
      execution: { canSubmit: false },
    });
    gateway.disconnect();
    expect(() => runtime.voice.context(selected)).toThrow(/available backend agent/);
  });

  it("persists finalized voice turns across database reopen with immutable call identity and idempotency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-voice-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const { seat, runtime, db } = await setup(path);
    seat("Carol", "carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    runtime.saveSeat({
      seatId: "Carol",
      label: "New identity",
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId: "bob" },
      revision: 1,
    });
    const input = {
      callId,
      id: "voice-final-turn",
      role: "user",
      content: "Remember my draft",
      timestamp: new Date().toISOString(),
      seatId: "forged",
      sessionKey: "agent:bob:main",
      actorName: "Forged",
    };
    const message = runtime.voice.finalize(input);
    expect(message).toMatchObject({
      source: "voice",
      seatId: "Carol",
      actorName: "Carol",
      sessionKey: "agent:carol:main",
      agentId: "carol",
      bindingRevision: 1,
      streaming: false,
    });
    const cursor = db.cursor();
    expect(runtime.voice.finalize(input)).toEqual(message);
    expect(db.cursor()).toBe(cursor);
    expect(() => runtime.voice.finalize({ ...input, content: "overwrite" })).toThrow(
      /already finalized/,
    );
    expect(() => runtime.voice.finalize({ ...input, callId: "unknown" })).toThrow(/not found/);
    const reopened = new TaskDatabase(path);
    try {
      expect(reopened.messages("agent:carol:main")).toContainEqual(message);
      expect(reopened.record("voiceCall", callId)).toMatchObject({
        agentId: "carol",
        bindingRevision: 1,
        sessionKey: "agent:carol:main",
      });
      expect(reopened.messages("agent:bob:main")).toHaveLength(0);
    } finally {
      reopened.close();
    }
    const history = await runtime.history("agent:carol:main");
    expect(history.messages).toContainEqual(message);
    const nextCall = runtime.voice.context({ seatId: "Carol", bindingRevision: 2 });
    expect(nextCall.conversation).toEqual([]);
  });

  it("links a persisted transcript to the task it creates without duplicating history", async () => {
    const { seat, runtime, db, submit } = await setup();
    seat("Carol", "carol");
    const callId = runtime.voice.createCall({ seatId: "Carol", bindingRevision: 1 });
    runtime.voice.finalize({
      callId,
      id: "voice-user",
      role: "user",
      content: "Draft a note",
      timestamp: new Date().toISOString(),
    });
    submit("voice-task", "Carol", { sourceMessageId: "voice-user" });
    expect(db.getMessage("voice-user").taskId).toBe("voice-task");
    expect(
      (await runtime.history("agent:carol:main")).messages.filter(
        (m: { role: string }) => m.role === "user",
      ),
    ).toHaveLength(1);
  });

  it("isolates shared workers' persisted conversation and rejects partial transcripts", async () => {
    const { seat, runtime } = await setup();
    seat("Alice", "main");
    seat("Bob", "main");
    const callId = runtime.voice.createCall({ seatId: "Alice", bindingRevision: 1 });
    expect(runtime.db.sessions()).toContainEqual(
      expect.objectContaining({ key: "agent:main:main" }),
    );
    const input = {
      callId,
      id: "shared-voice-turn",
      role: "user",
      content: "Alice only",
      timestamp: new Date().toISOString(),
    };
    expect(() => runtime.voice.finalize({ ...input, streaming: true })).toThrow(/finalized/);
    runtime.voice.finalize(input);
    expect(runtime.voice.context({ seatId: "Alice", bindingRevision: 1 }).conversation).toEqual([
      { role: "user", text: "Alice only" },
    ]);
    expect(runtime.voice.context({ seatId: "Bob", bindingRevision: 1 }).conversation).toEqual([]);
  });

  it("uses actual installed contracts, including validator-export aliases", () => {
    const audit = new ContractAudit(fixture);
    expect(audit.results["chat.send"].available).toBe(true);
    expect(audit.results["chat.abort"].available).toBe(true);
    expect(audit.results["agent.wait"].available).toBe(true);
    expect(audit.results["question.resolve"].available).toBe(true);
    expect(audit.roleCompareAndSet).toBe(true);
    expect(audit.validate("chat.send", { message: "invalid" })).toBe(false);
  });
  it("snapshots Carol's backend identity and rejects a foreign or stale conversation", async () => {
    const { seat, submit, gateway, db, runtime } = await setup();
    seat("Carol", "carol");
    const task = submit("task-carol", "Carol");
    expect(task).toMatchObject({
      taskId: "task-carol",
      agentId: "carol",
      runId: null,
      sessionKey: "agent:carol:main",
      bindingRevision: 1,
    });
    expect(gateway.pending[0].params).toMatchObject({
      agentId: "carol",
      sessionKey: "agent:carol:main",
      idempotencyKey: "task-carol",
    });
    expect(() => submit("bad-session", "Carol", { sessionKey: "agent:bob:main" })).toThrow(
      /another backend agent/,
    );
    expect(() => submit("stale-binding", "Carol", { bindingRevision: 0 })).toThrow(
      /binding changed/,
    );
    expect(() => runtime.saveSeat({ ...db.getSeat("Carol"), revision: 1, label: "Other" })).toThrow(
      /reconcile/,
    );
    gateway.pending[0].resolve({ runId: "backend-1" });
    await tick();
    expect(db.getTask("task-carol").runId).toBe("backend-1");
  });
  it("serializes shared-session work and runs independent sessions concurrently", async () => {
    const { seat, submit, gateway, db } = await setup();
    seat("Worker1", "main");
    seat("Worker2", "main");
    seat("Carol", "carol");
    submit("shared-1", "Worker1");
    submit("shared-2", "Worker2");
    submit("independent-1", "Carol");
    expect(gateway.pending).toHaveLength(2);
    expect(db.getTask("shared-2").status).toBe("queued");
    gateway.pending[0].resolve({ runId: "run-shared" });
    gateway.pending[1].resolve({ runId: "run-carol" });
    await tick();
    final(gateway, "run-shared", "agent:main:main");
    await tick();
    expect(gateway.pending).toHaveLength(3);
    expect(gateway.pending[2].params.idempotencyKey).toBe("shared-2");
  });
  it("deduplicates HTTP retries and correlates a terminal event arriving before acknowledgement", async () => {
    const { seat, submit, gateway, db } = await setup();
    seat("Carol", "carol");
    submit("once", "Carol");
    submit("once", "Carol");
    expect(gateway.pending).toHaveLength(1);
    final(gateway, "early-run", "agent:carol:main");
    expect(db.getTask("once").runId).toBeNull();
    gateway.pending[0].resolve({ runId: "early-run" });
    await tick();
    expect(db.getTask("once")).toMatchObject({
      status: "completed",
      runId: "early-run",
      result: "Done",
    });
    final(gateway, "early-run", "agent:carol:main");
    expect(
      db
        .messages("agent:carol:main")
        .filter((message: { role: string }) => message.role === "assistant"),
    ).toHaveLength(1);
  });
  it("preserves streamed text without replaying duplicate deltas", async () => {
    const { seat, submit, gateway, db } = await setup();
    seat("Carol", "carol");
    submit("stream", "Carol");
    gateway.pending[0].resolve({ runId: "stream-run" });
    await tick();
    const delta = {
      runId: "stream-run",
      sessionKey: "agent:carol:main",
      state: "delta",
      seq: 1,
      deltaText: "Hello",
    };
    gateway.event(delta);
    gateway.event(delta);
    gateway.event({ ...delta, seq: 2, deltaText: " world" });
    expect(db.getMessage("assistant_stream").content).toBe("Hello world");
    final(gateway, "stream-run", "agent:carol:main", "final", 3);
    expect(db.getMessage("assistant_stream").content).toBe("Done");
  });
  it("holds ambiguous outcomes and never resends them or advances their lane", async () => {
    const { seat, submit, gateway, runtime, db } = await setup();
    seat("Worker", "main");
    submit("uncertain", "Worker");
    submit("later", "Worker");
    gateway.pending[0].reject(new Error("Timeout"));
    await tick();
    expect(db.getTask("uncertain").status).toBe("outcome_unknown");
    await runtime.reconcile();
    await runtime.pump();
    expect(gateway.pending).toHaveLength(1);
    expect(db.getTask("later").status).toBe("queued");
  });
  it("cancels unsent work locally and waits for remote cancellation confirmation", async () => {
    const { seat, submit, gateway, runtime, db } = await setup();
    seat("Worker", "main");
    submit("active", "Worker");
    submit("queued", "Worker");
    await runtime.cancel("queued");
    expect(db.getTask("queued").status).toBe("stopped");
    gateway.pending[0].resolve({ runId: "cancel-run" });
    await tick();
    await runtime.cancel("active");
    expect(db.getTask("active").status).toBe("cancel_requested");
    expect(gateway.calls.find((call) => call.method === "chat.abort")?.params).toMatchObject({
      agentId: "main",
      runId: "cancel-run",
    });
    final(gateway, "cancel-run", "agent:main:main", "aborted");
    expect(db.getTask("active").status).toBe("stopped");
  });
  it("recovers accepted runs after reconnect without duplicating execution", async () => {
    const { seat, submit, gateway, runtime, db } = await setup();
    seat("Worker", "main");
    submit("recover", "Worker");
    gateway.pending[0].resolve({ runId: "recover-run" });
    await tick();
    gateway.disconnect();
    expect(db.getTask("recover").status).toBe("outcome_unknown");
    gateway.status = "connected";
    gateway.results.set("recover-run", { runId: "recover-run", status: "ok" });
    await runtime.refresh();
    expect(db.getTask("recover").status).toBe("completed");
    expect(gateway.pending).toHaveLength(1);
  });
  it("rolls back task acceptance when the dispatch ledger cannot be written", async () => {
    const { seat, submit, db } = await setup();
    seat("Worker", "main");
    db.db.exec(
      "CREATE TRIGGER fail_ledger BEFORE INSERT ON dispatches BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    expect(() => submit("not-accepted", "Worker")).toThrow();
    expect(db.getTask("not-accepted")).toBeNull();
  });
  it("retains queued work across process restart and archives legacy work without sending it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-town-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "tasks.sqlite");
    const first = await setup(file);
    first.seat("Worker", "main");
    first.submit("ambiguous", "Worker");
    first.submit("pending", "Worker");
    first.runtime.close();
    first.db.close();
    cleanups.pop();
    const second = await setup(file);
    expect(second.db.getTask("ambiguous").status).toBe("outcome_unknown");
    expect(second.db.getTask("pending").status).toBe("queued");
    expect(second.gateway.pending).toHaveLength(0);
    second.runtime.importLegacy({
      id: "legacy",
      tasks: [
        { taskId: "legacy-task", message: "old", sessionKey: "agent:main:main", status: "queued" },
      ],
    });
    expect(second.db.getTask("legacy-task").status).toBe("outcome_unknown");
    expect(second.db.ledger("legacy-task")?.state).toBe("imported");
  });
});

describe("runtime HTTP and shared-device events", () => {
  it("shares committed tasks, replays event cursors, and rejects foreign origins", async () => {
    const { runtime, seat, gateway } = await setup();
    seat("Carol", "carol");
    const handler = createRuntimeHandler(runtime);
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { Origin: origin, "Content-Type": "application/json" };
    const selection = { seatId: "Carol", bindingRevision: 1 };
    const contextResponse = await fetch(`${origin}/api/runtime/voice/context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...selection, role: "Forged" }),
    });
    expect(contextResponse.status).toBe(200);
    expect(contextResponse.headers.get("cache-control")).toBe("no-store");
    expect((await contextResponse.json()).agent).toMatchObject({
      agentId: "carol",
      role: "AI teammate",
    });
    const staleContext = await fetch(`${origin}/api/runtime/voice/context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...selection, bindingRevision: 2 }),
    });
    expect(staleContext.status).toBe(409);
    const callId = runtime.voice.createCall(selection);
    const transcriptResponse = await fetch(`${origin}/api/runtime/voice/transcripts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        callId,
        id: "http-voice",
        role: "assistant",
        content: "Hello from Carol",
        timestamp: new Date().toISOString(),
      }),
    });
    expect(transcriptResponse.status).toBe(200);
    expect(runtime.db.getMessage("http-voice").actorName).toBe("Carol");
    const deniedTranscript = await fetch(`${origin}/api/runtime/voice/transcripts`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: "{}",
    });
    expect(deniedTranscript.status).toBe(403);
    const before = await (await fetch(`${origin}/api/runtime/state`)).json();
    const input = {
      taskId: "http-task",
      seatId: "Carol",
      bindingRevision: 1,
      sessionKey: "agent:carol:main",
      message: "Draft a note",
    };
    const response = await fetch(`${origin}/api/runtime/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(202);
    const acceptedTask = (await response.json()).task;
    expect(acceptedTask.agentId).toBe("carol");
    expect(
      assignedOperationTask({
        incidentId: "phase0-incident",
        requester: { kind: "user" },
        role: "research",
        task: acceptedTask,
      }),
    ).toMatchObject({
      taskId: "http-task",
      status: "queued",
      assignment: {
        runtimeTaskId: "http-task",
        seatId: "Carol",
        agentId: "carol",
        bindingRevision: 1,
        sessionKey: "agent:carol:main",
      },
    });
    const voiceProgress = {
      callId,
      actionId: "http-progress",
      tool: "get_task_progress",
      args: { taskId: "http-task" },
    };
    const progress = await fetch(`${origin}/api/runtime/voice/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify(voiceProgress),
    });
    expect(progress.status).toBe(200);
    expect(progress.headers.get("cache-control")).toBe("no-store");
    expect((await progress.json()).task.status).toBe("submitted");
    const forbiddenAction = await fetch(`${origin}/api/runtime/voice/actions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...voiceProgress, tool: "approval.resolve" }),
    });
    expect(forbiddenAction.status).toBe(400);
    const foreignAction = await fetch(`${origin}/api/runtime/voice/actions`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: JSON.stringify(voiceProgress),
    });
    expect(foreignAction.status).toBe(403);
    const retry = await fetch(`${origin}/api/runtime/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(retry.status).toBe(202);
    expect(gateway.pending).toHaveLength(1);
    const anotherDevice = await (await fetch(`${origin}/api/runtime/state`)).json();
    expect(anotherDevice.tasks[0].taskId).toBe("http-task");
    expect(anotherDevice.seats[0].binding.available).toBe(true);
    const replay = await fetch(`${origin}/api/runtime/events`, {
      headers: { "Last-Event-ID": String(before.cursor) },
    });
    const reader = replay.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('"kind":"task"');
    expect(frame).toContain('"taskId":"http-task"');
    await reader.cancel();
    const denied = await fetch(`${origin}/api/runtime/tasks`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example" },
      body: JSON.stringify(input),
    });
    expect(denied.status).toBe(403);
    const invalid = await fetch(`${origin}/api/runtime/tasks`, {
      method: "POST",
      headers,
      body: "{bad",
    });
    expect(invalid.status).toBe(400);
    gateway.pending[0].resolve({ runId: "http-run" });
    await tick();
    final(gateway, "http-run", "agent:carol:main");
    const finalResponse = await fetch(`${origin}/api/runtime/tasks/http-task`);
    expect(finalResponse.status).toBe(200);
    const finalTask = (await finalResponse.json()).task;
    expect(finalTask).toMatchObject({ taskId: "http-task", status: "completed", result: "Done" });
    const historyResponse = await fetch(
      `${origin}/api/runtime/history?sessionKey=${encodeURIComponent("agent:carol:main")}`,
    );
    expect(historyResponse.status).toBe(200);
    expect((await historyResponse.json()).messages).toContainEqual(
      expect.objectContaining({ taskId: "http-task", role: "assistant", content: "Done" }),
    );
    expect(
      assignedOperationTask({
        incidentId: "phase0-incident",
        requester: { kind: "user" },
        role: "research",
        task: finalTask,
      }),
    ).toMatchObject({ status: "completed", assignment: { runtimeTaskId: "http-task" } });
  });
  it("keeps a cancelled unacknowledged dispatch attached to its eventual backend run", async () => {
    const { seat, submit, runtime, db, gateway } = await setup();
    seat("Worker", "main");
    submit("cancel-before-ack", "Worker");
    await runtime.cancel("cancel-before-ack");
    gateway.pending[0].resolve({ runId: "late-ack" });
    await tick();
    expect(gateway.calls.find((call) => call.method === "chat.abort")?.params.runId).toBe(
      "late-ack",
    );
    expect(db.getTask("cancel-before-ack").status).toBe("cancel_requested");
    final(gateway, "late-ack", "agent:main:main");
    expect(db.getTask("cancel-before-ack").status).toBe("completed");
  });
  it("preserves outstanding session ownership when terminal recovery cannot be verified", async () => {
    const { seat, submit, runtime, db, gateway } = await setup();
    seat("Worker", "main");
    submit("not-proven", "Worker");
    gateway.pending[0].resolve({ runId: "unverified-run" });
    await tick();
    gateway.results.set("unverified-run", { runId: "some-other-run", status: "ok" });
    await runtime.reconcile();
    expect(db.getTask("not-proven").status).toBe("outcome_unknown");
  });
});

describe("binding and role safeguards", () => {
  it("uses the same resolved conversation for text and voice when shared workers switch", async () => {
    const { seat } = await setup();
    const worker = seat("Worker", "main");
    const carol = seat("Carol", "carol");
    expect(boundConversationSession(worker, "agent:main:new-conversation")).toBe(
      "agent:main:new-conversation",
    );
    expect(boundConversationSession(carol, "agent:main:new-conversation")).toBe("agent:carol:main");
    expect(boundConversationSession(carol, "agent:carol:new-conversation")).toBe(
      "agent:carol:new-conversation",
    );
    expect(boundConversationSession(undefined, "agent:main:main")).toBeUndefined();
  });
  it("previews an explicit role update, preserves other instructions, and rejects stale hashes", async () => {
    const { seat, runtime, db, gateway } = await setup();
    seat("Carol", "carol");
    runtime.saveSeat({ ...db.getSeat("Carol"), revision: 1, roleTitle: "Researcher" });
    const preview = await runtime.applyRole("Carol", 2);
    expect(preview.proposed).toContain("Existing backend instructions.");
    expect(preview.proposed).toContain("Role: Researcher");
    expect(gateway.calls.filter((call) => call.method === "agents.files.set")).toHaveLength(0);
    await runtime.applyRole("Carol", 2, preview.hash);
    expect(gateway.file).toBe(preview.proposed);
    const next = await runtime.applyRole("Carol", 2);
    gateway.file += "Changed elsewhere.\n";
    await expect(runtime.applyRole("Carol", 2, next.hash)).rejects.toThrow(/instructions changed/);
    expect(gateway.file).toContain("Changed elsewhere.");
  });
  it("rejects a second dispatcher owner and releases ownership on clean shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-town-owner-"));
    const file = join(dir, "owner.sqlite");
    const one = new TaskDatabase(file);
    const two = new TaskDatabase(file);
    try {
      one.acquireOwner();
      expect(() => two.acquireOwner()).toThrow(/Another Agent Town process/);
      one.close();
      two.acquireOwner();
    } finally {
      two.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dedicated seat conversations", () => {
  it("persists seat ownership and prevents routing to another worker on the same backend", async () => {
    const { runtime, seat, db, submit } = await setup();
    seat("Alice", "main");
    seat("Bob", "main");
    const alice = runtime.newSession("Alice");
    const bob = runtime.newSession("Bob");
    expect(alice.key).not.toBe(bob.key);
    expect(db.sessions().find((s) => s.key === alice.key)?.seatId).toBe("Alice");
    expect(() => submit("wrong-seat", "Bob", { sessionKey: alice.key })).toThrow(
      /another office seat/,
    );
    submit("alice-private", "Alice", { sessionKey: alice.key });
    expect(db.getTask("alice-private").sessionKey).toBe(alice.key);
    expect(db.messages(bob.key)).toEqual([]);
    expect(db.taskEvents("alice-private").every((e) => e.data.taskId === "alice-private")).toBe(
      true,
    );
  });
});
