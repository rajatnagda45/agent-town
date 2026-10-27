import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createDataReader } from "../server/data-source.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { loadSpecialistConfig } from "../server/specialist-config.mjs";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Reuse compiled fixture schemas; each gateway still owns its mutable execution state.
const fixtureAudit = new ContractAudit(fixture);
class Gateway {
  provider = "openclaw";
  audit = fixtureAudit;
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  listeners = new Set<(kind: string, data: unknown) => void>();
  subscribe(fn: (kind: string, data: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  capabilities() {
    return this.audit.capabilities(this.hello, true);
  }
  stop() {
    this.status = "disconnected";
  }
  request(method: string) {
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "bob" }, { id: "carol" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}

const incident = (id: string) => ({
  incidentId: id,
  goal: "Explain pump pressure",
  constraints: [],
  taskType: "investigation",
  acceptanceCriteria: [{ criterionId: "cause", description: "Check evidence" }],
  createdAt: new Date().toISOString(),
});
const graph = (id: string) => ({
  incident: incident(id),
  tasks: [
    { taskId: "data", role: "data-steward-researcher", message: "Read pump log" },
    {
      taskId: "critic",
      role: "critic",
      message: "Verify pump log",
      dependencies: ["data"],
      requiredEvidenceFrom: ["data"],
    },
  ],
});

async function setup(options: { grants?: boolean; authorize?: boolean; provider?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-town-office-ops-"));
  const db = new TaskDatabase(join(dir, "tasks.sqlite"));
  const gateway = new Gateway();
  if (options.provider) gateway.provider = options.provider;
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "gateway-1" });
  await runtime.refresh();
  for (const [seatId, agentId] of [
    ["data", "bob"],
    ["critic", "carol"],
  ])
    runtime.saveSeat({
      seatId,
      label: seatId,
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  const grants =
    options.grants === false
      ? []
      : [
          { manifestId: "data-steward-researcher", seatId: "data" },
          { manifestId: "critic", seatId: "critic" },
        ];
  const now = new Date();
  const reader = createDataReader({
    mode: "synthetic",
    templates: {
      pump: {
        id: "pump",
        source: "pump_log",
        sql: "SELECT id, observed_at, pressure FROM pump_log",
        parameters: {},
        recordIdField: "id",
        timestampField: "observed_at",
        fields: ["pressure"],
        maxAgeMs: 600000,
      },
    },
    synthetic: createSyntheticDataSource({
      pump: {
        parameters: {},
        rows: [{ id: "pump-1", observed_at: now.toISOString(), pressure: 185 }],
      },
    }),
  });
  const operations = new OfficeOperations(runtime, {
    dataReader: reader,
    specialists: { grants, enforcement: { authorizeSync: () => options.authorize !== false } },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    operations.close();
    runtime.close();
    db.close();
  };
  cleanups.push(() => {
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, runtime, operations, close, filename: join(dir, "tasks.sqlite"), grants };
}

it("loads only reviewed server grants and provisioning profiles", () => {
  expect(
    loadSpecialistConfig({
      AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify([{ manifestId: "critic", seatId: "critic" }]),
      AGENT_TOWN_SPECIALIST_PROFILES: JSON.stringify({
        critic: {
          seatId: "new-critic",
          name: "Critic",
          workspace: "approved-workspace",
        },
      }),
    }),
  ).toMatchObject({
    grants: [{ manifestId: "critic" }],
    profiles: { critic: { seatId: "new-critic" } },
  });
  expect(() =>
    loadSpecialistConfig({
      AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify([{ manifestId: "unreviewed", seatId: "other" }]),
    }),
  ).toThrow(/reviewed/);
  expect(() =>
    loadSpecialistConfig({
      AGENT_TOWN_SPECIALIST_PROFILES: JSON.stringify({
        critic: { seatId: "new", name: "Critic", workspace: "approved", apiKey: "secret" },
      }),
    }),
  ).toThrow(/profiles/);
});

it("routes a capability request through the existing verified binding and keeps completion unverified", async () => {
  const { operations, db } = await setup();
  const result = await operations.requestSpecialist({
    requestId: "research-1",
    kind: "research",
    goal: "Research the pump manual",
  });
  expect(result.role).toBe("data-steward-researcher");
  expect(operations.journal.list("provision")).toHaveLength(0);
  expect(operations.journal.list("dispatch")).toHaveLength(1);
  db.updateTask(result.taskId, { status: "completed", result: "A source was found" });
  await tick();
  expect(operations.orchestration.get(result.incidentId).status).not.toBe("verified");
  const duplicate = await operations.requestSpecialist({
    requestId: "research-1",
    kind: "research",
    goal: "Research the pump manual",
  });
  expect(duplicate.taskId).toBe(result.taskId);
  expect(operations.journal.list("dispatch")).toHaveLength(1);
});

it("blocks an unavailable specialist and rejects changed request identity", async () => {
  const { operations } = await setup({ grants: false });
  const result = await operations.requestSpecialist({
    requestId: "manual-1",
    kind: "maintenance-manual",
    goal: "Review the supplied equipment manual",
  });
  expect(operations.orchestration.get(result.incidentId).children[0].dispatchCode).toBe(
    "no_eligible_agent",
  );
  expect(operations.journal.list("provision")).toHaveLength(0);
  await expect(
    operations.requestSpecialist({
      requestId: "manual-1",
      kind: "maintenance-manual",
      goal: "Different goal",
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("selects reviewed specialists, persists cross-child evidence and promotes one verified lesson", async () => {
  const { db, runtime, operations } = await setup();
  const created = operations.create(graph("pump-incident"));
  expect(created.children[0].attempts).toHaveLength(1);
  const dataTask = created.children[0].operation.taskId;
  expect(operations.journal.list("dispatch")).toHaveLength(1);
  db.updateTask(dataTask, { status: "completed", result: "Read log" });
  await tick();
  const read = await operations.readEvidence({
    incidentId: "pump-incident",
    taskId: dataTask,
    templateId: "pump",
    parameters: {},
  });
  expect(read.evidence[0].taskId).toBe(dataTask);
  expect(read.evidence[0].auditRef).toBe(read.auditRef);
  const plan = operations.reconcile("pump-incident");
  const criticTask = plan.children[1].operation.taskId;
  expect(criticTask).not.toBe(dataTask);
  expect(operations.journal.list("dispatch")).toHaveLength(2);
  db.updateTask(criticTask, { status: "completed", result: "Checked" });
  await tick();
  operations.reconcile("pump-incident");
  expect(operations.records.list("verificationResult")).toHaveLength(0);
  const verification = {
    verificationId: "pump-pass",
    incidentId: "pump-incident",
    taskId: criticTask,
    verdict: "pass" as const,
    evidenceIds: read.evidence.map((item: { evidenceId: string }) => item.evidenceId),
    reason: "Log checked",
    checkedAt: new Date().toISOString(),
  };
  const lesson = { content: "Pump pressure fell to 185.", applicability: "pump pressure" };
  const result = operations.recordVerification({ verification, lesson });
  expect(result.lesson?.source.taskId).toBe(criticTask);
  expect(operations.records.get("incident", "pump-incident")).toBeTruthy();
  expect(operations.records.get("task", dataTask)).toBeTruthy();
  const cursor = db.cursor();
  expect(operations.recordVerification({ verification, lesson }).lesson?.id).toBe(
    result.lesson?.id,
  );
  expect(db.cursor()).toBe(cursor);
  const followup = runtime.submit({
    taskId: "pump-followup",
    seatId: "critic",
    bindingRevision: 1,
    message: "Explain pump pressure",
  });
  expect(
    runtime.memory.retrieve({
      gatewayId: followup.gatewayId,
      agentId: followup.agentId,
      seatId: followup.seatId,
      sessionKey: followup.sessionKey,
      bindingRevision: 1,
      query: "pump pressure",
    }),
  ).toMatchObject([{ id: result.lesson?.id }]);
});

it("blocks dispatch when no eligible specialist grant exists", async () => {
  const missing = await setup({ grants: false });
  const blocked = missing.operations.create(graph("no-agent"));
  expect(blocked.status).toBe("unresolved");
  expect(blocked.children[0]).toMatchObject({
    phase: "blocked",
    dispatchCode: "no_eligible_agent",
  });
  expect(missing.db.listTasks(10, 0)).toHaveLength(0);
});

it("blocks dispatch when provider authorization is denied", async () => {
  const denied = await setup({ authorize: false });
  const plan = denied.operations.create(graph("denied"));
  expect(plan.children[0].phase).toBe("blocked");
  expect(denied.db.listTasks(10, 0)).toHaveLength(0);
});

it("blocks an OpenClaw-only template when the provider is Nightshift", async () => {
  const nightshift = await setup({ provider: "nightshift" });
  expect(
    nightshift.operations.create(graph("nightshift-ineligible")).children[0].dispatchCode,
  ).toBe("no_eligible_agent");
});

it("keeps unknown execution unresolved", async () => {
  const { db, operations } = await setup();
  const plan = operations.create(graph("unknown"));
  db.updateTask(plan.children[0].operation.taskId, { status: "outcome_unknown" });
  expect(operations.reconcile("unknown").status).toBe("unresolved");
  expect(operations.journal.list("dispatch")).toHaveLength(1);
});

it("records a failed verification and permits only one linked revision", async () => {
  const { db, operations } = await setup();
  const plan = operations.create(graph("revise-original"));
  const dataTask = plan.children[0].operation.taskId;
  db.updateTask(dataTask, { status: "completed", result: "Read log" });
  await tick();
  const read = await operations.readEvidence({
    incidentId: "revise-original",
    taskId: dataTask,
    templateId: "pump",
    parameters: {},
  });
  const ready = operations.reconcile("revise-original");
  const criticTask = ready.children[1].operation.taskId;
  db.updateTask(criticTask, { status: "completed", result: "Needs another reading" });
  await tick();
  operations.reconcile("revise-original");
  const evidenceIds = read.evidence.map((item: { evidenceId: string }) => item.evidenceId);
  const reason = "A second reading is needed";
  const result = operations.recordVerification({
    verification: {
      verificationId: "revise-verdict",
      incidentId: "revise-original",
      taskId: criticTask,
      verdict: "revise",
      evidenceIds,
      reason,
      checkedAt: new Date().toISOString(),
    },
    lesson: { content: "Unverified conclusion", applicability: "pump pressure" },
  });
  expect(result.lesson).toBeNull();
  const input = {
    originalIncidentId: "revise-original",
    revisionIncident: incident("revise-next"),
    reason,
    evidenceIds,
    tasks: [
      { taskId: "retry", role: "data-steward-researcher", message: "Collect a second reading" },
    ],
  };
  const revised = operations.revise(input);
  expect(revised.revisionOf).toBe("revise-original");
  expect(operations.revise(input).incident.incidentId).toBe("revise-next");
  expect(() => operations.revise({ ...input, revisionIncident: incident("revise-third") })).toThrow(
    /one revised plan/i,
  );
});

it("recovers an uncertain dispatch from SQLite without a second submission", async () => {
  const first = await setup();
  const plan = first.operations.create(graph("restart-incident"));
  const taskId = plan.children[0].operation.taskId;
  expect(first.operations.journal.list("dispatch")).toHaveLength(1);
  first.close();

  const db = new TaskDatabase(first.filename);
  const runtime = new TaskRuntime({ db, gateway: new Gateway(), gatewayId: "gateway-1" });
  const operations = new OfficeOperations(runtime, {
    specialists: {
      grants: first.grants,
      enforcement: { authorizeSync: () => true },
    },
  });
  cleanups.push(() => {
    operations.close();
    runtime.close();
    db.close();
  });
  await runtime.refresh();
  await operations.recover();
  expect(db.getTask(taskId).status).toBe("outcome_unknown");
  expect(operations.orchestration.get("restart-incident").status).toBe("unresolved");
  expect(operations.journal.list("dispatch")).toHaveLength(1);
  expect(operations.records.get("task", taskId)?.value.incidentId).toBe("restart-incident");
});
