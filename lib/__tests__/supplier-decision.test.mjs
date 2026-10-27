import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { supplierRows } from "../server/supplier-demo-data.mjs";
import { reconcileSupplierDelivery } from "../server/supplier-reconciliation.mjs";
import { applySupplierPolicy } from "../server/supplier-policy.mjs";
import { DecisionMemory } from "../server/decision-memory.mjs";
import { mutationRequested, purchaseOrderId, routeGoal } from "../server/task-intent.mjs";

const cleanup = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

const ID_FIELD = {
  PURCHASE_ORDERS: "po_id",
  GOODS_RECEIPTS: "receipt_id",
  SHIPMENTS: "shipment_id",
  SUPPLIER_CONFIRMATIONS: "confirmation_id",
};
const KIND = {
  PURCHASE_ORDERS: "purchaseOrders",
  GOODS_RECEIPTS: "receipts",
  SHIPMENTS: "shipments",
  SUPPLIER_CONFIRMATIONS: "confirmations",
};
/** Evidence as the data service would return it for one PO; quantities as Zetaris strings. */
function readsFor(state, poId, { freshUntil = "2999-01-01T00:00:00.000Z" } = {}) {
  const tables = supplierRows(state);
  return Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [
      KIND[table],
      {
        evidence: rows
          .filter((row) => row.po_id === poId)
          .map((row) => ({
            evidenceId: `ev_${table}_${row[ID_FIELD[table]]}`,
            recordId: row[ID_FIELD[table]],
            freshUntil,
            content: JSON.stringify(
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? String(v) : v]),
              ),
            ),
          })),
      },
    ]),
  );
}
const codes = (checks) => Object.fromEntries(checks.conclusions.map((c) => [c.code, c.quantity]));

it("reconciles each order from its rows only", () => {
  const day1 = reconcileSupplierDelivery(readsFor("day1", "PO-1042"), { poId: "PO-1042" });
  expect(day1).toMatchObject({ status: "explained", ordered: 100, received: 85, gap: 15 });
  expect(codes(day1)).toEqual({ in_transit: 15 });
  expect(day1.conclusions[0].shipments).toEqual([
    expect.objectContaining({ shipmentId: "SHP-1042-B", quantity: 15 }),
  ]);
  const day2 = reconcileSupplierDelivery(readsFor("day2", "PO-1042"), { poId: "PO-1042" });
  expect(codes(day2)).toEqual({ receipt_not_recorded: 15 });
  const short = reconcileSupplierDelivery(readsFor("day1", "PO-1044"), { poId: "PO-1044" });
  expect(codes(short)).toEqual({ short_shipment: 10 });
  const complete = reconcileSupplierDelivery(readsFor("day1", "PO-1043"), { poId: "PO-1043" });
  expect(complete.status).toBe("no_discrepancy");
  const missing = reconcileSupplierDelivery(readsFor("day1", "PO-9999"), { poId: "PO-9999" });
  expect(missing).toMatchObject({ status: "not_found" });
  expect(missing.reason).toContain("No other order was substituted");
  const stale = reconcileSupplierDelivery(
    readsFor("day1", "PO-1042", { freshUntil: "2000-01-01T00:00:00.000Z" }),
    { poId: "PO-1042" },
  );
  expect(stale.stale.length).toBeGreaterThan(0);
});

it("decides from explicit policy and always leaves payment and record changes to a human", () => {
  const day1 = reconcileSupplierDelivery(readsFor("day1", "PO-1042"), { poId: "PO-1042" });
  const first = applySupplierPolicy({ poId: "PO-1042", checks: day1 });
  const fired = (decision) => decision.rules.filter((r) => r.fired).map((r) => r.id);
  expect(first.status).toBe("recommended");
  expect(first.decision).toContain("Confirm the remaining shipment");
  expect(first.decision).toContain("SHP-1042-B");
  expect(fired(first)).toEqual(["evidence_required", "in_transit", "payment_hold"]);
  expect(first.approvals.join(" ")).toContain("requires authorized human approval");
  expect(first.memory.status).toBe("none");

  const day2 = reconcileSupplierDelivery(readsFor("day2", "PO-1042"), { poId: "PO-1042" });
  const remembered = { gap: 15, conclusions: { in_transit: 15 }, evidenceIds: ["ev_old"] };
  const second = applySupplierPolicy({ poId: "PO-1042", checks: day2, recalled: remembered });
  expect(second.memory.status).toBe("conflicts");
  expect(fired(second)).toContain("memory_freshness");
  expect(fired(second)).toContain("receipt_correction");
  expect(second.decision).toContain("record the missing goods receipt");
  expect(second.approvals.some((a) => a.includes("changes records"))).toBe(true);

  const same = applySupplierPolicy({ poId: "PO-1042", checks: day1, recalled: remembered });
  expect(same.memory.status).toBe("confirmed");
  expect(fired(same)).not.toContain("memory_freshness");

  const missing = reconcileSupplierDelivery(readsFor("day1", "PO-9999"), { poId: "PO-9999" });
  const blocked = applySupplierPolicy({ poId: "PO-9999", checks: missing, recalled: remembered });
  expect(blocked).toMatchObject({
    status: "blocked",
    actions: [],
    approvals: [],
    confidence: null,
  });
  expect(fired(blocked)).toEqual(["insufficient_data"]);

  const stale = applySupplierPolicy({
    poId: "PO-1042",
    checks: reconcileSupplierDelivery(
      readsFor("day1", "PO-1042", { freshUntil: "2000-01-01T00:00:00.000Z" }),
      { poId: "PO-1042" },
    ),
  });
  expect(stale.status).toBe("needs_investigation");
  expect(stale.decision).toContain("Re-check the stale");
  expect(stale.confidence).toBe(0.5);
});

it("remembers only verified findings and recalls them only for the same order", () => {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const memory = new DecisionMemory(db);
  const checks = reconcileSupplierDelivery(readsFor("day1", "PO-1042"), { poId: "PO-1042" });
  const decision = applySupplierPolicy({ poId: "PO-1042", checks });
  expect(() =>
    memory.remember({ poId: "PO-1042", taskId: "t1", verified: false, checks, decision }),
  ).toThrow(/Only verified findings/);
  expect(memory.recall("PO-1042")).toBeNull();
  memory.remember({ poId: "PO-1042", taskId: "t1", verified: true, checks, decision });
  // A different session or task still recalls it; another order never does.
  expect(memory.recall("po-1042", { taskId: "t2" })).toMatchObject({
    taskId: "t1",
    conclusions: { in_transit: 15 },
    label: "SYNTHETIC DATA",
  });
  expect(memory.recall("PO-9999")).toBeNull();
  expect(db.records("decisionMemoryLedger").map((row) => row.action)).toEqual(
    expect.arrayContaining(["remember", "recall"]),
  );
});

it("routes named purchase orders to the supplier investigation without treating them as writes", () => {
  const demo =
    "Investigate the missing 15 units from purchase order PO-1042. Check the purchase order, goods receipts, shipment transfers and supplier records. Recall any previous findings and recommend the next action. Don't approve payment or change records without authorization.";
  expect(routeGoal(demo)).toMatchObject({
    domain: "supplier_delivery",
    workflow: "zetaris-investigation",
    dataSources: ["SUPPLIER"],
    risk: "read_only",
  });
  expect(purchaseOrderId("check po 1042 please")).toBe("PO-1042");
  expect(routeGoal("Investigate the purchase order discrepancy").clarification).toContain(
    "Which purchase order",
  );
  expect(routeGoal("Approve payment for PO-1042").risk).toBe("approval_required");
  expect(mutationRequested("Purchase 10 widgets now")).toBe(true);
  expect(routeGoal("Explain SKU-17 shortage at BIN-A. Do not modify inventory.").domain).toBe(
    "inventory",
  );
});

it("keeps findings in the H-MEM engine across restarts, learns from feedback and supersedes", () => {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  let clock = Date.parse("2026-10-27T12:00:00.000Z");
  const now = () => clock;
  const day1 = reconcileSupplierDelivery(readsFor("day1", "PO-1042"), { poId: "PO-1042" });
  const first = new DecisionMemory(db, { now });
  const saved = first.remember({
    poId: "PO-1042",
    taskId: "run1",
    verified: true,
    checks: day1,
    decision: applySupplierPolicy({ poId: "PO-1042", checks: day1 }),
  });
  expect(saved.memoryId).toBeTruthy();
  // A restarted server rebuilds the engine from the database and still recalls it.
  clock += 3600000;
  const restarted = new DecisionMemory(db, { now });
  const recalled = restarted.recall("PO-1042", { taskId: "run2" });
  expect(recalled).toMatchObject({ taskId: "run1", memoryId: saved.memoryId, confidence: 1 });
  const record = restarted.engine.store.get(saved.memoryId);
  expect(record).toMatchObject({ layer: "long_term", source: "agent-town:work-task:run1" });
  expect(record.provenance).toMatchObject({ origin: "plan_completion" });
  // Contradicted by current records: H-MEM lowers its confidence by exactly 0.2.
  expect(restarted.feedback(recalled, "conflicts", { taskId: "run2" })).toBe(0.8);
  // A newer verified finding supersedes the old one, which is no longer recalled.
  const day2 = reconcileSupplierDelivery(readsFor("day2", "PO-1042"), { poId: "PO-1042" });
  const newer = restarted.remember({
    poId: "PO-1042",
    taskId: "run2",
    verified: true,
    checks: day2,
    decision: applySupplierPolicy({ poId: "PO-1042", checks: day2, recalled }),
  });
  expect(restarted.engine.store.get(saved.memoryId).supersededBy).toBe(newer.memoryId);
  expect(restarted.recall("PO-1042")).toMatchObject({
    taskId: "run2",
    conclusions: { receipt_not_recorded: 15 },
  });
  expect(restarted.recall("PO-1043")).toBeNull();
});
