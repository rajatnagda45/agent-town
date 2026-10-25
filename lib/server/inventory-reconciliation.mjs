import { INVENTORY_READS, inventoryId } from "./inventory-investigation.mjs";
import { INVENTORY_TEMPLATES } from "./inventory-templates.mjs";

const quantity = (value) => Number.isSafeInteger(value) && value >= 0;
const sourceId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
const unresolved = (reason) => ({ status: "unresolved", reason, conclusions: [] });
const eventField = Object.freeze({
  ledger: "effective_at",
  count: "counted_at",
  transfers: "occurred_at",
  receipts: "received_at",
});

/** A deterministic calculation for review, never a Critic verdict or inventory write. */
export function reconcileInventoryEvidence(
  reads,
  {
    incidentId,
    taskId,
    scenarioId,
    sku,
    locationId,
    now = new Date(),
    templates = INVENTORY_TEMPLATES,
  },
) {
  if (
    ![incidentId, taskId, scenarioId, sku, locationId].every(inventoryId) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid inventory reconciliation input.");
  const rows = {};
  const seen = new Set();
  const seenSourceRecords = new Set();
  let sourceMode;
  let binding;
  for (const [kind, templateId] of INVENTORY_READS) {
    const template = templates?.[templateId];
    if (template?.id !== templateId || !sourceId(template.source))
      return unresolved(`Missing approved ${kind} source mapping.`);
    const read = reads?.[kind];
    if (!sourceId(read?.auditRef) || !Array.isArray(read.evidence) || !read.scope)
      return unresolved(`Missing audited ${kind} read.`);
    if (read.scope.incidentId !== incidentId || read.scope.taskId !== taskId)
      return unresolved("Inventory read belongs to another incident or task.");
    const identity = JSON.stringify(read.scope);
    if (binding && binding !== identity)
      return unresolved("Inventory reads use different bindings.");
    binding = identity;
    rows[kind] = [];
    for (const item of read.evidence) {
      const mode = item?.source?.split(":", 1)[0];
      if (
        !["synthetic", "zetaris"].includes(mode) ||
        item.source !== `${mode}:${template.source}` ||
        (sourceMode && sourceMode !== mode) ||
        item.incidentId !== incidentId ||
        item.taskId !== taskId ||
        item.auditRef !== read.auditRef ||
        !sourceId(item.recordId) ||
        !sourceId(item.evidenceId) ||
        seen.has(item.evidenceId) ||
        seenSourceRecords.has(`${item.source}:${item.recordId}`)
      )
        return unresolved("Inventory evidence has conflicting provenance or source ownership.");
      seen.add(item.evidenceId);
      seenSourceRecords.add(`${item.source}:${item.recordId}`);
      sourceMode = mode;
      const sourceTime = Date.parse(item.sourceTimestamp ?? "");
      const freshUntil = Date.parse(item.freshUntil ?? "");
      if (
        !Number.isFinite(sourceTime) ||
        sourceTime > now.getTime() ||
        !Number.isFinite(freshUntil) ||
        freshUntil <= now.getTime()
      )
        return unresolved(`Missing or stale ${kind} source evidence.`);
      let content;
      try {
        content = JSON.parse(item.content);
      } catch {
        return unresolved(`Invalid ${kind} source content.`);
      }
      if (
        content?.scenario_id !== scenarioId ||
        content.synthetic_label !== "SYNTHETIC DATA" ||
        content.sku !== sku ||
        content.location_id !== locationId
      )
        return unresolved(`Mismatched ${kind} source record.`);
      const rawEventTime = content[eventField[kind]];
      const eventTime = typeof rawEventTime === "string" ? Date.parse(rawEventTime) : NaN;
      if (!Number.isFinite(eventTime) || eventTime > sourceTime)
        return unresolved(`Missing or ambiguous ${kind} event time.`);
      rows[kind].push({ item, content, sourceTime, eventTime });
    }
  }
  if (!rows.ledger.length || rows.count.length !== 1)
    return unresolved("A ledger movement and exactly one physical count are required.");
  const openings = rows.ledger.filter(({ content }) => content.movement_type === "opening_balance");
  if (
    openings.length !== 1 ||
    rows.ledger.some(
      ({ content }) =>
        !Number.isSafeInteger(content.quantity_delta) ||
        !["opening_balance", "posted_receipt", "posted_transfer", "adjustment"].includes(
          content.movement_type,
        ),
    ) ||
    !quantity(rows.count[0].content.counted_quantity)
  )
    return unresolved("Ledger or count quantities are invalid.");
  const openingTime = openings[0].eventTime;
  const countCutoff = rows.count[0].eventTime;
  const countMaxAgeMs = templates["inventory-physical-counts"].maxAgeMs;
  if (
    openingTime >= countCutoff ||
    !Number.isSafeInteger(countMaxAgeMs) ||
    countMaxAgeMs < 1 ||
    now.getTime() - countCutoff > countMaxAgeMs
  )
    return unresolved(
      "Physical count does not establish a current cutoff after the opening balance.",
    );
  const excludedEvidence = [];
  for (const kind of ["ledger", "transfers", "receipts"]) {
    const applicable = [];
    for (const row of rows[kind]) {
      if (kind === "ledger" && row === openings[0]) {
        applicable.push(row);
        continue;
      }
      if (row.eventTime === openingTime || row.eventTime === countCutoff)
        return unresolved(`Ambiguous ${kind} event at a cutoff boundary.`);
      if (row.eventTime < openingTime) {
        excludedEvidence.push({ evidenceId: row.item.evidenceId, reason: "before_opening" });
      } else if (row.eventTime > countCutoff) {
        excludedEvidence.push({ evidenceId: row.item.evidenceId, reason: "after_count" });
      } else {
        applicable.push(row);
      }
    }
    rows[kind] = applicable;
  }
  const ledgerQuantity = rows.ledger.reduce((sum, { content }) => sum + content.quantity_delta, 0);
  const countQuantity = rows.count[0].content.counted_quantity;
  const missingQuantity = ledgerQuantity - countQuantity;
  if (!quantity(ledgerQuantity) || !Number.isSafeInteger(missingQuantity))
    return unresolved("Ledger and count do not establish a supported inventory quantity.");
  if (missingQuantity < 0)
    return unresolved("Inventory surplus is unsupported by this shortage investigation.");
  const conclusions = [
    {
      code: "ledger_vs_count",
      quantity: missingQuantity,
      evidenceIds: [
        ...rows.ledger.map(({ item }) => item.evidenceId),
        rows.count[0].item.evidenceId,
      ],
    },
  ];
  let explainedQuantity = 0;
  const linkedReceipts = new Set();
  for (const { item, content } of rows.transfers) {
    if (!quantity(content.quantity) || !content.quantity || content.ledger_posted !== false)
      return unresolved("Transfer support is invalid or already posted to the ledger.");
    explainedQuantity += content.quantity;
    conclusions.push({
      code: "unposted_transfer_out",
      quantity: content.quantity,
      evidenceIds: [item.evidenceId],
    });
  }
  for (const { item, content } of rows.receipts) {
    const linkedLedger = rows.ledger.filter(
      (row) => row.item.recordId === content.ledger_movement_id,
    );
    if (
      !quantity(content.expected_quantity) ||
      !quantity(content.received_quantity) ||
      content.expected_quantity <= content.received_quantity ||
      linkedLedger.length !== 1 ||
      linkedLedger[0].content.movement_type !== "posted_receipt" ||
      linkedLedger[0].content.quantity_delta !== content.expected_quantity ||
      linkedReceipts.has(content.ledger_movement_id)
    )
      return unresolved("Receipt support does not match a posted ledger receipt.");
    linkedReceipts.add(content.ledger_movement_id);
    const shortfall = content.expected_quantity - content.received_quantity;
    explainedQuantity += shortfall;
    conclusions.push({
      code: "receipt_shortfall",
      quantity: shortfall,
      evidenceIds: [item.evidenceId, linkedLedger[0].item.evidenceId],
    });
  }
  if (!Number.isSafeInteger(explainedQuantity))
    return unresolved("Supporting quantities exceed the safe range.");
  const difference = missingQuantity - explainedQuantity;
  const status = difference === 0 ? "explained" : difference > 0 ? "incomplete" : "conflicting";
  const applicableEvidenceIds = ["ledger", "count", "transfers", "receipts"].flatMap((kind) =>
    rows[kind].map(({ item }) => item.evidenceId),
  );
  conclusions.push({
    code:
      status === "explained"
        ? "matched_support"
        : status === "incomplete"
          ? "unexplained_units"
          : "excess_support",
    quantity: Math.abs(difference),
    evidenceIds: applicableEvidenceIds,
  });
  return {
    status,
    label: "SYNTHETIC DATA",
    scenarioId,
    sku,
    locationId,
    ledgerQuantity,
    countQuantity,
    missingQuantity,
    explainedQuantity,
    difference,
    sourceMode,
    openingAt: openings[0].content.effective_at,
    countCutoffAt: rows.count[0].content.counted_at,
    excludedEvidence,
    conclusions,
  };
}
