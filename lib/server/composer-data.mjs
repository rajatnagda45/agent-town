import { zetarisDeadlines } from "./zetaris-deadlines.mjs";
import { createHash } from "node:crypto";
import { createDataReader } from "./data-source.mjs";
import { createZetarisDataSource, createZetarisHttpTransport } from "./data-zetaris.mjs";
import { INVENTORY_READS } from "./inventory-investigation.mjs";
import { reconcileInventoryEvidence } from "./inventory-reconciliation.mjs";
import { DataEvidenceService } from "./data-integration.mjs";
import { createWebSearchReader, extractionTargets, researchChecks } from "./web-evidence.mjs";
import { approvedTemplates, validateApprovedQuery } from "./approved-data.mjs";
import { parseInventoryRequest } from "./office-intent.mjs";
import { SUPPLIER_READS, SUPPLIER_TEMPLATES } from "./supplier-templates.mjs";
import { reconcileSupplierDelivery } from "./supplier-reconciliation.mjs";

// Column names verified against installed Zetaris metadata, 26 October 2026.
// SQL is owned by the server. No SQL, table name or projection comes from a model or goal.
export const ANALYTICS_TEMPLATES = {
  "retail-sales": {
    id: "retail-sales",
    source: "tpcds_category_sales",
    recordIdField: "category_id",
    fields: ["category", "sold"],
    parameters: {},
    sql: "SELECT i.i_category_id AS category_id, i.i_category AS category, SUM(s.ss_quantity) AS sold FROM TPCDS_DB.store_sales s JOIN TPCDS_DB.item i ON s.ss_item_sk = i.i_item_sk WHERE i.i_category_id IS NOT NULL GROUP BY i.i_category_id, i.i_category",
  },
  "retail-returns": {
    id: "retail-returns",
    source: "tpcds_category_returns",
    recordIdField: "category_id",
    fields: ["category", "returned"],
    parameters: {},
    sql: "SELECT i.i_category_id AS category_id, i.i_category AS category, SUM(r.sr_return_quantity) AS returned FROM TPCDS_DB.store_returns r JOIN TPCDS_DB.item i ON r.sr_item_sk = i.i_item_sk WHERE i.i_category_id IS NOT NULL GROUP BY i.i_category_id, i.i_category",
  },
  "taxi-night": {
    id: "taxi-night",
    source: "ny_taxi_night_zones",
    recordIdField: "zone_id",
    fields: ["zone", "trip_count"],
    parameters: {},
    sql: "SELECT t.pickup_zone_id AS zone_id, z.zone_name AS zone, COUNT(*) AS trip_count FROM NY_TAXI.trips t JOIN NY_TAXI.zones z ON t.pickup_zone_id = z.zone_id WHERE HOUR(CAST(t.pickup_datetime AS TIMESTAMP)) >= 22 OR HOUR(CAST(t.pickup_datetime AS TIMESTAMP)) < 6 GROUP BY t.pickup_zone_id, z.zone_name ORDER BY trip_count DESC, zone_id ASC LIMIT 20",
  },
};
export function analyticsReader(env, query, audits = []) {
  const transport = createZetarisHttpTransport({
    ...zetarisDeadlines(env, audits),
    profile: "installed-sql-v1",
    openUrl: env.ZETARIS_OPEN_URL,
    pageUrl: env.ZETARIS_PAGE_URL,
    closeUrl: env.ZETARIS_CLOSE_URL,
    pageMethod: env.ZETARIS_PAGE_METHOD,
    closeMethod: env.ZETARIS_CLOSE_METHOD,
    bearerToken: env.ZETARIS_BEARER_TOKEN,
    orgId: env.ZETARIS_ORG_ID,
    allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
  });
  return createDataReader({
    mode: "zetaris",
    templates: query ? approvedTemplates(query, ANALYTICS_TEMPLATES) : ANALYTICS_TEMPLATES,
    zetaris: createZetarisDataSource({ transport }),
  });
}
/** Live Zetaris reader for the reviewed supplier-delivery templates only. */
export function supplierReader(env, audits = []) {
  const transport = createZetarisHttpTransport({
    ...zetarisDeadlines(env, audits),
    profile: "installed-sql-v1",
    openUrl: env.ZETARIS_OPEN_URL,
    pageUrl: env.ZETARIS_PAGE_URL,
    closeUrl: env.ZETARIS_CLOSE_URL,
    pageMethod: env.ZETARIS_PAGE_METHOD,
    closeMethod: env.ZETARIS_CLOSE_METHOD,
    bearerToken: env.ZETARIS_BEARER_TOKEN,
    orgId: env.ZETARIS_ORG_ID,
    allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
  });
  return createDataReader({
    mode: "zetaris",
    templates: SUPPLIER_TEMPLATES,
    zetaris: createZetarisDataSource({ transport }),
  });
}
export async function discoverInventoryScope(runtime, record, taskId, env) {
  const scope = inventoryScope(record.input.goal);
  if (scope.scenarioId) return { scope };
  if (env.AGENT_TOWN_INVENTORY_MODE === "synthetic") {
    const scenarioId = env.AGENT_TOWN_INVENTORY_SYNTHETIC_CASE;
    if (scenarioId && scenarioId !== "demo-pair") return { scope: { ...scope, scenarioId } };
    return {
      clarification:
        "Two labelled snapshots match: incomplete and complete. Which snapshot should the team investigate? Add its name to your goal.",
    };
  }
  const base = runtime.operations.data?.reader.inventoryTemplates?.["inventory-physical-counts"];
  if (!base || !base.sql.includes("scenario_id = :scenarioId AND "))
    throw new Error("Inventory snapshot discovery has no reviewed mapping.");
  const template = {
    ...base,
    id: "inventory-snapshot-discovery",
    parameters: { sku: "text", locationId: "text" },
    sql: base.sql.replace("scenario_id = :scenarioId AND ", ""),
  };
  const transport = createZetarisHttpTransport({
    ...zetarisDeadlines(env, runtime.db.records("operation.dataRead")),
    profile: "installed-sql-v1",
    openUrl: env.ZETARIS_OPEN_URL,
    pageUrl: env.ZETARIS_PAGE_URL,
    closeUrl: env.ZETARIS_CLOSE_URL,
    pageMethod: env.ZETARIS_PAGE_METHOD,
    closeMethod: env.ZETARIS_CLOSE_METHOD,
    bearerToken: env.ZETARIS_BEARER_TOKEN,
    orgId: env.ZETARIS_ORG_ID,
    allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
  });
  const reader = createDataReader({
    mode: "zetaris",
    templates: { [template.id]: template },
    zetaris: createZetarisDataSource({ transport }),
  });
  const discovery = await new DataEvidenceService(runtime, runtime.operations.records, reader).read(
    {
      incidentId: record.stageIncidentId,
      taskId,
      templateId: template.id,
      parameters: { sku: scope.sku, locationId: scope.locationId },
    },
  );
  const scenarios = [
    ...new Set(discovery.evidence.map((e) => JSON.parse(e.content).scenario_id)),
  ].filter((s) => typeof s === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(s));
  if (scenarios.length === 1) return { scope: { ...scope, scenarioId: scenarios[0] }, discovery };
  // Nothing found is a blocked investigation, never a prompt to try a different SKU.
  if (!scenarios.length) throw new Error(notFound(scope, "the approved live inventory source"));
  return {
    discovery,
    clarification: `Several snapshots match: ${scenarios.slice(0, 3).join(", ")}. Which should the team investigate? Add its name after “scenario” in your goal.`,
  };
}
const notFound = ({ sku, locationId }, source) =>
  `Blocked: ${sku ?? "the SKU"} at ${locationId ?? "the location"} has no physical count records in ${source}. No other SKU or location was substituted.`;
/** Which source a task reads, shown to the user: never a silent synthetic substitute. */
export function dataSourceLabel(runtime, record) {
  if (record.route.domain === "research") return { mode: "WEB", label: "Web search (Tavily)" };
  if (record.route.domain === "supplier_delivery")
    return {
      mode: "LIVE",
      label: `LIVE Zetaris · ${Object.values(SUPPLIER_TEMPLATES)
        .map((template) => /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(template.sql)[1])
        .join(", ")} (SYNTHETIC DATA)`,
    };
  if (record.route.domain === "inventory") {
    const reader = runtime.operations.data?.reader;
    const tables = Object.values(reader?.inventoryTemplates ?? {})
      .map((template) => /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(template.sql)?.[1])
      .filter(Boolean);
    return reader?.serviceId === "zetaris"
      ? { mode: "LIVE", label: `LIVE Zetaris · ${tables.join(", ")}` }
      : { mode: "SYNTHETIC", label: "SYNTHETIC in-process inventory fixtures (not live data)" };
  }
  const query = record.query;
  return {
    mode: "LIVE",
    label: `LIVE Zetaris · ${query ? `${query.dataset}${query.table ? `.${query.table}` : ""}` : "approved analytics templates"}`,
  };
}

/** A read failure's category, from the adapter's diagnostics rather than its wording. */
export function failureCategory(error) {
  const diagnostics = error?.queryDiagnostics ?? {};
  if (diagnostics.outcome === "timeout") return "timeout";
  if (error?.serviceStatus === "unauthorized" || [401, 403].includes(diagnostics.httpStatus))
    return "unauthorized";
  if (diagnostics.outcome === "network_error" || error?.serviceStatus === "unreachable")
    return "unreachable";
  if ([400, 404, 422].includes(diagnostics.httpStatus)) return "invalid query or missing table";
  if (diagnostics.outcome === "http_error") return "server error";
  return "failed";
}

/** SKU, location and named scenario exactly as the user wrote them (one shared parser). */
export function inventoryScope(goal) {
  const { scenarioId, sku, locationId } = parseInventoryRequest(goal);
  return { scenarioId, sku: sku?.replace(/[.,;:]+$/, ""), locationId };
}
function integer(value) {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Evidence contains an invalid nonnegative count.");
  return value;
}
/** A preview passes only when exactly the requested number of distinct records came back. */
export function previewChecks(reads, query) {
  validateApprovedQuery(query);
  const evidence = reads["record-preview"]?.evidence ?? [];
  const recordIds = evidence.map((item) => item.recordId);
  const scope = `${query.dataset}.${query.table} (${query.fields.join(", ")})`;
  if (!evidence.length)
    return {
      status: "unresolved",
      reason: `The approved preview of ${scope} returned no records.`,
    };
  if (evidence.length !== query.limit)
    return {
      status: "unresolved",
      reason: `Requested ${query.limit} records from ${scope}; the source returned ${evidence.length}. The requested count was not met.`,
    };
  return {
    status: "checked",
    preview: { requested: query.limit, returned: evidence.length, recordIds },
    description: `${evidence.length} records read from ${scope} by the approved read-only preview, ordered by every approved column. A sample, not a statistical summary of the table.`,
  };
}

export function analyticsChecks(domain, reads, query) {
  if (query) validateApprovedQuery(query);
  const evidence = Object.values(reads).flatMap((r) => r.evidence);
  if (!evidence.length)
    throw new Error("No source evidence was returned; no ranking can be verified.");
  let ranking;
  if (domain === "taxi_analytics")
    ranking = evidence.map((e) => ({
      id: e.recordId,
      label: JSON.parse(e.content).zone,
      value: integer(JSON.parse(e.content).trip_count),
    }));
  else {
    const returns = new Map(
      reads["retail-returns"].evidence.map((e) => [
        e.recordId,
        integer(JSON.parse(e.content).returned),
      ]),
    );
    const sales = reads["retail-sales"].evidence;
    if ([...returns.keys()].some((id) => !sales.some((e) => e.recordId === id)))
      throw new Error("Returns lack matching sales categories.");
    ranking = sales.map((e) => {
      const row = JSON.parse(e.content);
      const sold = integer(row.sold);
      if (!sold) throw new Error("A return-rate denominator is zero.");
      const returned = returns.get(e.recordId) ?? 0;
      return { id: e.recordId, label: row.category, sold, returned, value: returned / sold };
    });
  }
  if (new Set(ranking.map((r) => r.id)).size !== ranking.length)
    throw new Error("Duplicate source groups cannot establish a ranking.");
  ranking.sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));
  if (ranking.some((row) => typeof row.label !== "string" || !row.label.trim()))
    throw new Error("A requested source label is missing.");
  if (query) ranking = ranking.slice(0, query.limit);
  return {
    status: "checked",
    ranking,
    description:
      query && domain === "taxi_analytics"
        ? `Top ${query.limit} pickup zones by trip count, ${query.startHour}:00 inclusive to ${query.endHour}:00 exclusive in source time, across available sample trips. Invalid timestamps excluded.`
        : domain === "taxi_analytics"
          ? "Top 20 pickup zones, 22:00–05:59 in source time, across available sample trips; invalid timestamps excluded."
          : "Store-channel returned units divided by sold units, across the available TPCDS sample; not a matched sales cohort or causal explanation.",
  };
}
export async function collectComposerEvidence(
  runtime,
  record,
  taskId,
  env,
  suppliedReader,
  suppliedWebReader,
) {
  const inventory = record.route.domain === "inventory";
  const research = record.route.domain === "research";
  const supplier = record.route.domain === "supplier_delivery";
  if (runtime.services && !suppliedReader && !suppliedWebReader && !inventory) {
    const capability = research ? "web_search" : "approved_sql_read";
    const selection = runtime.services.resolve([capability]);
    const selected = [...selection.available, ...selection.blocked].find((service) =>
      ["available", "unverified"].includes(service.status),
    );
    if (!selected)
      throw new Error(
        `Required ${capability} service blocked: ${selection.blocked.map((s) => `${s.id}: ${s.status} (${s.reason})`).join(", ") || "no registered service"}`,
      );
  }
  const reader = inventory
    ? runtime.operations.data?.reader
    : research
      ? (suppliedWebReader ??
        createWebSearchReader({
          apiKey: env.TAVILY_API_KEY,
          keyless: env.TAVILY_KEYLESS === "1",
        }))
      : supplier
        ? (suppliedReader ?? supplierReader(env, runtime.db.records("operation.dataRead")))
        : (suppliedReader ??
          analyticsReader(env, record.query, runtime.db.records("operation.dataRead")));
  if (!reader) throw new Error("The approved inventory reader is not configured.");
  const service = new DataEvidenceService(runtime, runtime.operations.records, reader);
  // The user's goal is only a search query here; it never selects SQL, tools or permissions.
  const scope = inventory
    ? (record.scope ?? inventoryScope(record.input.goal))
    : research
      ? { query: record.input.goal.slice(0, 400) }
      : supplier
        ? { poId: record.purchaseOrder }
        : {};
  const ids = inventory
    ? INVENTORY_READS
    : supplier
      ? SUPPLIER_READS
      : research
        ? [["web-search", "web-search"]]
        : record.query?.operation === "record-preview"
          ? [["record-preview", "record-preview"]]
          : record.route.domain === "retail_analytics"
            ? [
                ["retail-sales", "retail-sales"],
                ["retail-returns", "retail-returns"],
              ]
            : [["taxi-night", "taxi-night"]];
  const reads = {};
  for (const [kind, templateId] of ids) {
    reads[kind] = await service.read({
      incidentId: record.stageIncidentId,
      taskId,
      templateId,
      parameters: scope,
      requestId: `${record.id}:${record.attempt}:${templateId}`,
    });
    // An empty search or preview is reported by its checks with the specific reason.
    if (
      (research || inventory || supplier || templateId === "record-preview") &&
      !reads[kind].evidence.length
    )
      continue;
    runtime.operations.orchestration.attachEvidence({
      incidentId: record.stageIncidentId,
      taskId,
      evidenceIds: reads[kind].evidence.map((e) => e.evidenceId),
    });
  }
  // Source extraction deepens the top search results; snippets still stand if it fails.
  const urls = research ? extractionTargets(reads["web-search"]) : [];
  if (urls.length) {
    try {
      const extracted = await service.read({
        incidentId: record.stageIncidentId,
        taskId,
        templateId: "web-extract",
        parameters: { ...scope, urls },
        requestId: `${record.id}:${record.attempt}:web-extract`,
      });
      if (extracted.evidence.length) {
        reads["web-extract"] = extracted;
        runtime.operations.orchestration.attachEvidence({
          incidentId: record.stageIncidentId,
          taskId,
          evidenceIds: extracted.evidence.map((e) => e.evidenceId),
        });
      }
    } catch {
      /* Search evidence remains citable without extracted text. */
    }
  }
  const checks = inventory
    ? Object.values(reads).every((read) => !read.evidence.length)
      ? {
          status: "unresolved",
          reason: notFound(
            scope,
            reader.serviceId === "zetaris"
              ? "the approved live inventory source"
              : "the SYNTHETIC inventory fixtures",
          ),
        }
      : reconcileInventoryEvidence(reads, {
          ...scope,
          incidentId: record.stageIncidentId,
          taskId,
          templates: reader.inventoryTemplates,
        })
    : research
      ? researchChecks(reads)
      : supplier
        ? reconcileSupplierDelivery(reads, { poId: record.purchaseOrder })
        : record.query?.operation === "record-preview"
          ? previewChecks(reads, record.query)
          : analyticsChecks(record.route.domain, reads, record.query);
  const evidence = Object.values(reads).flatMap((r) => r.evidence);
  const bundle = {
    scope,
    taskId,
    incidentId: record.stageIncidentId,
    reads,
    evidence,
    checks,
    createdAt: new Date().toISOString(),
  };
  return { ...bundle, bundleId: createHash("sha256").update(JSON.stringify(bundle)).digest("hex") };
}
