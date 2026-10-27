import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";

// Dynamic wire fixtures are validated against the installed JSON schemas in Gateway.request.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
const rejected = () => Object.assign(new Error("Mock gateway rejection"), { rejected: true });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (data: Data) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Data>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});

// Reuse compiled fixture schemas; each gateway still owns its mutable execution state.
const fixtureAudit = new ContractAudit(fixture);
class Gateway {
  audit = fixtureAudit;
  provider = "openclaw";
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: {
      methods: Object.keys(CONTRACTS),
      events: ["session.approval", "question.requested", "question.resolved", "agent", "chat"],
    },
  };
  listeners = new Set<(kind: string, data: unknown) => void>();
  calls: Array<{ method: string; params: Data }> = [];
  agents: Data[] = [
    { id: "main", name: "Shared" },
    { id: "carol", name: "Carol", workspace: "/carol", model: { primary: "fixture/one" } },
  ];
  sessions: Data[] = [
    {
      key: "agent:main:main",
      sessionId: "s-main",
      lifecycleRevision: "life-main",
      model: "one",
      modelProvider: "fixture",
    },
    {
      key: "agent:carol:main",
      sessionId: "s-carol",
      lifecycleRevision: "life-carol",
      model: "one",
      modelProvider: "fixture",
    },
  ];
  questions: Data[] = [];
  approvals = new Map<string, Data>();
  overrides = new Map<string, (params: Data) => unknown>();
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
  event(event: string, payload: Data) {
    for (const fn of this.listeners) fn("event", { event, payload });
  }
  disconnect() {
    this.status = "disconnected";
    for (const fn of this.listeners) fn("status", this.status);
  }
  async request(method: string, params: Data) {
    if (!this.capabilities()[method]?.available || !this.audit.validate(method, params))
      throw rejected();
    this.calls.push({ method, params });
    if (this.overrides.has(method)) return this.overrides.get(method)!(params);
    if (method === "agents.list")
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: structuredClone(this.agents),
      };
    if (method === "sessions.list") return { sessions: structuredClone(this.sessions) };
    if (method === "sessions.messages.subscribe")
      return {
        subscribed: true,
        key: params.key,
        approvalReplay: {
          sessionKey: params.key,
          updatedAtMs: Date.now(),
          approvals: [...this.approvals.values()].filter(
            (item) => item.sourceSessionKey === params.key && item.status === "pending",
          ),
          truncated: false,
        },
      };
    if (method === "question.list") return { questions: structuredClone(this.questions) };
    if (method === "question.get")
      return { question: this.questions.find((question) => question.id === params.id) };
    if (method === "approval.get") return { approval: this.approvals.get(params.id) };
    if (method === "chat.send") return { runId: `run-${params.idempotencyKey}` };
    if (method === "chat.history") return { messages: [], sessionInfo: {} };
    if (method === "agent.wait") return { runId: params.runId, status: "timeout" };
    if (method === "models.list")
      return {
        models: [
          { id: "one", provider: "fixture", name: "Model one" },
          { id: "two", provider: "fixture", name: "Model two" },
        ],
      };
    if (method === "agents.create") {
      const agent = { id: "new-agent", name: params.name, workspace: params.workspace ?? "/new" };
      this.agents.push(agent);
      return { ok: true, agentId: agent.id, name: agent.name, workspace: agent.workspace };
    }
    if (method === "agents.update") {
      const agent = this.agents.find((agent) => agent.id === params.agentId)!;
      for (const field of ["name", "workspace", "model"])
        if (field in params)
          agent[field] =
            field === "model"
              ? params.model
                ? { primary: params.model }
                : undefined
              : params[field];
      return { ok: true, agentId: params.agentId };
    }
    if (method === "sessions.patch") {
      const session = this.sessions.find((session) => session.key === params.key)!;
      const model = params.model?.split("/");
      session.model = model?.slice(1).join("/") ?? "one";
      session.modelProvider = model?.[0] ?? "fixture";
      session.modelOverride = model?.slice(1).join("/");
      session.providerOverride = model?.[0];
      return { ok: true, key: session.key, entry: { ...session } };
    }
    return { ok: true };
  }
  count(method: string) {
    return this.calls.filter((call) => call.method === method).length;
  }
}

function approval(id = "approval-1", extra: Data = {}) {
  return {
    id,
    urlPath: `/approval/${id}`,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60000,
    presentation: {
      kind: "exec",
      commandText: "echo exact requested action",
      agentId: "carol",
      allowedDecisions: ["allow-once", "deny"],
    },
    status: "pending",
    ...extra,
  };
}
function question(id = "question-1", extra: Data = {}) {
  return {
    id,
    questions: [
      {
        questionId: "target",
        header: "Target",
        question: "Which environment?",
        options: [
          { label: "Staging", value: "stage" },
          { label: "Production", value: "prod" },
        ],
      },
    ],
    agentId: "carol",
    sessionKey: "agent:carol:main",
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60000,
    status: "pending",
    ...extra,
  };
}
async function setup(path = ":memory:", gateway = new Gateway()) {
  const db = new TaskDatabase(path);
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "fixture-gateway" });
  await runtime.refresh();
  const seat = (id = "Carol", agentId = "carol") =>
    runtime.saveSeat({
      seatId: id,
      label: id,
      assigned: true,
      seatType: agentId === "main" ? "worker" : "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  const submit = (taskId: string, seatId = "Carol", extra: Data = {}) =>
    runtime.submit({
      taskId,
      seatId,
      message: "Do fixture work",
      bindingRevision: db.getSeat(seatId).binding.revision,
      ...extra,
    });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      runtime.close();
      db.close();
    }
  };
  cleanups.push(close);
  const emitApproval = (value: Data) => {
    gateway.approvals.set(value.id, value);
    gateway.event("session.approval", {
      sessionKey: "agent:carol:main",
      updatedAtMs: Date.now(),
      phase: value.status === "pending" ? "pending" : "terminal",
      approval: value,
    });
    return runtime.reviews.items().find((item: Data) => item.backendId === value.id)!;
  };
  return { db, gateway, runtime, seat, submit, close, emitApproval };
}

describe("confirmed cancellation", () => {
  it("keeps acknowledged cancellation idempotent across clients, refresh and restart, holding the lane", async () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-cancel-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const a = await setup(path);
    a.seat();
    a.submit("one");
    a.submit("two");
    await tick();
    await Promise.all([a.runtime.cancel("one"), a.runtime.cancel("one")]);
    expect(a.db.getTask("one").status).toBe("cancel_requested");
    expect(a.gateway.count("chat.abort")).toBe(1);
    expect(a.db.getTask("two").status).toBe("queued");
    await a.runtime.refresh();
    expect(a.db.getTask("one").status).toBe("outcome_unknown");
    a.close();
    const b = await setup(path);
    await b.runtime.cancel("one");
    expect(b.gateway.count("chat.abort")).toBe(0);
    expect(b.db.getTask("two").status).toBe("queued");
    b.gateway.event("chat", {
      runId: "run-one",
      sessionKey: "agent:carol:main",
      state: "aborted",
      seq: 1,
    });
    await tick();
    expect(b.db.getTask("one").status).toBe("stopped");
    expect(b.gateway.count("chat.send")).toBe(1);
  }, 10000);
  it("shows rejection without stopped, permits an explicit versioned retry, and preserves late terminal evidence", async () => {
    const { runtime, gateway, db, seat, submit } = await setup();
    seat();
    submit("one");
    submit("two");
    await tick();
    gateway.overrides.set("chat.abort", () => {
      throw rejected();
    });
    await runtime.cancel("one");
    expect(db.getTask("one")).toMatchObject({ status: "running", cancelState: "rejected" });
    expect(db.getTask("one").cancellationError).toMatch(/rejected/);
    await runtime.cancel("one");
    expect(gateway.count("chat.abort")).toBe(1);
    await expect(runtime.cancel("one", { retry: true, expectedAttempt: 0 })).rejects.toThrow(
      /changed/,
    );
    const late = deferred();
    gateway.overrides.set("chat.abort", () => late.promise);
    const retry = runtime.cancel("one", { retry: true, expectedAttempt: 1 });
    gateway.event("chat", {
      runId: "run-one",
      sessionKey: "agent:carol:main",
      state: "final",
      seq: 1,
    });
    late.reject(rejected());
    await retry;
    await tick();
    expect(db.getTask("one").status).toBe("completed");
    expect(gateway.count("chat.send")).toBe(2);
  });
  it("preserves ambiguous cancellation and locally cancels undispatched work without an abort RPC", async () => {
    const { runtime, gateway, db, seat, submit } = await setup();
    seat();
    submit("one");
    submit("queued");
    await tick();
    await runtime.cancel("queued");
    expect(db.getTask("queued").status).toBe("stopped");
    expect(gateway.count("chat.abort")).toBe(0);
    submit("next");
    gateway.overrides.set("chat.abort", () => {
      throw new Error("Disconnected after send");
    });
    await runtime.cancel("one");
    expect(db.getTask("one").status).toBe("outcome_unknown");
    await runtime.cancel("one");
    expect(gateway.count("chat.abort")).toBe(1);
    expect(db.getTask("next").status).toBe("queued");
  });
  it("remembers cancellation before the dispatch acknowledgement and sends it once after run identity arrives", async () => {
    const { runtime, gateway, db, seat, submit } = await setup();
    seat();
    const send = deferred();
    gateway.overrides.set("chat.send", () => send.promise);
    submit("early");
    await runtime.cancel("early");
    await runtime.cancel("early");
    expect(gateway.count("chat.abort")).toBe(0);
    send.resolve({ runId: "actual-run" });
    await tick();
    expect(gateway.count("chat.abort")).toBe(1);
    expect(db.getTask("early").status).toBe("cancel_requested");
  });
});

describe("durable explicit user review", () => {
  it("releases a verified terminal task's lane even if an associated review has not emitted its resolution yet", async () => {
    const { runtime, gateway, seat, submit, db } = await setup();
    seat();
    submit("reviewed-task");
    await tick();
    submit("next-task");
    gateway.event("question.requested", question("lagging-review", { runId: "run-reviewed-task" }));
    expect(db.getTask("reviewed-task").status).toBe("waiting_question");
    expect(db.getTask("next-task").status).toBe("queued");
    gateway.event("chat", {
      runId: "run-reviewed-task",
      sessionKey: "agent:carol:main",
      state: "aborted",
      seq: 1,
    });
    await tick();
    expect(db.getTask("reviewed-task").status).toBe("stopped");
    expect(db.getTask("next-task").status).toBe("running");
    expect(runtime.reviews.items()[0].status).toBe("pending"); // No invented review decision.
  });
  it("claims a decision once, rejects conflicting duplicates, and handles the backend resolving it elsewhere", async () => {
    const { runtime, gateway, emitApproval } = await setup();
    const item = emitApproval(approval());
    const response = deferred();
    gateway.overrides.set("approval.resolve", () => response.promise);
    const input = { revision: item.revision, operationId: "decision-1", decision: "deny" };
    const first = runtime.reviews.decide(item.id, input);
    expect((await runtime.reviews.decide(item.id, input)).status).toBe("submitting");
    expect(gateway.count("approval.resolve")).toBe(1);
    await expect(
      runtime.reviews.decide(item.id, { ...input, decision: "allow-once" }),
    ).rejects.toThrow(/identifier/);
    await expect(
      runtime.reviews.decide(item.id, { ...input, operationId: "other-tab" }),
    ).rejects.toThrow(/already/);
    const terminal = approval("approval-1", {
      status: "denied",
      decision: "deny",
      reason: "user",
      resolvedAtMs: Date.now(),
    });
    response.resolve({ applied: false, approval: terminal });
    expect((await first).status).toBe("resolved");
    emitApproval(approval());
    expect(runtime.reviews.items()[0].status).toBe("resolved");
    expect(runtime.reviews.items()[0].decision).toEqual({ decision: "deny" });
  });
  it("permits only the verified decisions, rejects stale reviews, and expires requests", async () => {
    const { runtime, emitApproval, gateway } = await setup();
    const item = emitApproval(approval());
    await expect(
      runtime.reviews.decide(item.id, {
        revision: item.revision,
        operationId: "bad",
        decision: "allow-always",
      }),
    ).rejects.toThrow(/not permitted/);
    await expect(
      runtime.reviews.decide(item.id, { revision: 0, operationId: "stale", decision: "deny" }),
    ).rejects.toThrow(/changed/);
    const expired = emitApproval(approval("expired", { expiresAtMs: Date.now() - 1 }));
    await expect(
      runtime.reviews.decide(expired.id, {
        revision: expired.revision,
        operationId: "expired",
        decision: "deny",
      }),
    ).rejects.toThrow(/expired/);
    expect(gateway.count("approval.resolve")).toBe(0);
  });
  it("restores questions without approval listing, associates only the correct session, and keeps lanes held until terminal execution", async () => {
    const { runtime, gateway, seat, submit, db } = await setup();
    seat();
    seat("Worker", "main");
    submit("carol-task");
    submit("other-task", "Worker");
    await tick();
    gateway.questions = [question("recover", { runId: "run-carol-task" })];
    await runtime.refresh();
    expect(runtime.connection().capabilities["exec.approval.list"].available).toBe(false);
    expect(gateway.count("exec.approval.list")).toBe(0);
    const item = runtime.reviews.items()[0];
    expect(item).toMatchObject({ taskId: "carol-task", sessionKey: "agent:carol:main" });
    expect(db.getTask("other-task").status).not.toBe("waiting_question");
    gateway.event("question.resolved", {
      id: "recover",
      status: "answered",
      answers: { answers: { target: ["stage"] } },
    });
    expect(runtime.reviews.items()[0].status).toBe("resolved");
    submit("next");
    expect(db.getTask("next").status).toBe("queued"); // Decision is not terminal task evidence.
  });
  it("does not resend an ambiguous decision after restart and confirms it through verified recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "phase2-review-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const a = await setup(path);
    a.gateway.questions = [question()];
    await a.runtime.refresh();
    const item = a.runtime.reviews.items()[0];
    a.gateway.overrides.set("question.resolve", () => {
      throw new Error("Timeout after send");
    });
    const input = {
      revision: item.revision,
      operationId: "answer-1",
      answers: { target: ["stage"] },
    };
    expect((await a.runtime.reviews.decide(item.id, input)).status).toBe("outcome_unknown");
    a.close();
    const gateway = new Gateway();
    gateway.questions = [question()];
    const b = await setup(path, gateway);
    await b.runtime.reviews.decide(item.id, input);
    expect(gateway.count("question.resolve")).toBe(0);
    expect(b.runtime.reviews.items()[0].status).toBe("outcome_unknown");
    gateway.questions = [
      question("question-1", { status: "answered", answers: { answers: { target: ["stage"] } } }),
    ];
    await b.runtime.refresh();
    expect(b.runtime.reviews.items()[0].status).toBe("resolved");
  });
  it("rejects unsupported question choices and prevents secret answers from entering SQLite", async () => {
    const { runtime, gateway } = await setup();
    gateway.questions = [question()];
    await runtime.refresh();
    let item = runtime.reviews.items()[0];
    await expect(
      runtime.reviews.decide(item.id, {
        revision: item.revision,
        operationId: "forged",
        answers: { target: ["arbitrary"] },
      }),
    ).rejects.toThrow(/permitted/);
    gateway.questions = [
      question("secret", {
        questions: [
          {
            questionId: "key",
            header: "Key",
            question: "Enter secret",
            options: [],
            isSecret: true,
          },
        ],
      }),
    ];
    await runtime.refresh();
    item = runtime.reviews.items().find((item: Data) => item.backendId === "secret");
    await expect(
      runtime.reviews.decide(item.id, {
        revision: item.revision,
        operationId: "secret-answer",
        answers: { key: ["DO-NOT-SAVE"] },
      }),
    ).rejects.toThrow(/secure/);
    expect(JSON.stringify(runtime.reviews.items())).not.toContain("DO-NOT-SAVE");
    expect(gateway.count("question.resolve")).toBe(0);
  });
  it("fails closed for invalid or unadvertised events and missing permissions", async () => {
    const { runtime, gateway } = await setup();
    gateway.event("question.requested", { id: "invalid" });
    expect(runtime.reviews.items()).toHaveLength(0);
    gateway.hello.auth.scopes = [];
    gateway.event("question.requested", question());
    expect(runtime.reviews.items()).toHaveLength(0);
    expect(gateway.capabilities().questions.available).toBe(false);
    gateway.hello.auth.scopes = ["operator.questions"];
    gateway.hello.features.events = [];
    gateway.event("question.requested", question());
    expect(runtime.reviews.items()).toHaveLength(0);
  });
});

describe("gateway-backed management", () => {
  it("holds ambiguous session configuration until explicit override evidence is available", async () => {
    const { runtime, gateway, seat, submit, db } = await setup();
    seat();
    const session = await runtime.management.session("agent:carol:main", "carol");
    gateway.overrides.set("sessions.patch", () => {
      throw new Error("Reply lost");
    });
    const input = {
      operationId: "session-unknown",
      method: "sessions.patch",
      params: { key: session.key, agentId: "carol", model: "fixture/two" },
      configRevision: session.configRevision,
    };
    expect((await runtime.management.mutate(input)).status).toBe("outcome_unknown");
    gateway.sessions[1].model = "two";
    await runtime.refresh();
    expect(runtime.management.busySession(session.key)).toBe(true);
    submit("held-by-config");
    await tick();
    expect(db.getTask("held-by-config").status).toBe("queued");
    expect(gateway.count("chat.send")).toBe(0);
    gateway.sessions[1].modelOverride = "two";
    gateway.sessions[1].providerOverride = "fixture";
    await runtime.refresh();
    await tick();
    expect(runtime.management.busySession(session.key)).toBe(false);
    expect(gateway.count("chat.send")).toBe(1);
    expect(gateway.count("sessions.patch")).toBe(1);
  });
  it("never creates on discovery, creates only on explicit mutation, and deduplicates retries", async () => {
    const { runtime, gateway } = await setup();
    await runtime.refresh();
    expect(gateway.count("agents.create")).toBe(0);
    const input = {
      operationId: "create-explicit",
      method: "agents.create",
      params: { name: "New agent", workspace: "/new" },
    };
    expect((await runtime.management.mutate(input)).status).toBe("confirmed");
    await runtime.management.mutate(input);
    expect(gateway.count("agents.create")).toBe(1);
    expect(
      runtime.management.snapshot().agents.some((agent: Data) => agent.agentId === "new-agent"),
    ).toBe(true);
    await expect(
      runtime.management.mutate({ ...input, params: { name: "Another" } }),
    ).rejects.toThrow(/already used/);
  });
  it("rejects stale configuration and edits with outstanding work, then refreshes confirmed state", async () => {
    const { runtime, gateway, seat, submit } = await setup();
    const agent = runtime.management
      .snapshot()
      .agents.find((agent: Data) => agent.agentId === "carol");
    gateway.agents[1].name = "Changed elsewhere";
    await expect(
      runtime.management.mutate({
        operationId: "stale",
        method: "agents.update",
        configRevision: agent.configRevision,
        params: { agentId: "carol", name: "Overwrite" },
      }),
    ).rejects.toThrow(/changed/);
    const fresh = runtime.management
      .snapshot()
      .agents.find((agent: Data) => agent.agentId === "carol");
    expect(
      (
        await runtime.management.mutate({
          operationId: "fresh",
          method: "agents.update",
          configRevision: fresh.configRevision,
          params: { agentId: "carol", name: "Confirmed name", model: "fixture/two" },
        })
      ).status,
    ).toBe("confirmed");
    expect(
      runtime.management.snapshot().agents.find((agent: Data) => agent.agentId === "carol"),
    ).toMatchObject({ name: "Confirmed name", model: "fixture/two" });
    seat();
    submit("busy");
    await tick();
    await expect(
      runtime.management.mutate({
        operationId: "unsafe",
        method: "agents.update",
        params: { agentId: "carol", workspace: "/unsafe" },
      }),
    ).rejects.toThrow(/outstanding/);
  });
  it("labels model listings unverified, separates defaults and session overrides, and enforces session ownership", async () => {
    const { runtime, gateway } = await setup();
    expect(
      (await runtime.management.models("carol")).models.every(
        (model: Data) => model.verification === "listed_unverified",
      ),
    ).toBe(true);
    const current = await runtime.management.session("agent:carol:main", "carol");
    await expect(runtime.management.session("agent:main:main", "carol")).rejects.toThrow(/another/);
    const change = {
      operationId: "session-change",
      method: "sessions.patch",
      configRevision: current.configRevision,
      params: { key: "agent:carol:main", agentId: "carol", model: "fixture/two" },
    };
    expect((await runtime.management.mutate(change)).status).toBe("confirmed");
    expect(gateway.agents[1].model.primary).toBe("fixture/one");
    expect(gateway.calls.find((call) => call.method === "sessions.patch")?.params).toMatchObject({
      expectedSessionId: "s-carol",
      expectedLifecycleRevision: "life-carol",
    });
    await expect(
      runtime.management.mutate({
        ...change,
        operationId: "stale-session",
        params: { ...change.params, model: "fixture/one" },
      }),
    ).rejects.toThrow(/changed/);
    const fresh = await runtime.management.session("agent:carol:main", "carol");
    expect(
      (
        await runtime.management.mutate({
          operationId: "inherit",
          method: "sessions.patch",
          configRevision: fresh.configRevision,
          params: { key: current.key, agentId: "carol", model: null },
        })
      ).status,
    ).toBe("confirmed");
  });
  it("holds an ambiguous configuration mutation without repeating it and reconciles observed agent changes", async () => {
    const { runtime, gateway, seat, submit, db } = await setup();
    seat();
    const agent = runtime.management
      .snapshot()
      .agents.find((agent: Data) => agent.agentId === "carol");
    gateway.overrides.set("agents.update", () => {
      throw new Error("Lost reply");
    });
    const input = {
      operationId: "uncertain",
      method: "agents.update",
      configRevision: agent.configRevision,
      params: { agentId: "carol", name: "Desired" },
    };
    expect((await runtime.management.mutate(input)).status).toBe("outcome_unknown");
    await runtime.management.mutate(input);
    expect(gateway.count("agents.update")).toBe(1);
    expect(() => submit("held")).toThrow(/binding changed/);
    expect(db.activeTasks()).toHaveLength(0);
    gateway.agents[1].name = "Desired";
    await runtime.refresh();
    expect(runtime.management.busyAgent("carol")).toBe(false);
  });
  it("prevents concurrent clients from editing during a mutation and preserves unsupported capabilities", async () => {
    const { runtime, gateway, seat, submit } = await setup();
    seat();
    const agent = runtime.management
      .snapshot()
      .agents.find((agent: Data) => agent.agentId === "carol");
    const response = deferred();
    gateway.overrides.set("agents.update", () => response.promise);
    const first = runtime.management.mutate({
      operationId: "tab-one",
      method: "agents.update",
      configRevision: agent.configRevision,
      params: { agentId: "carol", name: "Updated" },
    });
    await tick();
    await expect(
      runtime.management.mutate({
        operationId: "tab-two",
        method: "agents.update",
        configRevision: agent.configRevision,
        params: { agentId: "carol", name: "Other" },
      }),
    ).rejects.toThrow(/pending/);
    expect(() => submit("during-edit")).toThrow();
    response.reject(rejected());
    expect((await first).status).toBe("rejected");
    gateway.hello.features.methods = gateway.hello.features.methods.filter(
      (method) => method !== "models.list" && method !== "agents.create",
    );
    await expect(runtime.management.models("carol")).rejects.toThrow(/advertise/);
    await expect(
      runtime.management.mutate({
        operationId: "unsupported",
        method: "agents.create",
        params: { name: "No" },
      }),
    ).rejects.toThrow(/advertise/);
  });
});
