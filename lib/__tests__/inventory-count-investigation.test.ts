import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import {
  INVENTORY_COUNT_EXAMPLE_TEMPLATE,
  createInventoryCountReader,
  createInventoryCountInvestigation,
  readInventoryCount,
} from "../server/inventory-count-investigation.mjs";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";

class MockGateway {
  provider = "openclaw";
  audit = new ContractAudit(fixture);
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
        agents: [{ id: "main" }, { id: "reader" }, { id: "reviewer" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(rows: unknown[]) {
  const db = new TaskDatabase(":memory:");
  const runtime = new TaskRuntime({
    db,
    gateway: new MockGateway(),
    gatewayId: "gateway-inventory",
  });
  await runtime.refresh();
  for (const [seatId, agentId] of [
    ["inventory-reader", "reader"],
    ["inventory-reviewer", "reviewer"],
  ])
    runtime.saveSeat({
      seatId,
      label: seatId,
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId },
      revision: 0,
    });
  const observedAt = new Date().toISOString();
  const reader = createInventoryCountReader({
    mode: "synthetic",
    synthetic: createSyntheticDataSource({
      [INVENTORY_COUNT_EXAMPLE_TEMPLATE.id]: {
        parameters: { sku: "SKU-17", locationId: "BIN-A" },
        rows: rows.map((row) => ({ observed_at: observedAt, ...(row as object) })),
      },
    }),
  });
  const operations = new OfficeOperations(runtime, {
    dataReader: reader,
    specialists: {
      grants: [
        { manifestId: "data-steward-researcher", seatId: "inventory-reader" },
        { manifestId: "critic", seatId: "inventory-reviewer" },
      ],
      enforcement: { authorizeSync: () => true },
    },
  });
  cleanup.push(() => {
    operations.close();
    runtime.close();
    db.close();
  });
  return { db, operations };
}

it("investigates one synthetic inventory variance through runtime, evidence and explicit verification", async () => {
  const { db, operations } = await setup([
    {
      count_id: "COUNT-17",
      sku: "SKU-17",
      location_id: "BIN-A",
      system_qty: 12,
      counted_qty: 9,
    },
  ]);
  const incidentId = "inventory-17";
  const plan = createInventoryCountInvestigation(operations, {
    incidentId,
    sku: "SKU-17",
    locationId: "BIN-A",
  });
  expect(plan.children).toHaveLength(2);
  expect(operations.journal.list("dispatch")).toHaveLength(1);
  expect(
    createInventoryCountInvestigation(operations, {
      incidentId,
      sku: "SKU-17",
      locationId: "BIN-A",
    }).incident.createdAt,
  ).toBe(plan.incident.createdAt);
  expect(operations.journal.list("dispatch")).toHaveLength(1);
  const readTaskId = plan.children[0].operation.taskId;
  db.updateTask(readTaskId, { status: "completed", result: "Synthetic count reviewed" });
  await tick();
  const finding = await readInventoryCount(operations, {
    incidentId,
    taskId: readTaskId,
    sku: "SKU-17",
    locationId: "BIN-A",
  });
  expect(finding).toMatchObject({
    source: "synthetic:inventory_cycle_counts",
    recordId: "COUNT-17",
    recordedQuantity: 12,
    countedQuantity: 9,
    variance: -3,
  });
  expect(db.record("operation.dataRead", finding.auditRef)?.evidenceIds).toContain(
    finding.evidenceId,
  );
  expect(operations.records.list("verificationResult")).toHaveLength(0);
  const reviewTaskId = operations.reconcile(incidentId).children[1].operation.taskId;
  expect(operations.journal.list("dispatch")).toHaveLength(2);
  db.updateTask(reviewTaskId, { status: "completed", result: "Synthetic variance checked" });
  await tick();
  operations.reconcile(incidentId);
  expect(operations.records.list("verificationResult")).toHaveLength(0);
  const verified = operations.recordVerification({
    verification: {
      verificationId: "inventory-17-verified",
      incidentId,
      taskId: reviewTaskId,
      verdict: "pass",
      evidenceIds: [finding.evidenceId],
      reason: "Mocked reviewer checked the synthetic count: 9 minus 12 equals -3.",
      checkedAt: new Date().toISOString(),
    },
  });
  expect(verified.verification.verdict).toBe("pass");
  expect(verified.lesson).toBeNull();
});

it("rejects an out-of-scope synthetic count instead of reporting a variance", async () => {
  const { db, operations } = await setup([
    {
      count_id: "COUNT-OTHER",
      sku: "SKU-OTHER",
      location_id: "BIN-A",
      system_qty: 12,
      counted_qty: 9,
    },
  ]);
  const incidentId = "inventory-scope";
  const plan = createInventoryCountInvestigation(operations, {
    incidentId,
    sku: "SKU-17",
    locationId: "BIN-A",
  });
  db.updateTask(plan.children[0].operation.taskId, { status: "completed", result: "Read" });
  await tick();
  await expect(
    readInventoryCount(operations, {
      incidentId,
      taskId: plan.children[0].operation.taskId,
      sku: "SKU-17",
      locationId: "BIN-A",
    }),
  ).rejects.toThrow(/does not match/);
  expect(operations.records.list("evidenceItem")).toHaveLength(0);
  expect(operations.records.list("verificationResult")).toHaveLength(0);
});
