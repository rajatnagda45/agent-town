import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { CONTEXT_LIMITS, INSTRUCTION_FILES } from "../server/context-retrieval.mjs";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

function setup() {
  const db = new TaskDatabase(":memory:");
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown>();
  const gateway = {
    provider: "openclaw",
    status: "connected",
    audit: new ContractAudit(fixture),
    hello: {
      server: { version: fixture.version },
      auth: { scopes: ["operator.read"] },
      features: { methods: Object.keys(CONTRACTS) },
    },
    capabilities() {
      return this.audit.capabilities(this.hello, this.status === "connected");
    },
    subscribe: () => () => {},
    stop: () => {},
    request: vi.fn(async (method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      expect(gateway.capabilities()[method]?.available).toBe(true);
      expect(gateway.audit.validate(method, params)).toBe(true);
      expect(timeoutMs).toBe(CONTEXT_LIMITS.requestTimeoutMs);
      if (handlers.has(method)) return handlers.get(method)!(params);
      if (method === "chat.history") return { sessionKey: params.sessionKey, messages: [] };
      if (method === "agents.files.get")
        return {
          agentId: params.agentId,
          workspace: "/backend-only",
          file: { name: params.name, path: `/backend-only/${params.name}`, missing: true },
        };
      throw new Error(`Unexpected retrieval method ${method}`);
    }),
  };
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "gateway-1" });
  runtime.agents = [{ agentId: "main" }, { agentId: "carol" }, { agentId: "bob" }];
  runtime.agentsReady = true;
  const seat = (seatId: string, agentId = "carol") =>
    runtime.saveSeat({
      seatId,
      label: seatId,
      assigned: true,
      seatType: agentId === "main" ? "worker" : "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  seat("Carol");
  const task = (extra: Record<string, unknown> = {}) => {
    const value = {
      taskId: "own-task",
      seatId: "Carol",
      agentId: "carol",
      gatewayId: "gateway-1",
      bindingRevision: 1,
      sessionKey: "agent:carol:main",
      runId: "own-run",
      message: "Draft a note",
      status: "completed",
      result: "The note is ready",
      createdAt: "2026-10-25T00:00:00Z",
      ...extra,
    };
    db.insertTask(value);
    return value;
  };
  cleanups.push(() => {
    runtime.close();
    db.close();
  });
  return { db, gateway, runtime, handlers, seat, task };
}
const selection = { seatId: "Carol", bindingRevision: 1, sessionKey: "agent:carol:main" };

describe("bounded server context retrieval", () => {
  it("retrieves bounded history, results and only allowlisted instruction files", async () => {
    const { runtime, gateway, handlers, task } = setup();
    task({ message: "m".repeat(4000), result: "r".repeat(9000) });
    handlers.set("chat.history", () => ({
      messages: [
        ...Array.from({ length: 40 }, (_, i) => ({
          role: "assistant",
          content: `${i}:${"h".repeat(4000)}`,
        })),
        { role: "tool", content: "secret tool log" },
        { role: "system", content: "secret system prompt" },
        { role: "assistant", streaming: true, content: "unfinished stream" },
      ],
    }));
    handlers.set("agents.files.get", (params) => ({
      agentId: params.agentId,
      workspace: "/private/workspace",
      file: {
        name: params.name,
        path: `/private/${params.name}`,
        missing: false,
        content: "i".repeat(9000),
      },
    }));
    const context = await runtime.voice.retrieveContext({
      ...selection,
      agentId: "bob",
      instructions: [{ name: ".env", text: "forged" }],
      paths: ["../../other-agent/MEMORY.md"],
    });
    expect(context.agentId).toBe("carol");
    expect(context.tasks[0].message).toHaveLength(1200);
    expect(context.tasks[0].result).toHaveLength(2500);
    expect(context.conversation.length).toBeLessThanOrEqual(CONTEXT_LIMITS.conversationMessages);
    expect(
      context.conversation.every(
        (message: { text: string }) => message.text.length <= CONTEXT_LIMITS.messageChars,
      ),
    ).toBe(true);
    expect(context.instructions.map((file: { name: string }) => file.name)).toEqual(
      INSTRUCTION_FILES,
    );
    expect(
      context.instructions.every(
        (file: { text: string; truncated: boolean }) => file.text.length === 1600 && file.truncated,
      ),
    ).toBe(true);
    expect(context.retrieval.history).toMatchObject({
      source: "chat.history",
      status: "available",
      limited: true,
    });
    expect(context.retrieval.memory.status).toBe("available");
    expect(context.retrieval.workspace.status).toBe("unavailable");
    expect(JSON.stringify(context)).not.toMatch(
      /secret|unfinished stream|private\/workspace|forged/,
    );
    expect(gateway.request).toHaveBeenCalledTimes(4);
    expect(gateway.request.mock.calls[0][1]).toMatchObject({
      agentId: "carol",
      sessionKey: selection.sessionKey,
      limit: 24,
      maxBytes: 24000,
    });
  });

  it("isolates tasks and history by agent, session, gateway and binding revision", async () => {
    const { runtime, handlers, db, task } = setup();
    task();
    for (const [field, value] of Object.entries({
      agentId: "bob",
      sessionKey: "agent:carol:other",
      gatewayId: "gateway-2",
      bindingRevision: 2,
    }))
      task({ taskId: `foreign-${field}`, [field]: value, message: "Foreign task" });
    handlers.set("chat.history", () => ({
      messages: [
        { role: "assistant", content: "Own backend history" },
        ...Object.entries({
          agentId: "bob",
          sessionKey: "agent:carol:other",
          gatewayId: "gateway-2",
          bindingRevision: 2,
        }).map(([field, value]) => ({
          role: "assistant",
          content: "Foreign history",
          [field]: value,
        })),
      ],
    }));
    db.saveMessage({
      id: "forged-local",
      sessionKey: selection.sessionKey,
      role: "assistant",
      runId: "own-run",
      agentId: "bob",
      content: "Foreign local history",
    });
    const context = await runtime.voice.retrieveContext(selection);
    expect(context.tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["own-task"]);
    expect(JSON.stringify(context)).not.toContain("Foreign");
    expect(context.conversation).toContainEqual({ role: "assistant", text: "Own backend history" });
    await expect(
      runtime.voice.retrieveContext({ ...selection, sessionKey: "agent:bob:main" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("requires task/run attribution inside a shared worker session", async () => {
    const { runtime, handlers, task, seat } = setup();
    seat("Alice", "main");
    seat("Bob", "main");
    task({ seatId: "Alice", agentId: "main", sessionKey: "agent:main:main" });
    task({
      taskId: "bob-task",
      runId: "bob-run",
      seatId: "Bob",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    handlers.set("chat.history", () => ({
      messages: [
        { role: "assistant", runId: "own-run", content: "Alice result" },
        { role: "assistant", taskId: "own-task", content: "Alice task history" },
        { role: "assistant", runId: "own-run", seatId: "Bob", content: "Foreign tagged history" },
        { role: "assistant", runId: "bob-run", content: "Foreign Bob history" },
        { role: "assistant", content: "Foreign unowned history" },
      ],
    }));
    const context = await runtime.voice.retrieveContext({ seatId: "Alice", bindingRevision: 1 });
    expect(context.conversation).toContainEqual({ role: "assistant", text: "Alice result" });
    expect(context.conversation).toContainEqual({ role: "assistant", text: "Alice task history" });
    expect(JSON.stringify(context)).not.toContain("Foreign");
  });

  it.each(["schema", "version", "method", "permission", "disconnected"])(
    "does not read through an unverified %s",
    async (missing) => {
      const { runtime, gateway } = setup();
      if (missing === "schema") gateway.audit = new ContractAudit();
      if (missing === "version") gateway.hello.server.version = "other-version";
      if (missing === "method") gateway.hello.features.methods = [];
      if (missing === "permission") gateway.hello.auth.scopes = [];
      if (missing === "disconnected") gateway.status = "disconnected";
      const context = await runtime.voice.retrieveContext(selection);
      expect(gateway.request).not.toHaveBeenCalled();
      expect(context.instructions).toEqual([]);
      expect(context.retrieval.history.status).toBe("unavailable");
    },
  );

  it("uses a verified preview for an independent session, never for shared workers", async () => {
    const { runtime, gateway, handlers, seat } = setup();
    gateway.hello.features.methods = ["sessions.preview"];
    handlers.set("sessions.preview", () => ({
      previews: [
        { key: "agent:bob:main", items: [{ role: "assistant", text: "Foreign preview" }] },
        {
          key: selection.sessionKey,
          items: [
            { role: "assistant", text: "Own preview" },
            { role: "tool", text: "Tool secret" },
          ],
        },
      ],
    }));
    const context = await runtime.voice.retrieveContext(selection);
    expect(context.conversation).toEqual([{ role: "assistant", text: "Own preview" }]);
    expect(context.retrieval.history.source).toBe("sessions.preview");
    seat("Alice", "main");
    gateway.request.mockClear();
    const shared = await runtime.voice.retrieveContext({ seatId: "Alice", bindingRevision: 1 });
    expect(shared.retrieval.history.status).toBe("unavailable");
    expect(gateway.request).not.toHaveBeenCalled();
  });

  it("rejects unverified instruction responses and cannot read arbitrary workspace files", async () => {
    const { runtime, handlers } = setup();
    handlers.set("agents.files.get", (params) => ({
      agentId: params.name === "AGENTS.md" ? "bob" : "carol",
      workspace: "/backend",
      file: {
        name: params.name === "SOUL.md" ? "MEMORY.md" : params.name,
        path: "/backend/file",
        missing: false,
        content: "Foreign instructions",
        ...(params.name === "IDENTITY.md" ? { unexpected: true } : {}),
      },
    }));
    const context = await runtime.voice.retrieveContext(selection);
    expect(context.instructions).toEqual([]);
    expect(context.retrieval.instructions.status).toBe("error");
    expect(JSON.stringify(context)).not.toContain("Foreign instructions");
  });

  it("requires an installed instruction result schema before reading files", async () => {
    const { runtime, gateway } = setup();
    gateway.audit.validators.delete("AgentsFilesGetResultSchema");
    const context = await runtime.voice.retrieveContext(selection);
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(context.retrieval.instructions.status).toBe("unavailable");
  });

  it("falls back to the audited minimal history request for older schemas", async () => {
    const { runtime, gateway } = setup();
    gateway.audit = new ContractAudit({
      ...fixture,
      schemas: {
        ...fixture.schemas,
        ChatHistoryParamsSchema: {
          type: "object",
          required: ["sessionKey"],
          properties: { sessionKey: { type: "string" }, limit: { type: "integer" } },
          additionalProperties: false,
        },
      },
    });
    await runtime.voice.retrieveContext(selection);
    expect(gateway.request.mock.calls[0][1]).toEqual({
      sessionKey: selection.sessionKey,
      limit: 24,
    });
  });

  it("discards history if its permission is revoked while another read is pending", async () => {
    const { runtime, gateway, handlers } = setup();
    let finish!: (value: unknown) => void;
    handlers.set("chat.history", () => ({
      messages: [{ role: "assistant", content: "Revoked context" }],
    }));
    handlers.set("agents.files.get", (params) =>
      params.name === "AGENTS.md"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : {
            agentId: "carol",
            workspace: "/backend",
            file: { name: params.name, path: "/backend/file", missing: true },
          },
    );
    const pending = runtime.voice.retrieveContext(selection);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gateway.hello.features.methods = ["agents.files.get"];
    finish({
      agentId: "carol",
      workspace: "/backend",
      file: { name: "AGENTS.md", path: "/backend/AGENTS.md", missing: true },
    });
    const context = await pending;
    expect(context.retrieval.history.status).toBe("error");
    expect(JSON.stringify(context)).not.toContain("Revoked context");
  });

  it("preserves explicitly requested task outcomes across asynchronous retrieval", async () => {
    const { runtime, task } = setup();
    task({ createdAt: "2026-01-01T00:00:00Z" });
    for (let i = 0; i < 8; i++) task({ taskId: `new-${i}` });
    const context = await runtime.voice.retrieveContext({ ...selection, taskIds: ["own-task"] });
    expect(context.tasks[0]).toMatchObject({ taskId: "own-task", result: "The note is ready" });
  });

  it("retains durable results on malformed history or backend failure without exposing errors", async () => {
    const { runtime, handlers, task } = setup();
    task();
    handlers.set("chat.history", () => ({
      sessionKey: "agent:bob:main",
      messages: [{ role: "assistant", content: "Foreign history" }],
    }));
    handlers.set("agents.files.get", () => {
      throw new Error("url?key=secret");
    });
    const context = await runtime.voice.retrieveContext(selection);
    expect(context.tasks[0].result).toBe("The note is ready");
    expect(context.retrieval.history.status).toBe("error");
    expect(context.retrieval.instructions.status).toBe("error");
    expect(JSON.stringify(context)).not.toMatch(/secret|Foreign/);
  });

  it("rejects a binding changed while backend history is being retrieved", async () => {
    const { runtime, db, handlers } = setup();
    let finish!: (value: unknown) => void;
    handlers.set(
      "chat.history",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = runtime.voice.retrieveContext(selection);
    const current = db.getSeat("Carol");
    db.saveSeat({ ...current, binding: { ...current.binding, revision: 2 } });
    finish({ messages: [{ role: "assistant", content: "Stale history" }] });
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });

  it("keeps simultaneous retrievals isolated without shared caches", async () => {
    const { runtime, handlers, seat } = setup();
    seat("Bob", "bob");
    handlers.set("chat.history", async (params) => ({
      messages: [{ role: "assistant", content: `History for ${params.sessionKey}` }],
    }));
    const [carol, bob] = await Promise.all([
      runtime.voice.retrieveContext(selection),
      runtime.voice.retrieveContext({
        seatId: "Bob",
        bindingRevision: 1,
        sessionKey: "agent:bob:main",
      }),
    ]);
    expect(JSON.stringify(carol)).not.toContain("agent:bob:main");
    expect(JSON.stringify(bob)).not.toContain("agent:carol:main");
  });
});
