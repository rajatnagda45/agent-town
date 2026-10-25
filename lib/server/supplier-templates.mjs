/** Reviewed, read-only projections of the SYNTHETIC supplier-delivery demo tables registered in
 * Zetaris as AGENT_TOWN_SUPPLIER_DEMO. Each read is filtered only by the requested PO ID. */
const DATABASE = "AGENT_TOWN_SUPPLIER_DEMO";
const DAY = 24 * 60 * 60 * 1000;

/** @returns {import("./data-source.d.mts").ReadTemplate} */
const template = (id, table, recordIdField, fields) => ({
  id,
  source: `zetaris_supplier_${table.toLowerCase()}`,
  sql: `SELECT ${[recordIdField, "observed_at", ...fields].join(", ")} FROM ${DATABASE}.${table} WHERE po_id = :poId`,
  parameters: { poId: "text" },
  recordIdField,
  timestampField: "observed_at",
  fields,
  // Status records older than a day must be re-checked before they support a decision.
  maxAgeMs: DAY,
});

export const SUPPLIER_TEMPLATES = Object.freeze({
  "purchase-orders": template("purchase-orders", "PURCHASE_ORDERS", "po_id", [
    "synthetic_label",
    "supplier_id",
    "sku",
    "ordered_quantity",
    "ordered_at",
  ]),
  "goods-receipts": template("goods-receipts", "GOODS_RECEIPTS", "receipt_id", [
    "synthetic_label",
    "po_id",
    "received_quantity",
    "received_at",
    "recorded_by",
  ]),
  shipments: template("shipments", "SHIPMENTS", "shipment_id", [
    "synthetic_label",
    "po_id",
    "shipped_quantity",
    "status",
    "shipped_at",
    "eta",
  ]),
  "supplier-confirmations": template(
    "supplier-confirmations",
    "SUPPLIER_CONFIRMATIONS",
    "confirmation_id",
    ["synthetic_label", "po_id", "confirmed_quantity", "note", "confirmed_at"],
  ),
});

/** [read kind, template ID] in the order the investigation reads them. */
export const SUPPLIER_READS = [
  ["purchaseOrders", "purchase-orders"],
  ["receipts", "goods-receipts"],
  ["shipments", "shipments"],
  ["confirmations", "supplier-confirmations"],
];
