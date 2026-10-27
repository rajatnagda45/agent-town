import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { compileReadQuery } from "../server/data-source.mjs";
import { createSyntheticInventoryFixtures } from "../server/inventory-synthetic.mjs";
import {
  INVENTORY_READS,
  INVENTORY_TEMPLATES,
  createInventoryReader,
  readInventoryEvidence,
  startInventoryInvestigation,
} from "../server/inventory-investigation.mjs";
import { reconcileInventoryEvidence } from "../server/inventory-reconciliation.mjs";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps all four reviewed demonstration queries scoped and read-only", () => {
  for (const [, templateId] of INVENTORY_READS) {
    const sql = compileReadQuery(INVENTORY_TEMPLATES[templateId], {
      scenarioId: "complete",
      sku: "SKU-42",
      locationId: "WH-A",
    });
    expect(sql.startsWith("SELECT ")).toBe(true);
    expect(sql).toContain("scenario_id = 'complete'");
    expect(sql).toContain("sku = 'SKU-42'");
    expect(sql).toContain("location_id = 'WH-A'");
  }
});

// Reuse compiled fixture schemas; each gateway still owns its mutable execution state.
const fixtureAudit = new ContractAudit(fixture);
class MockGateway {
  provider = "openclaw";
  status = "connected";
  audit = fixtureAudit;
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
        agents: [{ id: "main" }, { id: "reader" }, { id: "reviewer" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}

async function setup(
  scenario: string,
  options: {
    sku?: string;
    locationId?: string;
    openingQuantity?: number;
    countedQuantity?: number;
    mutate?: (fixtures: ReturnType<typeof createSyntheticInventoryFixtures>) => void;
  } = {},
) {
  const {
    sku = "SKU-42",
    locationId = "WH-A",
    openingQuantity = 8,
    countedQuantity = 7,
    mutate,
  } = options;
  const dir = mkdtempSync(join(tmpdir(), "agent-town-inventory-"));
  const db = new TaskDatabase(join(dir, "tasks.sqlite"));
  const runtime = new TaskRuntime({ db, gateway: new MockGateway(), gatewayId: "gateway-1" });
  await runtime.refresh();
  for (const [seatId, agentId] of [
    ["data", "reader"],
    ["critic", "reviewer"],
  ])
    runtime.saveSeat({
      seatId,
      label: seatId,
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  const fixtures = createSyntheticInventoryFixtures(scenario, {
    sku,
    locationId,
    openingQuantity,
    countedQuantity,
  });
  mutate?.(fixtures);
  const reader = createInventoryReader({
    mode: "synthetic",
    synthetic: createSyntheticDataSource(fixtures),
  });
  const operations = new OfficeOperations(runtime, {
    dataReader: reader,
    specialists: {
      grants: [
        { manifestId: "data-steward-researcher", seatId: "data" },
        { manifestId: "critic", seatId: "critic" },
      ],
      enforcement: { authorizeSync: () => true },
    },
  });
  cleanups.push(() => {
    operations.close();
    runtime.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const input = {
    incidentId: `inventory-${scenario}`,
    scenarioId: scenario,
    sku,
    locationId,
  };
  const plan = startInventoryInvestigation(operations, input);
  const taskId = plan.children[0].operation.taskId;
  db.updateTask(taskId, { status: "completed", result: "Mock gateway read completed" });
  await tick();
  return { db, runtime, operations, input, taskId };
}

it.each([
  ["complete", "explained", 3, 0],
  ["incomplete", "incomplete", 2, 1],
  ["conflicting", "conflicting", 4, -1],
])(
  "reconciles the %s synthetic case from persisted audited source rows",
  async (scenario, status, explained, difference) => {
    const { db, operations, input, taskId } = await setup(scenario);
    const reads = await readInventoryEvidence(operations, { ...input, taskId });
    const actualIds = new Set<string>();
    for (const [kind, templateId] of INVENTORY_READS) {
      const read = reads[kind];
      const audit = db.record("operation.dataRead", read.auditRef);
      expect(audit).toMatchObject({
        incidentId: input.incidentId,
        taskId,
        templateId,
        mode: "synthetic",
        binding: read.scope,
      });
      for (const item of read.evidence) {
        expect(item.source).toBe(`synthetic:${INVENTORY_TEMPLATES[templateId].source}`);
        expect(item.sourceTimestamp).toBeTruthy();
        expect(item.freshUntil).toBeTruthy();
        expect(item.auditRef).toBe(read.auditRef);
        expect(operations.records.get("evidenceItem", item.evidenceId)?.value).toEqual(item);
        actualIds.add(item.evidenceId);
      }
    }
    expect(actualIds.size).toBe(scenario === "incomplete" ? 5 : 6);
    const result = reconcileInventoryEvidence(reads, { ...input, taskId });
    expect(result).toMatchObject({
      status,
      ledgerQuantity: 10,
      countQuantity: 7,
      missingQuantity: 3,
      explainedQuantity: explained,
      difference,
      sourceMode: "synthetic",
    });
    if (!("openingAt" in result)) throw new Error("Expected a reconciled inventory result.");
    expect(Date.parse(result.openingAt)).toBeLessThan(Date.parse(result.countCutoffAt));
    expect(result.excludedEvidence).toEqual([]);
    expect(
      result.conclusions.every((entry: { evidenceIds: string[] }) => entry.evidenceIds.length > 0),
    ).toBe(true);
    for (const conclusion of result.conclusions)
      for (const id of conclusion.evidenceIds) expect(actualIds.has(id)).toBe(true);
    expect(reconcileInventoryEvidence(reads, { ...input, taskId })).toEqual(result);
    expect(operations.records.list("verificationResult")).toHaveLength(0);
  },
);

it("derives each shortage from the incident's own persisted SKU, location and quantities", async () => {
  const first = await setup("complete", {
    sku: "SKU-88",
    locationId: "RACK-Q",
    openingQuantity: 21,
    countedQuantity: 20,
  });
  const firstReads = await readInventoryEvidence(first.operations, {
    ...first.input,
    taskId: first.taskId,
  });
  expect(
    reconcileInventoryEvidence(firstReads, { ...first.input, taskId: first.taskId }),
  ).toMatchObject({
    sku: "SKU-88",
    locationId: "RACK-Q",
    ledgerQuantity: 23,
    countQuantity: 20,
    missingQuantity: 3,
    explainedQuantity: 3,
    difference: 0,
  });

  const second = await setup("incomplete", {
    sku: "SKU-9",
    locationId: "AISLE-7",
    openingQuantity: 21,
    countedQuantity: 20,
    mutate: (fixtures) => {
      fixtures["inventory-physical-counts"].rows[0].counted_quantity = 17;
    },
  });
  const secondReads = await readInventoryEvidence(second.operations, {
    ...second.input,
    taskId: second.taskId,
  });
  const result = reconcileInventoryEvidence(secondReads, {
    ...second.input,
    taskId: second.taskId,
  });
  expect(result).toMatchObject({
    status: "incomplete",
    sku: "SKU-9",
    locationId: "AISLE-7",
    ledgerQuantity: 23,
    countQuantity: 17,
    missingQuantity: 6,
    explainedQuantity: 2,
    difference: 4,
  });
  expect(
    result.conclusions.find((item: { code: string }) => item.code === "unposted_transfer_out")
      ?.evidenceIds,
  ).toEqual(secondReads.transfers.evidence.map((item: { evidenceId: string }) => item.evidenceId));
});

it.each([
  ["zero variance", 10, "explained", 0],
  ["unsupported surplus", 11, "unresolved", undefined],
])("handles %s explicitly", async (_label, counted, status, missing) => {
  const { operations, input, taskId } = await setup("incomplete", {
    mutate: (fixtures) => {
      fixtures["inventory-physical-counts"].rows[0].counted_quantity = counted;
      fixtures["inventory-transfers"].rows = [];
    },
  });
  const reads = await readInventoryEvidence(operations, { ...input, taskId });
  const result = reconcileInventoryEvidence(reads, { ...input, taskId });
  expect(result.status).toBe(status);
  if (status === "explained")
    expect(result).toMatchObject({ missingQuantity: missing, explainedQuantity: 0, difference: 0 });
  else
    expect(result).toMatchObject({
      reason: expect.stringMatching(/surplus.*unsupported/i),
      conclusions: [],
    });
});

it.each([
  ["post_count", "after_count", 2, 1],
  ["post_count_receipt", "after_count", 1, 2],
  ["pre_opening", "before_opening", 1, 1],
])(
  "excludes %s source events from the count-cutoff calculation",
  async (scenario, reason, excludedCount, explainedQuantity) => {
    const { operations, input, taskId } = await setup(scenario);
    const reads = await readInventoryEvidence(operations, { ...input, taskId });
    const result = reconcileInventoryEvidence(reads, { ...input, taskId });
    expect(result).toMatchObject({
      status: "incomplete",
      ledgerQuantity: 10,
      countQuantity: 7,
      missingQuantity: 3,
      explainedQuantity,
      difference: 3 - explainedQuantity,
    });
    if (!("excludedEvidence" in result)) throw new Error("Expected a reconciled inventory result.");
    expect(result.excludedEvidence).toHaveLength(excludedCount);
    expect(
      result.excludedEvidence.some((entry: { reason: string }) => entry.reason === reason),
    ).toBe(true);
    const conclusionIds = new Set(
      result.conclusions.flatMap((entry: { evidenceIds: string[] }) => entry.evidenceIds),
    );
    for (const excluded of result.excludedEvidence)
      expect(conclusionIds.has(excluded.evidenceId)).toBe(false);
  },
);

it.each([
  "missing_event_time",
  "missing_count_time",
  "missing_ledger_time",
  "missing_receipt_time",
  "boundary_count",
  "boundary_opening",
])("keeps %s timing ambiguity unresolved despite fresh source retrieval", async (scenario) => {
  const { operations, input, taskId } = await setup(scenario);
  const reads = await readInventoryEvidence(operations, { ...input, taskId });
  expect(reads.ledger.evidence[0].freshUntil).toBeTruthy();
  expect(reconcileInventoryEvidence(reads, { ...input, taskId })).toMatchObject({
    status: "unresolved",
    conclusions: [],
  });
});

it.each(["missing", "stale"])(
  "keeps the %s synthetic evidence case unresolved",
  async (scenario) => {
    const { db, operations, input, taskId } = await setup(scenario);
    const reads = await readInventoryEvidence(operations, { ...input, taskId });
    expect(db.record("operation.dataRead", reads.count.auditRef)).toBeTruthy();
    expect(reads.count.evidence).toHaveLength(scenario === "missing" ? 0 : 1);
    expect(reconcileInventoryEvidence(reads, { ...input, taskId })).toMatchObject({
      status: "unresolved",
      conclusions: [],
    });
    expect(operations.records.list("verificationResult")).toHaveLength(0);
  },
);

it("rejects mixed source ownership and an unapproved live mapping", async () => {
  const { operations, input, taskId } = await setup("complete");
  const reads = await readInventoryEvidence(operations, { ...input, taskId });
  const altered = structuredClone(reads);
  altered.receipts.evidence[0].source = "zetaris:example_inventory_receipts";
  expect(reconcileInventoryEvidence(altered, { ...input, taskId }).status).toBe("unresolved");
  altered.receipts.evidence[0].source = reads.receipts.evidence[0].source;
  altered.receipts.evidence[0].auditRef = "unrelated-audit";
  expect(reconcileInventoryEvidence(altered, { ...input, taskId }).status).toBe("unresolved");
  const crossScenario = structuredClone(reads);
  crossScenario.receipts.evidence[0].content = crossScenario.receipts.evidence[0].content.replace(
    '"scenario_id":"complete"',
    '"scenario_id":"incomplete"',
  );
  expect(reconcileInventoryEvidence(crossScenario, { ...input, taskId }).status).toBe("unresolved");
  const duplicate = structuredClone(reads);
  duplicate.receipts.evidence.push({
    ...duplicate.receipts.evidence[0],
    evidenceId: "duplicate-evidence-id",
  });
  expect(reconcileInventoryEvidence(duplicate, { ...input, taskId }).status).toBe("unresolved");
  expect(() =>
    createInventoryReader({ mode: "zetaris", zetaris: { query: async () => [] } }),
  ).toThrow(/approved live inventory templates/i);
  expect(() =>
    createInventoryReader({
      mode: "zetaris",
      zetaris: { query: async () => [] },
      approvedLiveTemplates: INVENTORY_TEMPLATES,
    }),
  ).toThrow(/approved source or canonical fields/i);
});

it("retains the DataEvidenceService binding check after a seat revision", async () => {
  const { runtime, operations, input, taskId } = await setup("complete");
  runtime.saveSeat({
    seatId: "data",
    label: "data",
    assigned: true,
    seatType: "agent",
    agentConfig: { agentId: "reader" },
    revision: 1,
  });
  await expect(readInventoryEvidence(operations, { ...input, taskId })).rejects.toThrow(/binding/i);
  expect(operations.records.list("evidenceItem")).toHaveLength(0);
});
