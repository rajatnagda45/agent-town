import { expect, it } from "vitest";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { prepareInventoryDemoPlan } from "../server/inventory-demo-plan.mjs";
import { INVENTORY_READS, createInventoryReader } from "../server/inventory-investigation.mjs";
import { reconcileInventoryEvidence } from "../server/inventory-reconciliation.mjs";
import { createSyntheticInventoryFixtures } from "../server/inventory-synthetic.mjs";

const now = new Date("2026-10-26T10:00:00Z");
const scope = {
  incidentId: "inventory-demo-17",
  taskId: "inventory-demo-read",
  agentId: "reader",
  seatId: "data",
  gatewayId: "gateway-1",
  sessionKey: "agent:reader:main",
  bindingRevision: 1,
};

it("prepares four clearly synthetic sources with separate incomplete and complete cases", () => {
  const plan = prepareInventoryDemoPlan({ now });
  expect(plan).toMatchObject({
    label: "SYNTHETIC DATA",
    proposedNamespace: "AGENT_TOWN_INVENTORY_DEMO",
    namespaceKind: "pending_installed_api_spec",
    sku: "SKU-17",
    locationId: "BIN-A",
    scenarios: ["incomplete", "complete"],
  });
  expect(Object.keys(plan.sources)).toEqual(["ledger", "count", "transfers", "receipts"]);
  expect(
    Object.fromEntries(
      Object.entries(plan.sources).map(([kind, source]) => [kind, source.rows.length]),
    ),
  ).toEqual({
    ledger: 6,
    count: 2,
    transfers: 2,
    receipts: 1,
  });
  for (const source of Object.values(plan.sources)) {
    expect(source.rows.every((row) => row.synthetic_label === "SYNTHETIC DATA")).toBe(true);
    expect(source.columns).toContain("scenario_id");
    expect(source.columns).toContain("observed_at");
  }
  expect(plan.sources.receipts.rows[0].scenario_id).toBe("complete");
  for (const kind of ["ledger", "count", "transfers"]) {
    const rows = plan.sources[kind].rows;
    const withoutScenario = (scenario: string) =>
      rows
        .filter((row) => row.scenario_id === scenario)
        .map((row) => {
          const copy = { ...row };
          delete copy.scenario_id;
          return copy;
        });
    expect(withoutScenario("complete")).toEqual(withoutScenario("incomplete"));
  }
  expect(plan.sources.receipts.rows[0].ledger_movement_id).toBe(
    plan.sources.ledger.rows.find(
      (row) => row.scenario_id === "complete" && row.movement_type === "posted_receipt",
    )?.movement_id,
  );
  const cutoff = Date.parse(plan.sources.count.rows[0].counted_at);
  expect(plan.sources.ledger.rows.every((row) => Date.parse(row.effective_at) < cutoff)).toBe(true);
  expect(plan.sources.transfers.rows.every((row) => Date.parse(row.occurred_at) < cutoff)).toBe(
    true,
  );
  expect(plan.sources.receipts.rows.every((row) => Date.parse(row.received_at) < cutoff)).toBe(
    true,
  );
});

it.each([
  ["incomplete", "incomplete", 2],
  ["complete", "explained", 3],
])(
  "reconciles the local %s mapping without any Zetaris write",
  async (scenario, status, explainedQuantity) => {
    const fixtures = createSyntheticInventoryFixtures(scenario, {
      sku: "SKU-17",
      locationId: "BIN-A",
      now,
      openingQuantity: 10,
      countedQuantity: 9,
    });
    const reader = createInventoryReader({
      mode: "synthetic",
      synthetic: createSyntheticDataSource(fixtures),
      now: () => now,
    });
    const reads: Record<string, unknown> = {};
    for (const [kind, templateId] of INVENTORY_READS) {
      const result = await reader.read({
        templateId,
        parameters: { scenarioId: scenario, sku: "SKU-17", locationId: "BIN-A" },
        scope,
      });
      const auditRef = `synthetic-test-${kind}`;
      reads[kind] = {
        ...result,
        auditRef,
        evidence: result.evidence.map((item) => ({ ...item, auditRef })),
      };
    }
    expect(
      reconcileInventoryEvidence(reads, {
        ...scope,
        scenarioId: scenario,
        sku: "SKU-17",
        locationId: "BIN-A",
        now,
      }),
    ).toMatchObject({
      status,
      ledgerQuantity: 12,
      countQuantity: 9,
      missingQuantity: 3,
      explainedQuantity,
    });
  },
);
