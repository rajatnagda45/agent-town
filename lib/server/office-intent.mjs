const inventoryWords = /\b(inventory|stock|sku|ledger|physical|cycle[ -]?count)\b/i;
const investigationWords =
  /\b(explain|investigat\w*|reconcil\w*|shortage|discrepanc\w*|variance|missing units?)\b/i;
const identifier = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
// Location IDs may be names with spaces ("Test Warehouse A"); they are bound as parameters.
const locationIdentifier = (value) =>
  /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?$/.test(value);
// A labelled value ends at a line break, sentence punctuation or the next labelled field.
const NEXT_FIELD = String.raw`(?=\s*(?:$|\n|[.;,](?:\s|$)|\s+(?:ledger|physical|max(?:imum)?|unexplained|unaccounted|read[ -]?only|scenario|sku|location|bin|do not)\b))`;

/** Inventory fields exactly as written. A SKU is a whole token (never the "SKU-001" inside
 * "TEST-SKU-001"), a labelled location keeps its spaces, and nothing is defaulted here. */
export function parseInventoryRequest(message) {
  const field = (pattern) => pattern.exec(message)?.[1]?.trim();
  const sku =
    field(/\bSKU\s*(?:id)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i) ??
    field(/(?:^|[^A-Za-z0-9._-])(SKU[-_][A-Za-z0-9._-]+)/i) ??
    // "SKU XY-890": an unlabelled value must look like an identifier (contain a digit).
    field(/\bSKU\s+((?=[A-Za-z0-9._-]*\d)[A-Za-z0-9][A-Za-z0-9._-]*)/i);
  const locationId = (
    field(
      new RegExp(
        String.raw`\b(?:location(?:\s*id)?|bin|warehouse)\s*[:#=]\s*(.+?)${NEXT_FIELD}`,
        "i",
      ),
    ) ??
    field(/\b(?:at|in|location|bin)\s*[-]?\s*(BIN[-_][A-Za-z0-9._-]+|WH[-_][A-Za-z0-9._-]+)\b/i) ??
    field(/\b(?:location|warehouse)\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b/i)
  )?.replace(/[.,;:]+$/, "");
  const ledger =
    field(/\bledger\s*(?:quantity|qty|units?|count|balance)?\s*[:=]?\s*(\d+)\b/i) ??
    field(/\bledger\b[^\n.\d]{0,40}?\b(\d+)\s*(?:units?|pcs|pieces)\b/i);
  const physical =
    field(/\bphysical\s*(?:quantity|qty|units?|count)?\s*[:=]?\s*(\d+)\b/i) ??
    field(/\bphysical\b[^\n.\d]{0,40}?\b(\d+)\s*(?:units?|pcs|pieces)?\b/i);
  const max =
    field(
      /\b(?:max(?:imum)?|at most)\s*(?:unexplained|unaccounted)(?:\s*(?:quantity|qty|units?))?\s*[:=]?\s*(\d+)\b/i,
    ) ??
    field(
      /\b(?:unexplained|unaccounted)\s*(?:quantity|qty|units?)?\s*(?:max(?:imum)?|limit)?\s*[:=]?\s*(\d+)\b/i,
    );
  const readOnly =
    /\b(?:read[ -]?only|do not (?:modify|adjust|change|write)|no (?:inventory )?(?:adjustment|write))\b/i.test(
      message,
    );
  const scenarioId = field(
    /\b(?:evidence\s+)?scenario\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)\b/i,
  )?.replace(/[.,;:]+$/, "");
  return { sku, locationId, ledger, physical, max, readOnly, scenarioId };
}

/** Deterministic routing: never infer quantities or permission from a model. */
export function classifyOfficeIntent(message, { defaultScenarioId = "default" } = {}) {
  if (!inventoryWords.test(message) || !investigationWords.test(message))
    return { kind: "ordinary" };
  const parsed = parseInventoryRequest(message);
  const { sku, locationId, ledger, physical, max, readOnly } = parsed;
  const scenarioId = parsed.scenarioId ?? defaultScenarioId;
  const missing = [];
  if (!/\b(explain|investigat\w*|reconcil\w*)\b/i.test(message)) missing.push("investigation goal");
  if (!sku || !identifier(sku)) missing.push("SKU");
  if (!locationId || !locationIdentifier(locationId)) missing.push("location");
  const quantity = (value, ceiling = Number.MAX_SAFE_INTEGER) =>
    value === undefined || !Number.isSafeInteger(Number(value)) || Number(value) > ceiling;
  if (quantity(ledger)) missing.push("ledger quantity");
  if (quantity(physical)) missing.push("physical quantity");
  if (quantity(max, 100)) missing.push("maximum unexplained units (0–100)");
  if (!readOnly) missing.push("read-only constraint (say ‘do not modify inventory’)");
  if (!identifier(scenarioId)) missing.push("valid evidence scenario");
  return {
    kind: "inventory_shortage_investigation",
    missing,
    ...(missing.length
      ? {}
      : {
          submission: {
            goal: message.trim(),
            criteria: {
              scenarioId,
              sku,
              locationId,
              ledgerQuantity: Number(ledger),
              physicalQuantity: Number(physical),
              maxUnexplainedUnits: Number(max),
            },
          },
        }),
  };
}
