/** One read-only inventory investigation through the integrated OfficeOperations runtime. */
import { INVENTORY_TEMPLATES } from "./inventory-templates.mjs";
import { compileReadQuery, createDataReader } from "./data-source.mjs";

const READS = Object.freeze([
  ["ledger", "inventory-ledger-movements"],
  ["count", "inventory-physical-counts"],
  ["transfers", "inventory-transfers"],
  ["receipts", "inventory-receipts"],
]);
export { INVENTORY_TEMPLATES };
export const inventoryId = (value) =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value);

/** Live mode requires an approved instance-specific mapping; example tables stay synthetic. */
/** @param {{mode: "synthetic"|"zetaris", synthetic?: any, zetaris?: any, approvedLiveTemplates?: Record<string, import("./data-source.d.mts").ReadTemplate>, now?: () => Date}} options */
export function createInventoryReader({ mode, synthetic, zetaris, approvedLiveTemplates, now }) {
  if (mode === "zetaris" && !approvedLiveTemplates)
    throw new Error("Approved live inventory templates are required for Zetaris mode.");
  const templates = mode === "zetaris" ? approvedLiveTemplates : INVENTORY_TEMPLATES;
  if (mode === "zetaris" && READS.some(([, id]) => !templates[id]))
    throw new Error("Approved live inventory templates must cover all four reads.");
  if (mode === "zetaris") {
    for (const [, id] of READS) {
      const template = templates[id];
      if (
        template.id !== id ||
        typeof template.source !== "string" ||
        template.source.startsWith("example_") ||
        typeof template.sql !== "string" ||
        template.sql.includes("example_inventory_") ||
        !template.timestampField ||
        !Number.isSafeInteger(template.maxAgeMs) ||
        template.maxAgeMs < 1 ||
        INVENTORY_TEMPLATES[id].fields.some((field) => !template.fields?.includes(field))
      )
        throw new Error("Live inventory mapping lacks an approved source or canonical fields.");
      compileReadQuery(template, {
        scenarioId: "mapping-check",
        sku: "mapping-check",
        locationId: "mapping-check",
      });
    }
  }
  return Object.assign(createDataReader({ mode, templates, synthetic, zetaris, now }), {
    inventoryTemplates: templates,
  });
}

export function startInventoryInvestigation(
  operations,
  { incidentId, scenarioId, sku, locationId, createdAt = new Date().toISOString() },
) {
  if (![incidentId, scenarioId, sku, locationId].every(inventoryId))
    throw new Error(
      "Inventory investigation requires bounded incident, scenario, SKU and location IDs.",
    );
  return operations.create({
    incident: {
      incidentId,
      goal: `Reconcile inventory for SKU ${sku} at ${locationId} in scenario ${scenarioId}`,
      constraints: ["Read-only investigation", "Do not adjust inventory or place an order"],
      taskType: "inventory-investigation",
      acceptanceCriteria: [
        {
          criterionId: "quantity-reconciliation",
          description:
            "Cite fresh ledger, count, transfer and receipt records for every quantity conclusion; leave any unexplained units unresolved",
        },
      ],
      createdAt,
    },
    tasks: [
      {
        taskId: "inventory-read",
        role: "data-steward-researcher",
        message: `Read ledger movements, physical counts, transfers and receipts for scenario ${scenarioId}, SKU ${sku} at ${locationId}. Preserve source IDs and timestamps. Do not write inventory.`,
      },
      {
        taskId: "inventory-critic",
        role: "critic",
        message: `Check the arithmetic, source ownership, freshness and audit trail for scenario ${scenarioId}, SKU ${sku} at ${locationId}. Issue a separate verification verdict only from cited evidence.`,
        dependencies: ["inventory-read"],
        requiredEvidenceFrom: ["inventory-read"],
      },
    ],
  });
}

/** Each read uses DataEvidenceService for binding checks, storage, and a read audit. */
/** @returns {Promise<Record<string, any>>} */
export async function readInventoryEvidence(
  operations,
  { incidentId, taskId, scenarioId, sku, locationId },
) {
  if (![incidentId, taskId, scenarioId, sku, locationId].every(inventoryId))
    throw new Error("Invalid inventory read IDs.");
  if (!operations.data) throw new Error("A reviewed inventory data reader is not configured.");
  const reads = {};
  for (const [kind, templateId] of READS) {
    const read = await operations.data.read({
      incidentId,
      taskId,
      templateId,
      parameters: { scenarioId, sku, locationId },
    });
    if (read.evidence.length) {
      operations.orchestration.attachEvidence({
        incidentId,
        taskId,
        evidenceIds: read.evidence.map((item) => item.evidenceId),
      });
      operations.syncPlan(operations.orchestration.get(incidentId));
    }
    reads[kind] = read;
  }
  return reads;
}

export { READS as INVENTORY_READS };
