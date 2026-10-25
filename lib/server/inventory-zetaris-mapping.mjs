import { INVENTORY_TEMPLATES } from "./inventory-templates.mjs";

// Isolated, labelled demo sources registered in the installed Zetaris instance.
// These are live Zetaris reads of SYNTHETIC DATA, not warehouse production records.
const tables = {
  "inventory-ledger-movements": "INVENTORY_LEDGER_MOVEMENTS",
  "inventory-physical-counts": "INVENTORY_PHYSICAL_COUNTS",
  "inventory-transfers": "INVENTORY_TRANSFERS",
  "inventory-receipts": "INVENTORY_RECEIPTS",
};
export const APPROVED_INVENTORY_ZETARIS_TEMPLATES = Object.freeze(
  Object.fromEntries(
    Object.entries(tables).map(([id, table]) => {
      const template = INVENTORY_TEMPLATES[id];
      const source = `zetaris_demo_${table.toLowerCase()}`;
      const qualifiedTable = `AGENT_TOWN_INVENTORY_DEMO.${table}`;
      return [
        id,
        { ...template, source, sql: template.sql.replace(template.source, qualifiedTable) },
      ];
    }),
  ),
);

const integerFields = [
  "quantity_delta",
  "counted_quantity",
  "quantity",
  "expected_quantity",
  "received_quantity",
];
/** The installed SQL API serializes scalar numeric/boolean values as strings.
 * Decode only the canonical inventory fields, strictly; IDs and timestamps stay untouched. */
export function decodeZetarisInventoryRow(row) {
  const decoded = { ...row };
  for (const field of integerFields) {
    if (!Object.hasOwn(decoded, field)) continue;
    const value = decoded[field];
    if (typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value)) decoded[field] = Number(value);
    if (!Number.isSafeInteger(decoded[field]))
      throw new Error(`Invalid Zetaris inventory integer: ${field}.`);
  }
  if (Object.hasOwn(decoded, "ledger_posted")) {
    if (decoded.ledger_posted === "true") decoded.ledger_posted = true;
    if (decoded.ledger_posted === "false") decoded.ledger_posted = false;
    if (typeof decoded.ledger_posted !== "boolean")
      throw new Error("Invalid Zetaris inventory boolean: ledger_posted.");
  }
  return decoded;
}
