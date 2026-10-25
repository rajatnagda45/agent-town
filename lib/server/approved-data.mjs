// This is discovery of reviewed mappings, not unrestricted live database metadata.
// Identifiers and operations are server-owned; callers can supply only bounded values.
const datasets = {
  NY_TAXI: {
    tables: { trips: ["pickup_zone_id", "pickup_datetime"], zones: ["zone_id", "zone_name"] },
    operations: ["pickup-zone-count", "record-preview"],
    timeFields: ["trips.pickup_datetime"],
  },
  TPCDS_DB: {
    tables: {
      store_sales: ["ss_item_sk", "ss_quantity"],
      store_returns: ["sr_item_sk", "sr_return_quantity"],
      item: ["i_item_sk", "i_category_id", "i_category"],
    },
    operations: ["category-return-rate", "record-preview"],
    timeFields: [],
  },
};
const PREVIEW_MAX = 20;
const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
};

/** Requested row count for a record preview ("summarize five records"), or null. */
const PREVIEW_PATTERN = new RegExp(
  String.raw`\b(?:show|list|preview|sample|summari[sz]e|return|fetch|get|query|read|display)\b.{0,80}?\b(\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})\s+(?:\w+\s+){0,2}?(?:records?|rows?)\b`,
  "i",
);
export function previewCount(goal) {
  const match = PREVIEW_PATTERN.exec(goal);
  if (!match) return null;
  const word = match[1].toLowerCase();
  const count = /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
  return Number.isInteger(count) ? count : null;
}
export function discoverApprovedData(dataset) {
  if (dataset !== undefined && !Object.hasOwn(datasets, dataset))
    throw Object.assign(new Error("Unknown or unapproved dataset. Choose NY_TAXI or TPCDS_DB."), {
      status: 400,
    });
  return structuredClone({
    version: 1,
    provenance: "Reviewed mappings; discovery does not assert live availability or freshness.",
    datasets: dataset ? { [dataset]: datasets[dataset] } : datasets,
    limits: {
      rows: 100,
      timeoutPolicy: "bounded exact-SQL observations; separate open, page and cleanup deadlines",
      pages: 3,
      responseBytes: 2000000,
    },
    permissions: ["read-only"],
  });
}
export function validateApprovedQuery(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new Error("A structured approved query is required.");
  const allowed = [
    "dataset",
    "operation",
    "fields",
    "limit",
    "timeField",
    "startHour",
    "endHour",
    "table",
  ];
  if (Object.keys(plan).some((key) => !allowed.includes(key)))
    throw new Error("Unknown query option; SQL and arbitrary identifiers are not accepted.");
  const schema = discoverApprovedData(plan.dataset).datasets[plan.dataset];
  if (!schema || !schema.operations.includes(plan.operation))
    throw new Error("Unapproved data operation.");
  if (plan.operation === "record-preview") {
    // Allowlisted read: one approved table, exactly its approved columns, a small limit.
    if (typeof plan.table !== "string" || !Object.hasOwn(schema.tables, plan.table))
      throw new Error(
        `Unapproved table. Approved ${plan.dataset} tables: ${Object.keys(schema.tables).join(", ")}.`,
      );
    const columns = schema.tables[plan.table];
    if (
      !Array.isArray(plan.fields) ||
      plan.fields.length !== columns.length ||
      plan.fields.some((field, index) => field !== columns[index])
    )
      throw new Error("Preview fields must be exactly the table's approved columns.");
    if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > PREVIEW_MAX)
      throw new Error(`Preview row limit must be between 1 and ${PREVIEW_MAX}.`);
    if (["timeField", "startHour", "endHour"].some((key) => Object.hasOwn(plan, key)))
      throw new Error("A record preview has no time scope.");
    return structuredClone(plan);
  }
  if (Object.hasOwn(plan, "table")) throw new Error("Only a record preview names a table.");
  const fields =
    plan.dataset === "NY_TAXI"
      ? ["zone", "trip_count"]
      : ["category", "sold", "returned", "return_rate"];
  if (
    !Array.isArray(plan.fields) ||
    plan.fields.length !== fields.length ||
    new Set(plan.fields).size !== fields.length ||
    plan.fields.some((field) => !fields.includes(field))
  )
    throw new Error("Query fields must match the approved operation output.");
  if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 100)
    throw new Error("Query row limit must be between 1 and 100.");
  if (plan.dataset === "NY_TAXI") {
    if (plan.timeField !== "trips.pickup_datetime")
      throw new Error("Clarify the time field: only trips.pickup_datetime is approved.");
    if (
      ![plan.startHour, plan.endHour].every(
        (hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23,
      ) ||
      plan.startHour === plan.endHour
    )
      throw new Error(
        "Specify distinct whole-hour bounds from 00:00 through 23:00, in source time.",
      );
  } else if (["timeField", "startHour", "endHour"].some((key) => Object.hasOwn(plan, key)))
    throw new Error("No approved retail time field exists; clarify the requested time scope.");
  return structuredClone(plan);
}
export function queryForGoal(goal, domain) {
  const dataset = domain === "taxi_analytics" ? "NY_TAXI" : "TPCDS_DB";
  for (const [, name, table] of goal.matchAll(/\b([A-Za-z][\w]*)\.([A-Za-z][\w]*)\b/g))
    if (!datasets[name]?.tables[table])
      throw new Error(`Unapproved table ${name}.${table}. Request an approved mapping.`);
  const count = previewCount(goal);
  if (count !== null) {
    const tables = Object.keys(datasets[dataset].tables).filter((table) =>
      new RegExp(`\\b${table}\\b`, "i").test(goal),
    );
    if (tables.length !== 1)
      throw new Error(
        `Name one approved ${dataset} table to preview: ${Object.keys(datasets[dataset].tables).join(", ")}.`,
      );
    return validateApprovedQuery({
      dataset,
      operation: "record-preview",
      table: tables[0],
      fields: [...datasets[dataset].tables[tables[0]]],
      limit: count,
    });
  }
  if (
    /\b(?:last|since|yesterday|today|week|month|year|dropoff|fare|revenue|average|median|borough)\b/i.test(
      goal,
    )
  )
    throw new Error(
      "The requested field, calculation or date scope has no approved mapping. Clarify using the discovered schema.",
    );
  const limit = Number(goal.match(/\btop\s+(\d+)\b/i)?.[1] ?? 20);
  if (dataset === "NY_TAXI") {
    const hours = [...goal.matchAll(/\b(\d{1,2}):00\b/g)].map((match) => Number(match[1]));
    if (
      !/\bzone\w*\b/i.test(goal) ||
      (hours.length !== 2 && !/\b(?:night|nighttime|overnight)\b/i.test(goal)) ||
      /\b\d{1,2}:(?!00\b)\d{2}\b/.test(goal) ||
      (hours.length && hours.length !== 2)
    )
      throw new Error(
        "Clarify pickup zones and two whole-hour bounds in source time (nighttime means 22:00 to 06:00).",
      );
    return validateApprovedQuery({
      dataset,
      operation: "pickup-zone-count",
      fields: ["zone", "trip_count"],
      limit,
      timeField: "trips.pickup_datetime",
      startHour: hours[0] ?? 22,
      endHour: hours[1] ?? 6,
    });
  }
  if (
    !/\breturn\w*\b/i.test(goal) ||
    !/\b(?:categor\w*|rate\w*)\b/i.test(goal) ||
    /\bbetween\b/i.test(goal)
  )
    throw new Error(
      "Clarify store-channel category return rates across the available sample; no retail time mapping is approved.",
    );
  return validateApprovedQuery({
    dataset,
    operation: "category-return-rate",
    fields: ["category", "sold", "returned", "return_rate"],
    limit,
  });
}
export function approvedTemplates(plan, templates) {
  const query = validateApprovedQuery(plan);
  if (query.operation === "record-preview") {
    // SQL is assembled only from validated, server-owned identifiers; ordering by every
    // approved column keeps repeated previews stable.
    const columns = query.fields;
    return {
      ...templates,
      "record-preview": {
        id: "record-preview",
        source: `${query.dataset.toLowerCase()}_${query.table}_preview`,
        recordIdField: columns[0],
        fields: columns,
        parameters: {},
        sql: `SELECT ${columns.join(", ")} FROM ${query.dataset}.${query.table} ORDER BY ${columns.join(", ")} LIMIT ${query.limit}`,
      },
    };
  }
  if (query.dataset === "TPCDS_DB") return templates;
  const hour = "HOUR(CAST(t.pickup_datetime AS TIMESTAMP))";
  const join = query.startHour > query.endHour ? "OR" : "AND";
  return {
    ...templates,
    "taxi-night": {
      ...templates["taxi-night"],
      sql: `SELECT t.pickup_zone_id AS zone_id, z.zone_name AS zone, COUNT(*) AS trip_count FROM NY_TAXI.trips t JOIN NY_TAXI.zones z ON t.pickup_zone_id = z.zone_id WHERE ${hour} >= ${query.startHour} ${join} ${hour} < ${query.endHour} GROUP BY t.pickup_zone_id, z.zone_name ORDER BY trip_count DESC, zone_id ASC LIMIT ${query.limit}`,
    },
  };
}
