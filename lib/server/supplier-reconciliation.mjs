// Deterministic reconciliation of one purchase order against goods receipts, shipments and
// supplier confirmations. Figures come only from the rows read; nothing is assumed or defaulted.
// The gap (ordered − received) is partitioned into supported explanations:
//   receipt_not_recorded = delivered − received   (arrived, never received in the system)
//   in_transit           = shipped but not yet delivered
//   short_shipment       = ordered − shipped, when the supplier confirms the shortfall
//   unexplained          = whatever no record supports

const integer = (value) => {
  const number = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};
const rowsOf = (read) =>
  (read?.evidence ?? []).map((item) => ({ item, content: JSON.parse(item.content) }));
const ids = (rows) => rows.map(({ item }) => item.evidenceId);

/** @param {Record<string, {evidence: Array<any>}>} reads
 * @param {{poId: string, now?: number}} scope */
export function reconcileSupplierDelivery(reads, { poId, now = Date.now() }) {
  const orders = rowsOf(reads.purchaseOrders);
  const receipts = rowsOf(reads.receipts);
  const shipments = rowsOf(reads.shipments);
  const confirmations = rowsOf(reads.confirmations);
  const base = { poId, label: "SYNTHETIC DATA" };
  if (!orders.length && !receipts.length && !shipments.length && !confirmations.length)
    return {
      ...base,
      status: "not_found",
      reason: `Blocked: ${poId} has no purchase order, receipt, shipment or supplier records in the approved source. No other order was substituted.`,
    };
  if (orders.length !== 1)
    return {
      ...base,
      status: "unresolved",
      reason: orders.length
        ? `${poId} has ${orders.length} purchase order rows; one is required.`
        : `${poId} has related records but no purchase order row.`,
    };
  const order = orders[0].content;
  const ordered = integer(order.ordered_quantity);
  const sum = (rows, field) =>
    rows.reduce((total, { content }) => {
      const value = integer(content[field]);
      return total === null || value === null ? null : total + value;
    }, 0);
  const received = sum(receipts, "received_quantity");
  const delivered = sum(
    shipments.filter(({ content }) => content.status === "delivered"),
    "shipped_quantity",
  );
  const transit = shipments.filter(({ content }) => content.status === "in_transit");
  const inTransit = sum(transit, "shipped_quantity");
  const confirmed = confirmations.length ? sum(confirmations, "confirmed_quantity") : null;
  if (
    [ordered, received, delivered, inTransit].includes(null) ||
    (confirmed === null && confirmations.length)
  )
    return { ...base, status: "unresolved", reason: "A source returned an invalid quantity." };
  if (shipments.some(({ content }) => !["delivered", "in_transit"].includes(content.status)))
    return { ...base, status: "unresolved", reason: "A shipment has an unrecognised status." };
  // Records whose observation is older than their review window must be re-checked.
  const stale = [...receipts, ...shipments]
    .filter(({ item }) => item.freshUntil && Date.parse(item.freshUntil) < now)
    .map(({ item }) => item.evidenceId);

  const gap = ordered - received;
  const quantities = {
    ordered,
    received,
    delivered,
    inTransit,
    confirmed,
    gap,
    shipped: delivered + inTransit,
  };
  const conclusions = [];
  if (received > delivered)
    return {
      ...base,
      ...quantities,
      status: "conflicting",
      stale,
      conclusions: [
        {
          code: "receipt_exceeds_delivery",
          quantity: received - delivered,
          evidenceIds: [...ids(receipts), ...ids(shipments)],
        },
      ],
      reason: "More units were received than shipments show as delivered.",
    };
  const notRecorded = delivered - received;
  if (notRecorded > 0)
    conclusions.push({
      code: "receipt_not_recorded",
      quantity: notRecorded,
      evidenceIds: [
        ...ids(receipts),
        ...ids(shipments.filter(({ content }) => content.status === "delivered")),
      ],
      detail: `${delivered} delivered, ${received} recorded as received.`,
    });
  if (inTransit > 0)
    conclusions.push({
      code: "in_transit",
      quantity: inTransit,
      evidenceIds: ids(transit),
      detail: transit
        .map(({ content }) => `${content.shipment_id ?? "shipment"} ETA ${content.eta}`)
        .join("; "),
      shipments: transit.map(({ item, content }) => ({
        shipmentId: item.recordId,
        quantity: integer(content.shipped_quantity),
        eta: content.eta,
      })),
    });
  const unshipped = ordered - delivered - inTransit;
  if (unshipped > 0 && confirmed !== null && confirmed <= ordered - unshipped)
    conclusions.push({
      code: "short_shipment",
      quantity: unshipped,
      evidenceIds: [...ids(confirmations), ...ids(orders)],
      detail: `Supplier confirmed ${confirmed} of ${ordered}.`,
    });
  else if (unshipped > 0)
    conclusions.push({
      code: "unexplained",
      quantity: unshipped,
      evidenceIds: [...ids(orders), ...ids(shipments), ...ids(confirmations)],
      detail:
        confirmed === null
          ? "No supplier confirmation covers the missing units."
          : `Supplier confirmed ${confirmed}, but shipments account for only ${delivered + inTransit}.`,
    });
  if (unshipped < 0)
    return {
      ...base,
      ...quantities,
      status: "conflicting",
      stale,
      conclusions,
      reason: "Shipments exceed the ordered quantity.",
    };
  const explained = conclusions
    .filter((c) => c.code !== "unexplained")
    .reduce((total, c) => total + c.quantity, 0);
  return {
    ...base,
    ...quantities,
    supplierId: order.supplier_id,
    sku: order.sku,
    status: gap === 0 ? "no_discrepancy" : explained === gap ? "explained" : "incomplete",
    explained,
    unexplained: gap - explained,
    stale,
    conclusions,
    evidenceIds: [...ids(orders), ...ids(receipts), ...ids(shipments), ...ids(confirmations)],
  };
}
