import { createDataReader } from "./data-source.mjs";

/** Example catalog mapping for one read-only SKU/location cycle-count investigation.
 * A live Zetaris deployment must replace this mapping with a reviewed catalog view.
 * @type {import("./data-source.mjs").ReadTemplate} */
export const INVENTORY_COUNT_EXAMPLE_TEMPLATE = Object.freeze({
  id: "inventory-cycle-count",
  source: "inventory_cycle_counts",
  sql: "SELECT count_id, observed_at, sku, location_id, system_qty, counted_qty FROM inventory_cycle_counts WHERE sku = :sku AND location_id = :locationId",
  parameters: { sku: "text", locationId: "text" },
  recordIdField: "count_id",
  timestampField: "observed_at",
  fields: ["sku", "location_id", "system_qty", "counted_qty"],
  maxAgeMs: 15 * 60 * 1000,
});

const key = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

function findingFromItem(item, { sku, locationId }) {
  const content = JSON.parse(item.content);
  const variance = content.counted_qty - content.system_qty;
  if (
    !["synthetic:inventory_cycle_counts", "zetaris:inventory_cycle_counts"].includes(item.source) ||
    content.sku !== sku ||
    content.location_id !== locationId ||
    !Number.isSafeInteger(content.system_qty) ||
    content.system_qty < 0 ||
    !Number.isSafeInteger(content.counted_qty) ||
    content.counted_qty < 0 ||
    !Number.isSafeInteger(variance)
  )
    throw new Error("Cycle-count evidence does not match the requested inventory scope.");
  return {
    evidenceId: item.evidenceId,
    recordId: item.recordId,
    source: item.source,
    sourceTimestamp: item.sourceTimestamp,
    freshUntil: item.freshUntil,
    sku,
    locationId,
    recordedQuantity: content.system_qty,
    countedQuantity: content.counted_qty,
    variance,
  };
}

/** Validate the domain row before DataEvidenceService persists or attaches it. */
export function createInventoryCountReader({ mode, zetaris, synthetic, now } = {}) {
  const reader = createDataReader({
    mode,
    templates: { [INVENTORY_COUNT_EXAMPLE_TEMPLATE.id]: INVENTORY_COUNT_EXAMPLE_TEMPLATE },
    zetaris,
    synthetic,
    now,
  });
  return {
    async read(input) {
      if (
        input.templateId !== INVENTORY_COUNT_EXAMPLE_TEMPLATE.id ||
        !key(input.parameters?.sku) ||
        !key(input.parameters?.locationId)
      )
        throw new Error("Invalid inventory count query.");
      const result = await reader.read(input);
      if (result.evidence.length !== 1)
        throw new Error("The inventory investigation requires exactly one cycle-count record.");
      findingFromItem(result.evidence[0], input.parameters);
      return result;
    },
  };
}

/** Use the existing OfficeOperations scheduler; no new task route or record type is needed. */
export function createInventoryCountInvestigation(
  operations,
  { incidentId, sku, locationId, createdAt = undefined },
) {
  const stableCreatedAt =
    createdAt ??
    operations.records?.get("incident", incidentId)?.value.createdAt ??
    new Date().toISOString();
  if (![incidentId, sku, locationId].every(key) || !Number.isFinite(Date.parse(stableCreatedAt)))
    throw new Error("A valid incident, SKU, location and creation time are required.");
  return operations.create({
    incident: {
      incidentId,
      goal: `Check the recorded versus counted quantity for SKU ${sku} at ${locationId}.`,
      constraints: ["Read only; do not adjust inventory."],
      taskType: "inventory-investigation",
      acceptanceCriteria: [
        {
          criterionId: "count-variance",
          description:
            "Cite a current cycle-count record and calculate counted minus recorded quantity.",
        },
      ],
      createdAt: stableCreatedAt,
    },
    tasks: [
      {
        taskId: "read-count",
        role: "data-steward-researcher",
        message: `Read the approved inventory cycle-count view for SKU ${sku} at ${locationId}. Report the record ID and source time; do not adjust stock.`,
      },
      {
        taskId: "verify-count",
        role: "critic",
        message: `Check the cited record for SKU ${sku} at ${locationId}, calculate counted minus recorded quantity, and issue an explicit evidence-linked verdict. Do not adjust stock.`,
        dependencies: ["read-count"],
        requiredEvidenceFrom: ["read-count"],
      },
    ],
  });
}

/** Read through the persisted task binding and return a candidate finding, not a verdict. */
export async function readInventoryCount(operations, { incidentId, taskId, sku, locationId }) {
  if (![incidentId, taskId, sku, locationId].every(key))
    throw new Error("A valid incident, task, SKU and location are required.");
  const read = await operations.readEvidence({
    incidentId,
    taskId,
    templateId: INVENTORY_COUNT_EXAMPLE_TEMPLATE.id,
    parameters: { sku, locationId },
  });
  if (read.evidence.length !== 1)
    throw new Error("The inventory investigation requires exactly one cycle-count record.");
  return {
    ...findingFromItem(read.evidence[0], { sku, locationId }),
    auditRef: read.auditRef,
  };
}
