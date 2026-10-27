import { expect, it } from "vitest";
import { createInventoryStartupReader } from "../server/inventory-startup.mjs";
import { INVENTORY_TEMPLATES } from "../server/inventory-investigation.mjs";

const scope = {
  incidentId: "inventory-startup",
  taskId: "inventory-read",
  agentId: "reader",
  seatId: "data",
  gatewayId: "gateway-1",
  sessionKey: "agent:reader:main",
  bindingRevision: 1,
};

it("leaves the existing server without a data reader until inventory mode is selected", () => {
  expect(createInventoryStartupReader({})).toBeUndefined();
});

it("starts the explicitly selected synthetic case through the existing data reader", async () => {
  const reader = createInventoryStartupReader({
    AGENT_TOWN_INVENTORY_MODE: "synthetic",
    AGENT_TOWN_INVENTORY_SYNTHETIC_CASE: "complete",
  });
  const result = await reader?.read({
    templateId: "inventory-physical-counts",
    parameters: { scenarioId: "complete", sku: "SKU-42", locationId: "WH-A" },
    scope,
  });
  expect(result).toMatchObject({
    mode: "synthetic",
    scope,
    evidence: [{ source: "synthetic:example_inventory_physical_counts" }],
  });
});

it("selects the approved SKU-17/BIN-A synthetic demonstration profile explicitly", async () => {
  const reader = createInventoryStartupReader({
    AGENT_TOWN_INVENTORY_MODE: "synthetic",
    AGENT_TOWN_INVENTORY_SYNTHETIC_CASE: "incomplete",
    AGENT_TOWN_INVENTORY_SYNTHETIC_PROFILE: "sku17-bin-a",
  });
  const result = await reader?.read({
    templateId: "inventory-physical-counts",
    parameters: { scenarioId: "incomplete", sku: "SKU-17", locationId: "BIN-A" },
    scope,
  });
  expect(result?.evidence[0].content).toContain('"counted_quantity":9');
  expect(result?.evidence[0].content).toContain('"synthetic_label":"SYNTHETIC DATA"');
});

it("selects each labelled scenario in the paired local revision preview", async () => {
  const reader = createInventoryStartupReader({
    AGENT_TOWN_INVENTORY_MODE: "synthetic",
    AGENT_TOWN_INVENTORY_SYNTHETIC_CASE: "demo-pair",
    AGENT_TOWN_INVENTORY_SYNTHETIC_PROFILE: "sku17-bin-a",
  });
  for (const scenarioId of ["incomplete", "complete"]) {
    const result = await reader?.read({
      templateId: "inventory-physical-counts",
      parameters: { scenarioId, sku: "SKU-17", locationId: "BIN-A" },
      scope,
    });
    expect(result?.evidence[0].content).toContain(`"scenario_id":"${scenarioId}"`);
    expect(result?.evidence[0].content).toContain('"synthetic_label":"SYNTHETIC DATA"');
  }
  await expect(
    reader?.read({
      templateId: "inventory-physical-counts",
      parameters: { scenarioId: "unknown", sku: "SKU-17", locationId: "BIN-A" },
      scope,
    }),
  ).rejects.toThrow(/no synthetic fixture/i);
});

it("fails closed for missing synthetic selection and unapproved live configuration", () => {
  expect(() => createInventoryStartupReader({ AGENT_TOWN_INVENTORY_MODE: "synthetic" })).toThrow(
    /explicit synthetic inventory case/i,
  );
  expect(() => createInventoryStartupReader({ AGENT_TOWN_INVENTORY_MODE: "zetaris" })).toThrow(
    /approved live inventory table and field mappings/i,
  );
  expect(() => createInventoryStartupReader({ AGENT_TOWN_INVENTORY_MODE: "other" })).toThrow(
    /unknown inventory reader mode/i,
  );
  expect(() =>
    createInventoryStartupReader(
      { AGENT_TOWN_INVENTORY_MODE: "zetaris" },
      { approvedLiveTemplates: INVENTORY_TEMPLATES },
    ),
  ).toThrow(/missing Zetaris inventory settings/i);
});
