import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import {
  OrchestrationService,
  type OrchestrationInput,
  type OrchestrationRegistry,
} from "../server/orchestration.mjs";
import type { EvidenceItem } from "../operations-contracts.mjs";
import { goalFingerprint } from "../server/deliverable-validation.mjs";

// All execution in this file uses a fake gateway. No live provider or Zetaris request occurs.
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
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    params: Record<string, string>;
  }> = [];
  subscribe(listener: (kind: string, data: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  capabilities() {
    return this.audit.capabilities(this.hello, this.status === "connected");
  }
  stop() {
    this.status = "disconnected";
  }
  request(method: string, params: Record<string, string>) {
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "bob" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.send")
      return new Promise((resolve, reject) => this.pending.push({ resolve, reject, params }));
    if (method === "agent.wait") return Promise.resolve({ status: "timeout", runId: params.runId });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    return Promise.resolve({ ok: true });
  }
  final(runId: string, sessionKey: string, result = "Evidence gathered") {
    const frame = {
      type: "event",
      event: "chat",
      payload: {
        runId,
        sessionKey,
        state: "final",
        seq: 1,
        message: { role: "assistant", content: [{ type: "text", text: result }] },
      },
    };
    for (const listener of this.listeners) listener("event", frame);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup()),
);

const incident = () => ({
  incidentId: "water-pressure-1",
  goal: "Explain the drop in water pressure with timestamped evidence",
  constraints: ["Read operational records only"],
  taskType: "maintenance-investigation",
  acceptanceCriteria: [{ criterionId: "cause", description: "Identify a supported cause" }],
  createdAt: "2026-10-25T00:00:00.000Z",
});
const request = (overrides: Partial<OrchestrationInput> = {}): OrchestrationInput => ({
  incident: incident(),
  maxParallelTasks: 2,
  tasks: [
    {
      taskId: "records",
      requester: { kind: "user" },
      role: "data-steward",
      message: "Inspect pump logs",
      maxRetries: 1,
    },
    {
      taskId: "analysis",
      requester: { kind: "user" },
      role: "analyst",
      message: "Compare pressure readings",
      dependencies: ["records"],
      requiredEvidenceFrom: ["records"],
    },
  ],
  ...overrides,
});

async function setup(filename = ":memory:") {
  const db = new TaskDatabase(filename);
  const gateway = new FakeGateway();
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "gateway-1" });
  await runtime.refresh();
  for (const [seatId, agentId] of [
    ["Alice", "main"],
    ["Bob", "bob"],
  ])
    if (!db.getSeat(seatId))
      runtime.saveSeat({
        seatId,
        label: seatId,
        assigned: true,
        seatType: agentId === "main" ? "worker" : "agent",
        agentConfig: { agentId },
        revision: 0,
      });
  const evidenceItems = new Map<string, EvidenceItem>();
  const evidence = { get: (evidenceId: string) => evidenceItems.get(evidenceId) };
  const registry: OrchestrationRegistry = {
    dispatchOrchestration: ({ task, selection }) => {
      runtime.submit({
        taskId: task.taskId,
        message: task.message,
        seatId: selection.assignment.seatId,
        sessionKey: selection.assignment.sessionKey,
        bindingRevision: selection.assignment.bindingRevision,
      });
      return { status: "accepted", runtimeTaskId: task.taskId };
    },
    assign: ({ task }) => {
      const isAnalyst = task.role === "analyst";
      const seatId = isAnalyst ? "Bob" : "Alice";
      const agentId = isAnalyst ? "bob" : "main";
      return {
        manifest: {
          id: task.role,
          version: "1.0.0",
          source: "fixture-reviewed-template",
          provider: "openclaw",
          capabilities: [task.role],
          skills: [],
          tools: [],
          permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
          limits: { maxRetries: 2, maxParallelTasks: 2, maxRuntimeSeconds: 300, maxToolCalls: 10 },
        },
        assignment: {
          seatId,
          agentId,
          bindingRevision: db.getSeat(seatId).binding.revision,
          gatewayId: "gateway-1",
          sessionKey: `agent:${agentId}:main`,
        },
      };
    },
  };
  const orchestration = new OrchestrationService(runtime, { registry, evidence });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    orchestration.close();
    runtime.close();
    db.close();
  };
  cleanups.push(close);
  return { db, gateway, runtime, orchestration, evidenceItems, registry, close };
}

describe("Lane A orchestration with mocked gateway, registry, and evidence repository", () => {
  it("keeps invalid deliverables unresolved after restart and never releases their dependent task", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coordination-deliverable-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "tasks.sqlite");
    const first = await setup(filename);
    const input = request({
      tasks: [
        {
          taskId: "agenda",
          role: "data-steward",
          message: "Produce the requested agenda",
          deliverable: {
            id: "agenda",
            kind: "agenda",
            description: "30-minute review",
            minutes: 30,
          },
        },
        {
          taskId: "review",
          role: "analyst",
          message: "Independently review the agenda",
          dependencies: ["agenda"],
        },
      ],
    });
    const created = first.orchestration.create(input);
    const taskId = created.children[0].operation.taskId;
    expect(first.db.getTask(taskId).message).toContain(goalFingerprint(input.incident));
    first.db.updateTask(taskId, {
      status: "completed",
      result: JSON.stringify({
        goalFingerprint: goalFingerprint(input.incident),
        deliverableId: "agenda",
        status: "completed",
        content: "Meeting agenda",
        evidenceIds: [],
        uncertainty: [],
        agenda: [
          { title: "Review", minutes: 20 },
          { title: "Actions", minutes: 15 },
        ],
      }),
    });
    // One bounded repair is dispatched with the exact issue.
    const repairing = first.orchestration.reconcile(input.incident.incidentId);
    expect(repairing.children[0].attempts).toHaveLength(2);
    const repairTask = first.db.getTask(repairing.children[0].attempts[1].runtimeTaskId);
    expect(repairTask.message).toContain("Repair request");
    expect(repairTask.message).toContain("totals 35 minutes");
    first.db.updateTask(repairTask.taskId, {
      status: "completed",
      result: first.db.getTask(taskId).result,
    });
    const checked = first.orchestration.reconcile(input.incident.incidentId);
    expect(checked.status).toBe("unresolved");
    expect(checked.children[0].uncertainty).toContain("totals 35 minutes");
    expect(checked.children[1].attempts).toHaveLength(0);
    expect(first.orchestration.create(input).children[0].attempts).toHaveLength(2);
    first.close();
    const restarted = await setup(filename);
    const recovered = restarted.orchestration.reconcile(input.incident.incidentId);
    expect(recovered.status).toBe("unresolved");
    expect(recovered.children[0].attempts).toHaveLength(2);
    expect(recovered.children[1].attempts).toHaveLength(0);
    expect(restarted.gateway.pending).toHaveLength(0);
  });

  it("rejects cycles, stale assignments, and a forged requester before dispatch", async () => {
    const { orchestration, db, gateway } = await setup();
    expect(() =>
      orchestration.create(
        request({
          tasks: [
            { taskId: "a", role: "data-steward", message: "A", dependencies: ["b"] },
            { taskId: "b", role: "analyst", message: "B", dependencies: ["a"] },
          ],
        }),
      ),
    ).toThrow(/cycle/);
    expect(() =>
      orchestration.create(
        request({
          tasks: [{ taskId: "a", role: "data-steward", message: "A", dependencies: ["missing"] }],
        }),
      ),
    ).toThrow(/dependency does not exist/);
    expect(() =>
      orchestration.create(
        request({
          tasks: [
            {
              taskId: "a",
              role: "data-steward",
              message: "A",
              requester: {
                kind: "agent",
                seatId: "Bob",
                agentId: "main",
                bindingRevision: 1,
                gatewayId: "gateway-1",
                sessionKey: "agent:bob:main",
              },
            },
          ],
        }),
      ),
    ).toThrow(/assignment/i);
    expect(db.records("orchestration")).toEqual([]);
    expect(gateway.pending).toHaveLength(0);
  });

  it("records two verified agent identities, evidence, and a handoff before releasing analysis", async () => {
    const { orchestration, db, gateway, evidenceItems } = await setup();
    const created = orchestration.create(request());
    expect(created.incident).toEqual(incident());
    expect(created.children[0].phase).toMatch(/queued|running/);
    expect(created.children[1].phase).toBe("waiting");
    const records = created.children[0];
    expect(records.operation).toMatchObject({
      incidentId: "water-pressure-1",
      role: "data-steward",
      assignment: {
        seatId: "Alice",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
    expect(records.nodeId).toBe("records");
    expect(records.attempts[0].runtimeTaskId).toBe(records.operation.taskId);
    expect(records.operation.assignment!.runtimeTaskId).toBe(records.operation.taskId);
    await tick();
    expect(gateway.pending).toHaveLength(1);
    gateway.pending[0].resolve({ runId: "run-records" });
    await tick();
    gateway.final("run-records", "agent:main:main");
    await tick();
    expect(orchestration.get("water-pressure-1").children[1].phase).toBe("waiting_evidence");
    expect(gateway.pending).toHaveLength(1);
    const evidenceId = "pump-log-42";
    evidenceItems.set(evidenceId, {
      evidenceId,
      incidentId: "water-pressure-1",
      taskId: records.operation.taskId,
      source: "synthetic:pump_logs",
      recordId: "log-42",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60000).toISOString(),
      content: "Pump stopped at 14:00",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: records.operation.taskId,
      evidenceIds: [evidenceId],
    });
    await tick();
    expect(gateway.pending).toHaveLength(2);
    const plan = orchestration.get("water-pressure-1");
    const analysis = plan.children[1];
    expect(analysis.operation.assignment).toMatchObject({
      seatId: "Bob",
      agentId: "bob",
      sessionKey: "agent:bob:main",
    });
    expect(db.getTask(analysis.operation.assignment!.runtimeTaskId).agentId).toBe("bob");
    expect(plan.handoffs).toEqual([
      expect.objectContaining({
        fromTaskId: records.operation.taskId,
        toTaskId: analysis.operation.taskId,
        fromNodeId: "records",
        toNodeId: "analysis",
        evidenceIds: [evidenceId],
        fromAssignment: expect.objectContaining({ agentId: "main" }),
        toAssignment: expect.objectContaining({ agentId: "bob" }),
      }),
    ]);
    gateway.pending[1].resolve({ runId: "run-analysis" });
    await tick();
    gateway.final("run-analysis", "agent:bob:main", "Pump output declined at 14:00");
    await tick();
    const finished = orchestration.get("water-pressure-1");
    expect(finished.status).toBe("awaiting_verification");
    expect(finished.children[1].result).toBe("Pump output declined at 14:00");
    expect(finished.statusEvents).toContainEqual(
      expect.objectContaining({
        nodeId: "analysis",
        taskId: analysis.operation.taskId,
        to: "completed",
      }),
    );
    expect(finished.statusEvents).toContainEqual(
      expect.objectContaining({
        to: "awaiting_verification",
      }),
    );
    expect(finished).not.toHaveProperty("verification");
  });

  it("enforces parallel and retry limits without sending unknown outcomes again", async () => {
    const { orchestration, gateway } = await setup();
    orchestration.create(
      request({
        maxParallelTasks: 1,
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs", maxRetries: 1 },
          { taskId: "other", role: "analyst", message: "Inspect readings" },
        ],
      }),
    );
    await tick();
    expect(gateway.pending).toHaveLength(1);
    gateway.pending[0].reject(Object.assign(new Error("rejected"), { rejected: true }));
    await tick();
    expect(gateway.pending).toHaveLength(2);
    const retried = orchestration.get("water-pressure-1").children[0];
    expect(retried.attempts).toHaveLength(2);
    expect(retried.operation.retryCount).toBe(1);
    expect(retried.attempts[0].runtimeTaskId).not.toBe(retried.attempts[1].runtimeTaskId);
    gateway.pending[1].reject(new Error("Connection lost after send"));
    await tick();
    const unresolved = orchestration.get("water-pressure-1");
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.children[0].attempts).toHaveLength(2);
    orchestration.reconcile("water-pressure-1");
    expect(gateway.pending).toHaveLength(2);
  });

  it("stops after the manifest-approved retry limit", async () => {
    const { orchestration, gateway } = await setup();
    orchestration.create(
      request({
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs", maxRetries: 1 },
        ],
      }),
    );
    await tick();
    gateway.pending[0].reject(Object.assign(new Error("rejected"), { rejected: true }));
    await tick();
    expect(gateway.pending).toHaveLength(2);
    gateway.pending[1].reject(Object.assign(new Error("rejected again"), { rejected: true }));
    await tick();
    const failed = orchestration.get("water-pressure-1");
    expect(failed.status).toBe("failed");
    expect(failed.children[0].attempts).toHaveLength(2);
    expect(gateway.pending).toHaveLength(2);
  });

  it("holds evidence-gated work while freshUntil is expired", async () => {
    const { orchestration, gateway, evidenceItems } = await setup();
    const created = orchestration.create(request());
    const recordsId = created.children[0].operation.taskId;
    await tick();
    gateway.pending[0].resolve({ runId: "run-records" });
    await tick();
    gateway.final("run-records", "agent:main:main");
    await tick();
    evidenceItems.set("old-log", {
      evidenceId: "old-log",
      incidentId: "water-pressure-1",
      taskId: recordsId,
      source: "synthetic:pump_logs",
      recordId: "log-old",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() - 60000).toISOString(),
      content: "Old pressure reading",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: recordsId,
      evidenceIds: ["old-log"],
    });
    expect(orchestration.get("water-pressure-1").children[1].phase).toBe("waiting_evidence");
    expect(gateway.pending).toHaveLength(1);
    evidenceItems.set("undated-log", {
      evidenceId: "undated-log",
      incidentId: "water-pressure-1",
      taskId: recordsId,
      source: "synthetic:pump_logs",
      recordId: "log-undated",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      content: "No freshness guarantee",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: recordsId,
      evidenceIds: ["undated-log"],
    });
    expect(orchestration.get("water-pressure-1").children[1].phase).toBe("waiting_evidence");
    expect(gateway.pending).toHaveLength(1);
    evidenceItems.set("new-log", {
      evidenceId: "new-log",
      incidentId: "water-pressure-1",
      taskId: recordsId,
      source: "synthetic:pump_logs",
      recordId: "log-new",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60000).toISOString(),
      content: "Current pressure reading",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: recordsId,
      evidenceIds: ["new-log"],
    });
    await tick();
    expect(gateway.pending).toHaveLength(2);
  });

  it("halts a waiting child when its binding or reviewed permissions change", async () => {
    for (const change of ["binding", "permission"]) {
      const { orchestration, runtime, db, registry, gateway } = await setup();
      orchestration.create(
        request({
          incident: { ...incident(), incidentId: `change-${change}` },
          tasks: [
            { taskId: "records", role: "data-steward", message: "Inspect logs" },
            { taskId: "analysis", role: "analyst", message: "Analyze", dependencies: ["records"] },
          ],
        }),
      );
      if (change === "binding") {
        runtime.saveSeat({
          seatId: "Bob",
          label: "Bob",
          assigned: true,
          seatType: "agent",
          agentConfig: { agentId: "bob" },
          revision: db.getSeat("Bob").binding.revision,
        });
      } else {
        const original = registry.assign;
        registry.assign = (input) => {
          const selected = original(input);
          return input.task.role === "analyst"
            ? {
                ...selected,
                manifest: {
                  ...selected.manifest,
                  permissions: {
                    ...selected.manifest.permissions,
                    sensitiveWrites: "approval_required",
                  },
                },
              }
            : selected;
        };
      }
      await tick();
      gateway.pending[0].resolve({ runId: `run-${change}` });
      await tick();
      gateway.final(`run-${change}`, "agent:main:main");
      await tick();
      const plan = orchestration.get(`change-${change}`);
      expect(plan.children[1].phase).toBe("blocked");
      expect(plan.children[1].attempts).toHaveLength(0);
      expect(gateway.pending).toHaveLength(1);
    }
  });

  it("applies each reviewed manifest's parallel limit", async () => {
    const { orchestration, registry, db } = await setup();
    const original = registry.assign;
    registry.assign = (input) => {
      const selected = original(input);
      return {
        ...selected,
        manifest: {
          ...selected.manifest,
          limits: { ...selected.manifest.limits, maxParallelTasks: 1 },
        },
      };
    };
    const planned = orchestration.create(
      request({
        tasks: [
          { taskId: "first", role: "data-steward", message: "Inspect first log" },
          { taskId: "second", role: "data-steward", message: "Inspect second log" },
        ],
      }),
    );
    expect(planned.children.map((child: { phase: string }) => child.phase)).toEqual([
      expect.stringMatching(/queued|running/),
      "ready",
    ]);
    expect(db.listTasks()).toHaveLength(1);
  });

  it("applies the agent limit across separate incidents", async () => {
    const { orchestration, registry, gateway } = await setup();
    const original = registry.assign;
    registry.assign = (input) => {
      const selected = original(input);
      return {
        ...selected,
        manifest: {
          ...selected.manifest,
          limits: { ...selected.manifest.limits, maxParallelTasks: 1 },
        },
      };
    };
    const tasks = [{ taskId: "records", role: "data-steward", message: "Inspect logs" }];
    const first = orchestration.create(request({ tasks }));
    const second = orchestration.create(
      request({ incident: { ...incident(), incidentId: "water-pressure-2" }, tasks }),
    );
    expect(first.children[0].phase).toMatch(/queued|running/);
    expect(second.children[0].phase).toBe("ready");
    await tick();
    expect(gateway.pending).toHaveLength(1);
    gateway.pending[0].resolve({ runId: "run-first" });
    await tick();
    gateway.final("run-first", "agent:main:main");
    await tick();
    orchestration.reconcile("water-pressure-2");
    expect(gateway.pending).toHaveLength(2);
  });

  it("repeated requests and a plan write gap reuse the same runtime task", async () => {
    const { orchestration, db, gateway } = await setup();
    const input = request({
      tasks: [{ taskId: "records", role: "data-steward", message: "Inspect logs" }],
    });
    const created = orchestration.create(input);
    const taskId = created.children[0].attempts[0].runtimeTaskId;
    expect(orchestration.create(input).children[0].attempts[0].runtimeTaskId).toBe(taskId);
    expect(() =>
      orchestration.create(
        request({ incident: { ...incident(), goal: "Different" }, tasks: input.tasks }),
      ),
    ).toThrow(/already used/);
    const stale = {
      ...created,
      status: "planned",
      children: [
        {
          ...created.children[0],
          phase: "waiting",
          attempts: [],
          operation: {
            ...created.children[0].operation,
            status: "planned",
            retryCount: 0,
            assignment: undefined,
          },
        },
      ],
    };
    db.saveRecord("orchestration", "water-pressure-1", stale, created.revision);
    const recovered = orchestration.create(input);
    expect(recovered.children[0].attempts[0].runtimeTaskId).toBe(taskId);
    expect(
      db.listTasks().filter((task: { taskId: string }) => task.taskId === taskId),
    ).toHaveLength(1);
    await tick();
    expect(gateway.pending).toHaveLength(1);
  });

  it("checks evidence provenance and freshness without inventing a timestamp", async () => {
    const { orchestration, evidenceItems } = await setup();
    const created = orchestration.create(
      request({ tasks: [{ taskId: "records", role: "data-steward", message: "Inspect logs" }] }),
    );
    const runtimeId = created.children[0].operation.taskId;
    evidenceItems.set("foreign", {
      evidenceId: "foreign",
      incidentId: "other",
      taskId: runtimeId,
      source: "synthetic:pump_logs",
      recordId: "x",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      content: "Unrelated",
    });
    expect(() =>
      orchestration.attachEvidence({
        incidentId: "water-pressure-1",
        taskId: runtimeId,
        evidenceIds: ["foreign"],
      }),
    ).toThrow(/does not belong/);
    expect(orchestration.get("water-pressure-1").children[0].evidenceIds).toEqual([]);
  });

  it("leaves a deleted evidence reference unresolved instead of releasing its dependent", async () => {
    const { orchestration, gateway, evidenceItems } = await setup();
    const created = orchestration.create(request());
    const sourceId = created.children[0].operation.taskId;
    evidenceItems.set("disappearing-log", {
      evidenceId: "disappearing-log",
      incidentId: "water-pressure-1",
      taskId: sourceId,
      source: "synthetic:pump_logs",
      recordId: "log-missing",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60000).toISOString(),
      content: "Temporary fixture row",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: sourceId,
      evidenceIds: ["disappearing-log"],
    });
    evidenceItems.delete("disappearing-log");
    await tick();
    gateway.pending[0].resolve({ runId: "run-records" });
    await tick();
    gateway.final("run-records", "agent:main:main");
    await tick();
    const plan = orchestration.get("water-pressure-1");
    expect(plan.status).toBe("unresolved");
    expect(plan.children[1].phase).toBe("unresolved");
    expect(plan.children[1].attempts).toHaveLength(0);
    expect(gateway.pending).toHaveLength(1);
  });

  it("restart recovery preserves attempts and uncertainty without re-dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-orchestration-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const first = await setup(path);
    first.orchestration.create(
      request({
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs", maxRetries: 2 },
        ],
      }),
    );
    await tick();
    expect(first.gateway.pending).toHaveLength(1);
    const taskId =
      first.orchestration.get("water-pressure-1").children[0].attempts[0].runtimeTaskId;
    first.close();
    const second = await setup(path);
    second.orchestration.reconcileAll();
    const recovered = second.orchestration.get("water-pressure-1");
    expect(recovered.status).toBe("unresolved");
    expect(recovered.children[0].attempts).toHaveLength(1);
    expect(recovered.children[0].attempts[0].runtimeTaskId).toBe(taskId);
    expect(
      second.db.listTasks().filter((task: { taskId: string }) => task.taskId === taskId),
    ).toHaveLength(1);
    expect(second.gateway.pending).toHaveLength(0);
  });

  it("keeps a missing recipient response unresolved after runtime reconciliation", async () => {
    const { orchestration, runtime, gateway } = await setup();
    const created = orchestration.create(
      request({
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs", maxRetries: 1 },
        ],
      }),
    );
    await tick();
    gateway.pending[0].resolve({ runId: "run-silent" });
    await tick();
    await runtime.reconcile();
    await tick();
    const plan = orchestration.get("water-pressure-1");
    expect(plan.status).toBe("unresolved");
    expect(plan.children[0].attempts).toHaveLength(1);
    expect(plan.children[0].operation.taskId).toBe(created.children[0].operation.taskId);
    expect(gateway.pending).toHaveLength(1);
  });

  it("replays one handoff and status history after duplicate final events", async () => {
    const { orchestration, db, gateway, evidenceItems } = await setup();
    const created = orchestration.create(request());
    const sourceId = created.children[0].operation.taskId;
    await tick();
    gateway.pending[0].resolve({ runId: "run-records" });
    await tick();
    gateway.final("run-records", "agent:main:main");
    await tick();
    evidenceItems.set("recent-log", {
      evidenceId: "recent-log",
      incidentId: "water-pressure-1",
      taskId: sourceId,
      source: "synthetic:pump_logs",
      recordId: "log-1",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60000).toISOString(),
      content: "Pressure dropped",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId: sourceId,
      evidenceIds: ["recent-log"],
    });
    await tick();
    const before = orchestration.get("water-pressure-1");
    const cursor = db.cursor();
    gateway.final("run-records", "agent:main:main");
    orchestration.reconcile("water-pressure-1");
    await tick();
    const after = orchestration.get("water-pressure-1");
    expect(after.handoffs).toEqual(before.handoffs);
    expect(after.statusEvents).toEqual(before.statusEvents);
    expect(after.handoffs).toHaveLength(1);
    expect(db.replay(0).filter((event) => event.kind === "orchestration").length).toBeGreaterThan(
      1,
    );
    expect(db.replay(cursor)).toEqual([]);
    expect(gateway.pending).toHaveLength(2);
  });

  it("recovers a dependency release write gap without a second dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-release-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "tasks.sqlite");
    const first = await setup(path);
    const created = first.orchestration.create(
      request({
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs" },
          { taskId: "analysis", role: "analyst", message: "Analyze", dependencies: ["records"] },
        ],
      }),
    );
    await tick();
    first.gateway.pending[0].resolve({ runId: "run-records" });
    await tick();
    first.gateway.final("run-records", "agent:main:main");
    await tick();
    const released = first.orchestration.get("water-pressure-1");
    const targetId = released.children[1].operation.taskId;
    const stale = structuredClone(released);
    stale.children[1] = created.children[1];
    stale.handoffs = [];
    stale.statusEvents = created.statusEvents;
    first.db.saveRecord("orchestration", "water-pressure-1", stale, released.revision);
    first.close();
    const second = await setup(path);
    second.orchestration.reconcileAll();
    const recovered = second.orchestration.get("water-pressure-1");
    expect(recovered.children[1].operation.taskId).toBe(targetId);
    expect(recovered.children[1].attempts).toHaveLength(1);
    expect(recovered.handoffs).toHaveLength(1);
    expect(
      second.db.listTasks().filter((task: { taskId: string }) => task.taskId === targetId),
    ).toHaveLength(1);
    expect(second.gateway.pending).toHaveLength(0);
  });

  it("records a Critic verdict and permits exactly one linked revision", async () => {
    const { orchestration, gateway, evidenceItems } = await setup();
    const original = orchestration.create(
      request({ tasks: [{ taskId: "records", role: "data-steward", message: "Inspect logs" }] }),
    );
    const taskId = original.children[0].operation.taskId;
    evidenceItems.set("critique-log", {
      evidenceId: "critique-log",
      incidentId: "water-pressure-1",
      taskId,
      source: "synthetic:pump_logs",
      recordId: "log-critique",
      sourceTimestamp: null,
      retrievedAt: new Date().toISOString(),
      content: "Reading conflicts with the proposed cause",
    });
    orchestration.attachEvidence({
      incidentId: "water-pressure-1",
      taskId,
      evidenceIds: ["critique-log"],
    });
    const verdict = {
      verificationId: "verdict-1",
      incidentId: "water-pressure-1",
      taskId,
      verdict: "revise" as const,
      evidenceIds: ["critique-log"],
      reason: "The proposed cause conflicts with the pump log.",
      checkedAt: new Date().toISOString(),
    };
    expect(() => orchestration.recordVerification(verdict)).toThrow(/finish/);
    await tick();
    gateway.pending[0].resolve({ runId: "run-original" });
    await tick();
    gateway.final("run-original", "agent:main:main");
    await tick();
    expect(orchestration.recordVerification(verdict).verification).toEqual(verdict);
    expect(orchestration.recordVerification(verdict).status).toBe("awaiting_verification");
    const input = {
      originalIncidentId: "water-pressure-1",
      revisionIncident: { ...incident(), incidentId: "water-pressure-revision-1" },
      reason: verdict.reason,
      evidenceIds: verdict.evidenceIds,
      tasks: [{ taskId: "recheck", role: "analyst", message: "Recheck the conflicting logs" }],
    };
    const revised = orchestration.revise(input);
    expect(revised.revisionOf).toBe("water-pressure-1");
    expect(orchestration.revise(input).children[0].operation.taskId).toBe(
      revised.children[0].operation.taskId,
    );
    expect(orchestration.get("water-pressure-1").revisedIncidentId).toBe(
      "water-pressure-revision-1",
    );
    expect(orchestration.get("water-pressure-1").children[0].attempts).toHaveLength(1);
    expect(() =>
      orchestration.revise({
        ...input,
        revisionIncident: { ...incident(), incidentId: "another-revision" },
      }),
    ).toThrow(/Only one/);
    expect(() =>
      orchestration.revise({ ...input, originalIncidentId: "water-pressure-revision-1" }),
    ).toThrow(/first-pass/);
  });

  it("rejects a failed superseded attempt before accepting its completed retry", async () => {
    const { orchestration, db, gateway } = await setup();
    orchestration.create(
      request({
        tasks: [
          { taskId: "records", role: "data-steward", message: "Inspect logs", maxRetries: 1 },
        ],
      }),
    );
    await tick();
    gateway.pending[0].reject(Object.assign(new Error("rejected"), { rejected: true }));
    await tick();
    const retrying = orchestration.get("water-pressure-1");
    const [failed, retried] = retrying.children[0].attempts;
    expect(db.getTask(failed.runtimeTaskId).status).toBe("failed");
    expect(failed.runtimeTaskId).not.toBe(retried.runtimeTaskId);
    gateway.pending[1].resolve({ runId: "run-retry" });
    await tick();
    gateway.final("run-retry", "agent:main:main");
    await tick();
    const finished = orchestration.get("water-pressure-1");
    expect(finished.status).toBe("awaiting_verification");
    expect(db.getTask(retried.runtimeTaskId).status).toBe("completed");
    const verdict = {
      verificationId: "verdict-retry",
      incidentId: "water-pressure-1",
      taskId: failed.runtimeTaskId,
      verdict: "pass" as const,
      evidenceIds: [],
      reason: "Checked the completed attempt",
      checkedAt: new Date().toISOString(),
    };
    const revision = finished.revision;
    expect(() => orchestration.recordVerification(verdict)).toThrow(
      /current completed runtime attempt/,
    );
    expect(() =>
      orchestration.recordVerification({ ...verdict, taskId: "nonexistent-runtime-task" }),
    ).toThrow(/current completed runtime attempt/);
    expect(orchestration.get("water-pressure-1").revision).toBe(revision);
    expect(orchestration.get("water-pressure-1")).not.toHaveProperty("verification");
    const accepted = orchestration.recordVerification({
      ...verdict,
      taskId: retried.runtimeTaskId,
    });
    expect(accepted.verification?.taskId).toBe(retried.runtimeTaskId);
    expect(accepted.status).toBe("awaiting_verification");
  });
});

describe("distinct contributions and expected overlap", () => {
  const findings =
    "Pump P-100 refill time doubled from 35 to 70 minutes after the valve service on 12 October.";
  const contributions = () =>
    request({
      tasks: [
        {
          taskId: "records",
          role: "data-steward",
          message: "Report tank readings",
          deliverable: { id: "readings", kind: "report", description: "Tank readings" },
        },
        {
          taskId: "manual",
          role: "analyst",
          message: "Report manual limits",
          deliverable: { id: "limits", kind: "report", description: "Manual operating limits" },
        },
        {
          taskId: "synthesis",
          role: "data-steward",
          message: "Synthesize the findings",
          dependencies: ["records", "manual"],
          deliverable: { id: "final", kind: "synthesis", description: "Consolidated answer" },
        },
      ],
    });
  const result = (
    incidentGoal: ReturnType<typeof incident>,
    deliverableId: string,
    content: string,
  ) =>
    JSON.stringify({
      goalFingerprint: goalFingerprint(incidentGoal),
      deliverableId,
      status: "completed",
      content,
      evidenceIds: [],
      uncertainty: ["Not yet measured on site."],
    });
  const complete = (c: Awaited<ReturnType<typeof setup>>, taskId: string, value: string) =>
    c.db.updateTask(taskId, { status: "completed", result: value });

  it("requests one distinct revision for a repeated worker result, then accepts distinct work", async () => {
    const c = await setup();
    const input = contributions();
    const plan = c.orchestration.create(input);
    const [records, manual] = plan.children;
    complete(c, records.operation.taskId, result(input.incident, "readings", findings));
    c.orchestration.reconcile(input.incident.incidentId);
    complete(c, manual.operation.taskId, result(input.incident, "limits", findings));
    let current = c.orchestration.reconcile(input.incident.incidentId);
    const repeated = current.children.find((child) => child.nodeId === "manual")!;
    expect(repeated.attempts).toHaveLength(2);
    expect(repeated.distinctRevision).toMatchObject({ similarTo: "readings", attempt: 2 });
    const revisionTask = c.db.getTask(repeated.attempts[1].runtimeTaskId);
    expect(revisionTask.message).toContain("Revision request");
    complete(
      c,
      revisionTask.taskId,
      result(
        input.incident,
        "limits",
        "The manual allows at most 45 minutes refill at 3 bar inlet pressure.",
      ),
    );
    current = c.orchestration.reconcile(input.incident.incidentId);
    const revised = current.children.find((child) => child.nodeId === "manual")!;
    expect(revised.phase).toBe("completed");
    expect(revised.reviewSignals).toBeUndefined();
    // The synthesis legitimately restates both findings and is accepted without a signal.
    const synthesis = current.children.find((child) => child.nodeId === "synthesis")!;
    expect(synthesis.attempts).toHaveLength(1);
    complete(
      c,
      synthesis.operation.taskId,
      result(input.incident, "final", `${findings} The manual allows at most 45 minutes refill.`),
    );
    current = c.orchestration.reconcile(input.incident.incidentId);
    const accepted = current.children.find((child) => child.nodeId === "synthesis")!;
    expect(accepted.phase).toBe("completed");
    expect(accepted.reviewSignals).toBeUndefined();
    expect(accepted.attempts).toHaveLength(1);
  });

  it("escalates a still-repeated revision to the reviewer as a signal instead of rejecting it", async () => {
    const c = await setup();
    const input = contributions();
    const plan = c.orchestration.create(input);
    const [records, manual] = plan.children;
    complete(c, records.operation.taskId, result(input.incident, "readings", findings));
    c.orchestration.reconcile(input.incident.incidentId);
    complete(c, manual.operation.taskId, result(input.incident, "limits", findings));
    let current = c.orchestration.reconcile(input.incident.incidentId);
    const second = current.children.find((child) => child.nodeId === "manual")!.attempts[1];
    complete(c, second.runtimeTaskId, result(input.incident, "limits", findings));
    current = c.orchestration.reconcile(input.incident.incidentId);
    const escalated = current.children.find((child) => child.nodeId === "manual")!;
    expect(escalated.phase).toBe("completed");
    expect(escalated.attempts).toHaveLength(2);
    expect(escalated.reviewSignals).toMatchObject({
      escalated: true,
      repeats: { similarTo: "readings" },
    });
    const synthesis = current.children.find((child) => child.nodeId === "synthesis")!;
    expect(c.db.getTask(synthesis.operation.taskId).message).toContain(
      "Review signals on prerequisite contributions",
    );
  });
});

describe("emergency stop adapted from hermes-agent", () => {
  it("pauses new dispatch without touching work already in flight, then resumes", async () => {
    const c = await setup();
    const { EmergencyStop } = await import("../server/estop.mjs");
    const dir = mkdtempSync(join(tmpdir(), "orchestration-estop-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const stop = new EmergencyStop(join(dir, "ESTOP"));
    Object.assign(c.runtime, { estop: stop });
    const input = request();
    const first = c.orchestration.create(input);
    expect(first.children[0].attempts).toHaveLength(1);
    stop.engage("operator pause");
    // The in-flight attempt completes normally; its dependent is not dispatched.
    c.db.updateTask(first.children[0].operation.taskId, { status: "completed", result: "logs" });
    const paused = c.orchestration.reconcile(input.incident.incidentId);
    expect(paused.children[0].phase).toBe("completed");
    expect(paused.children[1].attempts).toHaveLength(0);
    stop.release();
    expect(c.orchestration.reconcile(input.incident.incidentId).children[1].phase).not.toBe(
      "unresolved",
    );
  });
});
