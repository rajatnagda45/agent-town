// Explicit decision policy for supplier delivery discrepancies. Deterministic: the recommended
// action comes from current evidence, recalled memory and these rules, never from model text.
// It only recommends; payment approval and record changes always need an authorized human.

const codesOf = (checks) =>
  Object.fromEntries((checks?.conclusions ?? []).map((c) => [c.code, c.quantity]));

/** Whether a recalled verified finding still matches current evidence. */
function memoryStatus(recalled, checks) {
  if (!recalled) return { status: "none", reason: "No prior verified finding for this order." };
  if (!["explained", "incomplete", "no_discrepancy"].includes(checks?.status))
    return {
      status: "not_applicable",
      reason: "Current evidence cannot be reconciled, so the prior finding is not used.",
    };
  const before = recalled.conclusions ?? {};
  const now = codesOf(checks);
  const same =
    recalled.gap === checks.gap &&
    Object.keys({ ...before, ...now }).every((code) => before[code] === now[code]);
  return same
    ? {
        status: "confirmed",
        reason: `Fresh records reproduce the prior finding (${describe(before)}).`,
      }
    : {
        status: "conflicts",
        reason: `Prior finding (${describe(before)}) no longer matches current records (${describe(now)}); it is not reused.`,
      };
}
const describe = (codes) =>
  Object.entries(codes)
    .map(([code, quantity]) => `${code.replaceAll("_", " ")} ${quantity}`)
    .join(", ") || "no discrepancy";

/** @param {{poId: string, checks: any, recalled?: any}} input */
export function applySupplierPolicy({ poId, checks, recalled = null }) {
  const codes = codesOf(checks);
  const evidence = (code) =>
    (checks?.conclusions ?? []).find((c) => c.code === code)?.evidenceIds ?? [];
  const memory = memoryStatus(recalled, checks);
  const notFound = checks?.status === "not_found";
  const reconciled = ["explained", "no_discrepancy"].includes(checks?.status);
  const rules = [
    {
      id: "insufficient_data",
      title: "Insufficient data",
      condition: "The requested order has no records in the approved source",
      fired: notFound,
      reason: notFound ? checks.reason : "Records for the order exist.",
      evidenceIds: [],
    },
    {
      id: "evidence_required",
      title: "Evidence required",
      condition: "Current records reconcile the whole gap",
      fired: reconciled,
      reason: reconciled
        ? `All ${checks.gap} missing units are accounted for by current records.`
        : checks?.status === "incomplete"
          ? `${checks.unexplained} of ${checks.gap} units are not supported by any record.`
          : (checks?.reason ?? "No reconciled explanation."),
      evidenceIds: checks?.evidenceIds ?? [],
    },
    {
      id: "memory_freshness",
      title: "Memory freshness",
      condition: "A recalled finding must match current records before it is used",
      fired: memory.status === "conflicts",
      reason: memory.reason,
      evidenceIds: recalled?.evidenceIds ?? [],
    },
    {
      id: "stale_evidence",
      title: "Stale evidence",
      condition: "Receipt or shipment status older than its review window",
      fired: (checks?.stale ?? []).length > 0,
      reason: (checks?.stale ?? []).length
        ? `${checks.stale.length} status records are stale and must be re-checked.`
        : "All status records are within their review window.",
      evidenceIds: checks?.stale ?? [],
    },
    {
      id: "in_transit",
      title: "Shipment in transit",
      condition: "Units are shipped but not yet delivered",
      fired: !!codes.in_transit,
      reason: codes.in_transit
        ? `${codes.in_transit} units in transit: ${(checks.conclusions.find((c) => c.code === "in_transit") ?? {}).detail}.`
        : "No units are in transit.",
      evidenceIds: evidence("in_transit"),
    },
    {
      id: "receipt_correction",
      title: "Receipt correction",
      condition: "Shipments show more units delivered than were received",
      fired: !!codes.receipt_not_recorded,
      reason: codes.receipt_not_recorded
        ? `${codes.receipt_not_recorded} delivered units have no goods receipt.`
        : "Every delivered unit has a goods receipt.",
      evidenceIds: evidence("receipt_not_recorded"),
    },
    {
      id: "supplier_clarification",
      title: "Supplier clarification",
      condition: "Units were short-shipped or are unaccounted for",
      fired: !!(codes.short_shipment || codes.unexplained || checks?.status === "conflicting"),
      reason: codes.short_shipment
        ? `Supplier confirmed a shortfall of ${codes.short_shipment} units.`
        : codes.unexplained
          ? `${codes.unexplained} units are not covered by any shipment.`
          : checks?.status === "conflicting"
            ? checks.reason
            : "No supplier discrepancy.",
      evidenceIds: [...evidence("short_shipment"), ...evidence("unexplained")],
    },
    {
      id: "payment_hold",
      title: "Payment approval",
      condition: "Fewer units received than ordered",
      fired: !notFound && (checks?.gap ?? 0) > 0,
      reason:
        !notFound && (checks?.gap ?? 0) > 0
          ? `Only ${checks.received} of ${checks.ordered} units are received; full payment must not be approved without authorization.`
          : "No payment action is in scope.",
      evidenceIds: checks?.evidenceIds ?? [],
    },
  ];
  const fired = (id) => rules.find((rule) => rule.id === id).fired;
  const actions = [];
  const approvals = [];
  if (notFound) {
    return {
      poId,
      status: "blocked",
      decision: `No recommendation: ${poId} has no records. Check the order number before investigating further.`,
      actions,
      approvals,
      confidence: null,
      rules,
      memory,
    };
  }
  if (fired("stale_evidence"))
    actions.push("Re-check the stale receipt and shipment records before acting.");
  if (fired("in_transit")) {
    const lot = checks.conclusions.find((c) => c.code === "in_transit");
    actions.push(
      `Confirm the remaining shipment with the carrier: ${lot.shipments.map((s) => `${s.shipmentId} (${s.quantity} units, ETA ${s.eta})`).join(", ")}.`,
    );
  }
  if (fired("receipt_correction")) {
    actions.push(
      `Verify the ${codes.receipt_not_recorded} delivered units at the dock, then record the missing goods receipt.`,
    );
    approvals.push(
      `Recording a goods receipt for ${codes.receipt_not_recorded} units changes records: authorized human approval required.`,
    );
  }
  if (fired("supplier_clarification"))
    actions.push(`Request written clarification from the supplier for ${poId}.`);
  if (fired("payment_hold"))
    approvals.push(
      `Approving payment for ${poId} beyond the ${checks.received} received units requires authorized human approval.`,
    );
  if (!actions.length)
    actions.push(
      checks?.status === "no_discrepancy"
        ? "No action: the order is fully received."
        : "Investigate further; current records do not support a recommendation.",
    );
  // A simple, stated heuristic: share of the gap supported by records, reduced when stale.
  const coverage = checks?.gap ? (checks.explained ?? 0) / checks.gap : reconciled ? 1 : 0;
  const confidence = Math.round(100 * coverage * (fired("stale_evidence") ? 0.5 : 1)) / 100;
  return {
    poId,
    status: reconciled && !fired("stale_evidence") ? "recommended" : "needs_investigation",
    decision: actions[0],
    actions,
    approvals,
    confidence,
    rules,
    memory,
  };
}
