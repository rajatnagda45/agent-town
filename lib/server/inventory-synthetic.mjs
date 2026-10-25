import { INVENTORY_TEMPLATES } from "./inventory-templates.mjs";

/** Synthetic demonstration rows only. Empty arrays are intentionally empty source results. */
export function createSyntheticInventoryFixtures(
  scenario,
  {
    sku = "SKU-42",
    locationId = "WH-A",
    now = new Date(),
    openingQuantity = 8,
    countedQuantity = 7,
  } = {},
) {
  if (
    ![
      "complete",
      "incomplete",
      "conflicting",
      "missing",
      "stale",
      "post_count",
      "post_count_receipt",
      "pre_opening",
      "missing_event_time",
      "missing_count_time",
      "missing_ledger_time",
      "missing_receipt_time",
      "boundary_count",
      "boundary_opening",
    ].includes(scenario)
  )
    throw new Error("Unknown synthetic inventory scenario.");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid synthetic inventory time.");
  if (
    ![sku, locationId].every((value) => /^[A-Za-z0-9._-]{1,64}$/.test(value)) ||
    !Number.isSafeInteger(openingQuantity) ||
    !Number.isSafeInteger(countedQuantity) ||
    openingQuantity + 4 - 2 - countedQuantity !== 3
  )
    throw new Error("Synthetic inventory quantities must establish the three-unit gap.");
  const observedAt = now.toISOString();
  const at = (minutesAgo) => new Date(now.getTime() - minutesAgo * 60 * 1000).toISOString();
  const base = {
    scenario_id: scenario,
    synthetic_label: "SYNTHETIC DATA",
    sku,
    location_id: locationId,
  };
  const idSuffix = `${sku}-${locationId}`;
  const postedReceiptId = `synthetic-posted-receipt-${idSuffix}`;
  const rows = {
    "inventory-ledger-movements": [
      {
        movement_id: `synthetic-opening-${idSuffix}`,
        observed_at: observedAt,
        effective_at: at(12),
        ...base,
        movement_type: "opening_balance",
        quantity_delta: openingQuantity,
      },
      {
        movement_id: postedReceiptId,
        observed_at: observedAt,
        ...(scenario === "missing_ledger_time" ? {} : { effective_at: at(10) }),
        ...base,
        movement_type: "posted_receipt",
        quantity_delta: 4,
      },
      {
        movement_id: `synthetic-posted-transfer-${idSuffix}`,
        observed_at: observedAt,
        effective_at: at(9),
        ...base,
        movement_type: "posted_transfer",
        quantity_delta: -2,
      },
      ...(scenario === "post_count"
        ? [
            {
              movement_id: `synthetic-post-count-adjustment-${idSuffix}`,
              observed_at: observedAt,
              effective_at: at(2),
              ...base,
              movement_type: "adjustment",
              quantity_delta: 5,
            },
          ]
        : []),
    ],
    "inventory-physical-counts":
      scenario === "missing"
        ? []
        : [
            {
              count_id: `synthetic-count-${idSuffix}`,
              observed_at: scenario === "stale" ? at(60) : observedAt,
              ...(scenario === "missing_count_time"
                ? {}
                : { counted_at: scenario === "stale" ? at(60) : at(5) }),
              ...base,
              counted_quantity: countedQuantity,
            },
          ],
    "inventory-transfers": [
      {
        transfer_id: `synthetic-unposted-transfer-${idSuffix}`,
        observed_at: observedAt,
        ...(scenario === "missing_event_time"
          ? {}
          : {
              occurred_at: at(
                scenario === "pre_opening"
                  ? 14
                  : scenario === "post_count"
                    ? 2
                    : scenario === "boundary_count"
                      ? 5
                      : scenario === "boundary_opening"
                        ? 12
                        : 6,
              ),
            }),
        ...base,
        quantity: 2,
        ledger_posted: false,
      },
    ],
    "inventory-receipts": !["incomplete", "missing", "stale"].includes(scenario)
      ? [
          {
            receipt_id: `synthetic-receipt-shortfall-${idSuffix}`,
            observed_at: observedAt,
            ...(scenario === "missing_receipt_time"
              ? {}
              : { received_at: at(scenario === "post_count_receipt" ? 2 : 8) }),
            ...base,
            ledger_movement_id: postedReceiptId,
            expected_quantity: 4,
            received_quantity: scenario === "conflicting" ? 2 : 3,
          },
        ]
      : [],
  };
  return Object.fromEntries(
    Object.keys(INVENTORY_TEMPLATES).map((id) => [
      id,
      { parameters: { scenarioId: scenario, sku, locationId }, rows: rows[id] },
    ]),
  );
}
