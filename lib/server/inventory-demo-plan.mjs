import { INVENTORY_READS } from "./inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "./inventory-synthetic.mjs";
import { INVENTORY_TEMPLATES } from "./inventory-templates.mjs";

export const INVENTORY_DEMO_NAMESPACE = "AGENT_TOWN_INVENTORY_DEMO";
export const INVENTORY_DEMO_LABEL = "SYNTHETIC DATA";

const tableNames = Object.freeze({
  ledger: "INVENTORY_LEDGER_MOVEMENTS",
  count: "INVENTORY_PHYSICAL_COUNTS",
  transfers: "INVENTORY_TRANSFERS",
  receipts: "INVENTORY_RECEIPTS",
});

/** Prepare rows in memory from committed fixtures. This neither creates a Zetaris object
 * nor decides whether the instance represents the namespace as a database or schema. */
export function prepareInventoryDemoPlan({ now = new Date() } = {}) {
  const parameters = {
    sku: "SKU-17",
    locationId: "BIN-A",
    now,
    openingQuantity: 10,
    countedQuantity: 9,
  };
  const incomplete = createSyntheticInventoryFixtures("incomplete", parameters);
  const complete = createSyntheticInventoryFixtures("complete", parameters);
  /** @type {Record<string, {proposedTable:string, templateId:string, key:string[], columns:string[], rows:Array<Record<string, any>>}>} */
  const sources = {};
  for (const [kind, templateId] of INVENTORY_READS) {
    const template = INVENTORY_TEMPLATES[templateId];
    const sourceRows = [...incomplete[templateId].rows, ...complete[templateId].rows].map(
      (row) => ({ ...row, synthetic_label: INVENTORY_DEMO_LABEL }),
    );
    const columns = [
      ...new Set([
        "synthetic_label",
        template.recordIdField,
        template.timestampField,
        ...template.fields,
      ]),
    ];
    for (const row of sourceRows)
      if (columns.some((column) => !Object.hasOwn(row, column)))
        throw new Error(`Synthetic ${kind} row lacks a canonical field.`);
    const keys = sourceRows.map((row) => `${row.scenario_id}:${row[template.recordIdField]}`);
    if (new Set(keys).size !== keys.length)
      throw new Error(`Synthetic ${kind} source has duplicate scenario/record IDs.`);
    sources[kind] = {
      proposedTable: tableNames[kind],
      templateId,
      key: ["scenario_id", template.recordIdField],
      columns,
      rows: sourceRows,
    };
  }
  return {
    label: INVENTORY_DEMO_LABEL,
    proposedNamespace: INVENTORY_DEMO_NAMESPACE,
    namespaceKind: "pending_installed_api_spec",
    sku: parameters.sku,
    locationId: parameters.locationId,
    scenarios: ["incomplete", "complete"],
    sources,
  };
}
