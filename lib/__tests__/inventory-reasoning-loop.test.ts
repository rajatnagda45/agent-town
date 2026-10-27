import { afterEach, expect, it } from "vitest";
import { createServer } from "node:http";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { createInventoryReader } from "../server/inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "../server/inventory-synthetic.mjs";
import { InventoryReasoningLoop } from "../server/inventory-reasoning-loop.mjs";
import {
  evidenceDetail,
  investigationView,
  startInvestigation,
} from "../server/inventory-office-api.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";

// Mocked OpenClaw execution and synthetic warehouse rows; no live service is contacted.
class MockGateway {
  provider = "openclaw";
  audit = new ContractAudit(fixture);
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  subscribe() {
    return () => {};
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
        agents: [{ id: "planner" }, { id: "analyst" }, { id: "critic" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const criteria = {
  scenarioId: "complete",
  sku: "SKU-42",
  locationId: "WH-A",
  ledgerQuantity: 12,
  physicalQuantity: 9,
  maxUnexplainedUnits: 0,
};
function fixtures(scenario: string) {
  const value = createSyntheticInventoryFixtures(scenario, {
    sku: criteria.sku,
    locationId: criteria.locationId,
    openingQuantity: 10,
    countedQuantity: 9,
  });
  return value;
}
async function setup(first = "complete", second = first) {
  const db = new TaskDatabase(":memory:");
  const runtime = new TaskRuntime({
    db,
    gateway: new MockGateway(),
    gatewayId: "gateway-inventory",
  });
  await runtime.refresh();
  for (const role of ["planner", "analyst", "critic"])
    runtime.saveSeat({
      seatId: role,
      label: role,
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId: role },
      revision: 0,
    });
  const readers = [first, second].map((scenario) =>
    createInventoryReader({
      mode: "synthetic",
      synthetic: createSyntheticDataSource(fixtures(scenario)),
    }),
  );
  const operations = new OfficeOperations(runtime, {
    dataReader: {
      read: (input: Parameters<(typeof readers)[0]["read"]>[0]) =>
        readers[input.scope.incidentId.includes("second") ? 1 : 0].read(input),
    },
    specialists: {
      grants: [
        { manifestId: "planner", seatId: "planner" },
        { manifestId: "data-steward-researcher", seatId: "analyst" },
        { manifestId: "critic", seatId: "critic" },
      ],
      enforcement: { authorizeSync: () => true },
    },
  });
  (runtime as TaskRuntime & { operations: OfficeOperations }).operations = operations;
  const loop = new InventoryReasoningLoop(operations);
  cleanups.push(() => {
    operations.close();
    runtime.close();
    db.close();
  });
  return { db, runtime, operations, loop, first, second };
}
function task(context: Awaited<ReturnType<typeof setup>>, incidentId: string, nodeId: string) {
  return context.operations.orchestration
    .get(incidentId)
    .children.find((child) => child.nodeId === nodeId)!;
}
async function plannerAndReader(context: Awaited<ReturnType<typeof setup>>, incidentId: string) {
  const plan = context.operations.orchestration.get(incidentId);
  context.db.updateTask(task(context, incidentId, "planner").operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      goal: plan.incident.goal,
      acceptanceCriteria: plan.incident.acceptanceCriteria.map((item) => item.criterionId),
      tasks: [
        { taskId: "reader", role: "data-steward-researcher", dependencies: ["planner"] },
        { taskId: "analyst", role: "data-steward-researcher", dependencies: ["reader"] },
        { taskId: "critic", role: "critic", dependencies: ["reader", "analyst"] },
      ],
    }),
  });
  await tick();
  context.loop.acceptPlanner(incidentId);
  context.db.updateTask(task(context, incidentId, "reader").operation.taskId, {
    status: "completed",
    result: "Scoped read ready",
  });
  await tick();
}
async function complete(
  context: Awaited<ReturnType<typeof setup>>,
  incidentId: string,
  explained: number,
  supports = true,
) {
  await plannerAndReader(context, incidentId);
  expect(task(context, incidentId, "analyst").attempts).toHaveLength(0);
  await context.loop.collectEvidence(incidentId);
  const attached = task(context, incidentId, "reader").evidenceIds;
  expect(attached.length).toBeGreaterThan(0);
  expect(task(context, incidentId, "analyst").attempts).toHaveLength(0);
  context.loop.confirmEvidence(incidentId);
  const analyst = task(context, incidentId, "analyst");
  const evidence = attached.map((id) => context.operations.records.get("evidenceItem", id)?.value);
  const cited = evidence
    .filter(
      (item) =>
        item &&
        (item.source.endsWith("inventory_transfers") ||
          item.source.endsWith("inventory_receipts") ||
          (item.source.endsWith("inventory_ledger_movements") &&
            JSON.parse(item.content).movement_type === "posted_receipt" &&
            explained === 3)),
    )
    .map((item) => item!.evidenceId);
  for (const id of attached)
    expect(context.db.getTask(analyst.operation.taskId)?.message).toContain(id);
  context.db.updateTask(analyst.operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      hypothesis: "The audited source records explain the shortage",
      explanationEvidenceIds: cited,
      claimedExplainedUnits: explained,
      missingEvidence: [],
    }),
  });
  await tick();
  context.loop.acceptAnalyst(incidentId);
  const critic = task(context, incidentId, "critic");
  context.db.updateTask(critic.operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      hypothesisSupported: supports,
      missingEvidence: supports ? [] : ["One unit lacks source support"],
      conflictingEvidenceIds: [],
    }),
  });
  await tick();
  context.operations.reconcile(incidentId);
}
const start = (context: Awaited<ReturnType<typeof setup>>, incidentId: string) =>
  context.loop.start({
    incidentId,
    goal: "Explain the SKU-42 shortage at WH-A",
    criteria: { ...criteria, scenarioId: context.first },
  });

it("runs a complete synthetic investigation through persisted, time-aligned evidence and trusted verification", async () => {
  const context = await setup();
  start(context, "inventory-clean");
  await complete(context, "inventory-clean", 3);
  const result = context.loop.finish("inventory-clean");
  expect(result.review.reconciliation).toMatchObject({
    discrepancy: 3,
    explained: 3,
    unexplained: 0,
    sourceMode: "synthetic",
  });
  expect(result.review.reconciliation.countCutoffAt).toBeTruthy();
  expect(result.verification.verdict).toBe("pass");
  expect(
    context.operations.records.get("verificationResult", result.verification.verificationId)?.value
      .verdict,
  ).toBe("pass");
  expect(investigationView(context.runtime, "inventory-clean").synthetic).toBe(true);
});

it("passes source-derived calculation and provenance to reasoning but rejects a wrong model claim", async () => {
  const context = await setup("complete");
  start(context, "inventory-wrong-claim");
  await complete(context, "inventory-wrong-claim", 2);
  const plan = context.operations.orchestration.get("inventory-wrong-claim");
  const reader = plan.children.find((child) => child.nodeId === "reader");
  const analyst = plan.children.find((child) => child.nodeId === "analyst");
  const summary = plan.evidenceSet?.reconciliation;
  if (!reader || !analyst || !summary) throw new Error("Missing source-derived guidance.");
  expect(summary).toMatchObject({
    ledgerQuantity: 12,
    countQuantity: 9,
    discrepancy: 3,
    explainedQuantity: 3,
    difference: 0,
  });
  expect(
    summary.ledgerCountEvidenceIds.every((id: string) => reader.evidenceIds.includes(id)),
  ).toBe(true);
  expect(
    summary.sourceExplanationEvidenceIds.every((id: string) => reader.evidenceIds.includes(id)),
  ).toBe(true);
  for (const auditRef of Object.values(summary.sourceReadAuditRefs))
    expect(context.db.record("operation.dataRead", auditRef as string)).toBeTruthy();
  expect(context.db.getTask(analyst.operation.taskId)?.message).toContain(
    "Server count-cutoff reconciliation from these persisted source reads",
  );
  const result = context.loop.finish("inventory-wrong-claim");
  expect(result.review.issues).toContain(
    "Analyst quantity does not equal the time-aligned source records.",
  );
  expect(result.verification.verdict).toBe("unresolved");
});

it("rejects two of three units, requests evidence, and permits one corrected revision", async () => {
  const context = await setup("incomplete", "complete");
  start(context, "inventory-first");
  await complete(context, "inventory-first", 2, false);
  const first = context.loop.finish("inventory-first");
  expect(first.verification.verdict).toBe("revise");
  expect(first.review.missingEvidence).toContain("1 unit(s) still need source-backed explanation.");
  context.loop.revise("inventory-first", "inventory-second", { scenarioId: context.second });
  await complete(context, "inventory-second", 3);
  expect(context.loop.finish("inventory-second").verification.verdict).toBe("pass");
});

it("ends unresolved when the single revision still accounts for only two units", async () => {
  const context = await setup("incomplete");
  start(context, "inventory-first");
  await complete(context, "inventory-first", 2, false);
  expect(context.loop.finish("inventory-first").verification.verdict).toBe("revise");
  context.loop.revise("inventory-first", "inventory-second", { scenarioId: context.second });
  await complete(context, "inventory-second", 2, false);
  expect(context.loop.finish("inventory-second").verification.verdict).toBe("unresolved");
  expect(() => context.loop.revise("inventory-second", "inventory-third")).toThrow();
});

it.each(["missing", "stale", "missing_event_time"])(
  "holds Analyst dispatch for %s evidence",
  async (scenario) => {
    const context = await setup(scenario);
    start(context, "inventory-first");
    await plannerAndReader(context, "inventory-first");
    await context.loop.collectEvidence("inventory-first");
    expect(() => context.loop.confirmEvidence("inventory-first")).toThrow();
    expect(task(context, "inventory-first", "analyst").attempts).toHaveLength(0);
  },
);

it("excludes a post-count receipt from the explanation even when its source timestamp is fresh", async () => {
  const context = await setup("post_count_receipt");
  start(context, "inventory-first");
  await complete(context, "inventory-first", 3);
  const result = context.loop.finish("inventory-first");
  expect(result.review.reconciliation.excludedEvidence).toHaveLength(1);
  expect(result.review.reconciliation.explained).toBe(2);
  expect(result.verification.verdict).toBe("unresolved");
});

it("excludes post-count records from proof and rejects excess support", async () => {
  const context = await setup("conflicting");
  start(context, "inventory-first");
  await complete(context, "inventory-first", 4);
  const result = context.loop.finish("inventory-first");
  expect(result.verification.verdict).toBe("unresolved");
});

it("validates submissions, keeps duplicate IDs stable, and scopes evidence reads and actions", async () => {
  const context = await setup();
  expect(() => startInvestigation(context.runtime, null)).toThrow();
  expect(() =>
    startInvestigation(context.runtime, { goal: "test", criteria: { ...criteria, extra: 1 } }),
  ).toThrow();
  const input = { submissionId: "stable-1", goal: "Explain the shortage", criteria };
  const opened = startInvestigation(context.runtime, input);
  expect(startInvestigation(context.runtime, input).incidentId).toBe(opened.incidentId);
  const handler = createRuntimeHandler(context.runtime);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const unauthorized = await fetch(`${origin}/api/runtime/investigations`, {
    method: "POST",
    headers: { Origin: "https://other.example", "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(unauthorized.status).toBe(403);
  const badAction = await fetch(
    `${origin}/api/runtime/investigations/${opened.incidentId}/finish`,
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: "pass" }),
    },
  );
  expect(badAction.status).toBe(400);
  const post = async (action: string) => {
    const response = await fetch(
      `${origin}/api/runtime/investigations/${opened.incidentId}/${action}`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()).investigation;
  };
  const plan = context.operations.orchestration.get(opened.incidentId);
  context.db.updateTask(task(context, opened.incidentId, "planner").operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      goal: plan.incident.goal,
      acceptanceCriteria: plan.incident.acceptanceCriteria.map((item) => item.criterionId),
      tasks: [
        { taskId: "reader", role: "data-steward-researcher", dependencies: ["planner"] },
        { taskId: "analyst", role: "data-steward-researcher", dependencies: ["reader"] },
        { taskId: "critic", role: "critic", dependencies: ["reader", "analyst"] },
      ],
    }),
  });
  await tick();
  await post("accept-plan");
  context.db.updateTask(task(context, opened.incidentId, "reader").operation.taskId, {
    status: "completed",
    result: "Scoped read ready",
  });
  await tick();
  const collected = await post("collect-evidence");
  expect(collected.readsCollected).toBe(true);
  expect(collected.synthetic).toBe(true);
  const confirmed = await post("confirm-evidence");
  const evidenceRows = task(context, opened.incidentId, "reader").evidenceIds.map(
    (id) => context.operations.records.get("evidenceItem", id)?.value,
  );
  const cited = evidenceRows
    .filter(
      (item) =>
        item &&
        (item.source.endsWith("inventory_transfers") ||
          item.source.endsWith("inventory_receipts") ||
          (item.source.endsWith("inventory_ledger_movements") &&
            JSON.parse(item.content).movement_type === "posted_receipt")),
    )
    .map((item) => item!.evidenceId);
  context.db.updateTask(task(context, opened.incidentId, "analyst").operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      bundleId: confirmed.reasoning.bundleId,
      primaryHypothesisId: "inventory-explanation",
      hypotheses: [
        {
          hypothesisId: "inventory-explanation",
          statement: "Three source-backed units",
          supportingEvidenceIds: cited,
          contradictingEvidenceIds: [],
          claimedExplainedUnits: 3,
          missingEvidence: [],
        },
      ],
    }),
  });
  await tick();
  await post("accept-analyst");
  context.db.updateTask(task(context, opened.incidentId, "critic").operation.taskId, {
    status: "completed",
    result: JSON.stringify({
      bundleId: confirmed.reasoning.bundleId,
      decision: "ACCEPT",
      hypothesisIds: ["inventory-explanation"],
      evidenceIds: cited,
      reasoning: "All shortage units have applicable source support",
      missingEvidence: [],
      nextTasks: [],
    }),
  });
  await tick();
  context.operations.reconcile(opened.incidentId);
  const proof = investigationView(context.runtime, opened.incidentId).evidence[0].evidenceId;
  expect(evidenceDetail(context.runtime, opened.incidentId, proof).source).toMatch(/^synthetic:/);
  expect(() => evidenceDetail(context.runtime, "another-incident", proof)).toThrow();
  expect((await post("finish")).report.verdict).toBe("pass");
});
