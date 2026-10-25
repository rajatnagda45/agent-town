import Ajv from "ajv";
import { previewCount } from "./approved-data.mjs";

const DATA_SOURCE = /\b(?:zetaris|dataset|database|sql|table)\b/i;
export const PREVIEW_CLARIFICATION =
  "Which approved dataset and table should be previewed: NY_TAXI (trips, zones) or TPCDS_DB (store_sales, store_returns, item)?";
/** The purchase order a request names, normalised to "PO-1042", or null. */
export const purchaseOrderId = (goal) => {
  const digits = /\bPO[-_ ]?(\d{3,})\b/i.exec(String(goal))?.[1];
  return digits ? `PO-${digits}` : null;
};
/** A request to read N records from a data source. */
export const dataPreviewRequested = (goal) => previewCount(goal) !== null && DATA_SOURCE.test(goal);

const strings = (maxItems = 12) => ({
  type: "array",
  maxItems,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 500 },
});
export const ROUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "domain",
    "workflow",
    "dataSources",
    "requestedActions",
    "risk",
    "successCriteria",
    "requiredCapabilities",
    "confidence",
    "clarification",
  ],
  properties: {
    intent: { enum: ["investigate", "prepare", "converse", "act", "clarify"] },
    domain: {
      enum: [
        "inventory",
        "taxi_analytics",
        "retail_analytics",
        "supplier_delivery",
        "research",
        "general",
        "conversation",
        "unknown",
      ],
    },
    workflow: {
      enum: [
        "general-team-task",
        "zetaris-investigation",
        "inventory-investigation",
        "web-research",
        "existing-conversation",
        "unresolved",
      ],
    },
    dataSources: {
      type: "array",
      maxItems: 1,
      uniqueItems: true,
      items: { enum: ["inventory", "NY_TAXI", "TPCDS_DB", "SUPPLIER", "web"] },
    },
    requestedActions: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: { enum: ["read", "calculate", "report", "converse", "propose", "mutate", "external"] },
    },
    risk: { enum: ["read_only", "approval_required"] },
    successCriteria: strings(6),
    requiredCapabilities: strings(6),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    clarification: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 300 }] },
  },
};
const validate = new Ajv({ allErrors: true }).compile(ROUTE_SCHEMA);
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const domains = {
  supplier_delivery: [
    "zetaris-investigation",
    ["SUPPLIER"],
    "Reconcile the purchase order against goods receipts, shipments and supplier confirmations, citing evidence IDs, and recommend the next action without approving payment or changing records.",
  ],
  inventory: [
    "inventory-investigation",
    ["inventory"],
    "Verify the shortage against current ledger, count, transfer and receipt evidence.",
  ],
  taxi_analytics: [
    "zetaris-investigation",
    ["NY_TAXI"],
    "Rank nighttime pickup zones using actual trip counts; cite evidence and verify ranking.",
  ],
  retail_analytics: [
    "zetaris-investigation",
    ["TPCDS_DB"],
    "Calculate category return rates from sales and returns; cite evidence and verify ranking.",
  ],
  research: [
    "web-research",
    ["web"],
    "Answer from server-retrieved web sources; cite every source and label unverified claims.",
  ],
  general: [
    "general-team-task",
    [],
    "Produce the requested report or plan; distinguish verified facts from recommendations.",
  ],
  conversation: [
    "existing-conversation",
    [],
    "Continue the requested conversation without submitting an operational task.",
  ],
  unknown: ["unresolved", [], "Clarify the intended result before acting."],
};
// Negative constraints are restrictions, not authorization for the verbs they prohibit.
export function mutationRequested(goal) {
  const positive = goal.replace(
    /\b(?:do not|don't|never|without|must not)\s+(?:\w+\s+){0,2}(?:modify|change|delete|update|write|send|publish|execute|adjust|transfer|deploy|approve|pay)\b[^.!?;\n]*/gi,
    "",
  );
  // "purchase order" names a record to read, not a purchase to make.
  return /\b(?:delete|drop|truncate|insert|update|alter|grant|revoke|deploy|publish|send|email|purchase(?!\s+orders?\b)|refund|pay|approve|execute|overwrite|adjust)\b|\bchange\b.{0,50}\b(?:inventory|stock|units|quantity|permissions)\b/i.test(
    positive,
  );
}
export function interpretation(domain, confidence, clarification = null) {
  const [workflow, dataSources, criterion] = domains[domain];
  return {
    intent:
      domain === "conversation"
        ? "converse"
        : domain === "general"
          ? "prepare"
          : domain === "unknown"
            ? "clarify"
            : "investigate",
    domain,
    workflow,
    dataSources,
    requestedActions: domain === "conversation" ? ["converse"] : ["read", "calculate", "report"],
    risk: "read_only",
    successCriteria: [criterion],
    requiredCapabilities:
      domain === "conversation" ? ["conversation"] : ["planning", "analysis", "independent_review"],
    confidence,
    clarification,
  };
}
export function validateInterpretation(value, goal) {
  if (!validate(value)) throw fail("Invalid structured task interpretation.");
  const expected = domains[value.domain];
  if (
    value.workflow !== expected[0] ||
    JSON.stringify(value.dataSources) !== JSON.stringify(expected[1])
  )
    throw fail("Workflow and data source do not match the reviewed domain.");
  const route = structuredClone(value);
  // A record preview is data work: a general or research draft can never satisfy it.
  if (
    dataPreviewRequested(goal) &&
    !["taxi_analytics", "retail_analytics", "inventory"].includes(route.domain)
  ) {
    route.clarification = PREVIEW_CLARIFICATION;
    route.confidence = Math.min(route.confidence, 0.5);
  }
  if (
    mutationRequested(goal) ||
    route.requestedActions.some((a) => ["mutate", "external"].includes(a)) ||
    route.risk === "approval_required"
  ) {
    route.risk = "approval_required";
    route.intent = "act";
    route.requestedActions = ["propose", "mutate"];
  }
  if (route.confidence < 0.65 && !route.clarification)
    route.clarification =
      "What specific result should the team produce, and which records or context should it use?";
  return route;
}
/** Web research is recognised by what it needs (an external lookup of sources or
 * information), not by one fixed verb and noun pair. A gathering verb plus an explicit web
 * cue, or the original lookup-of-documents phrasing, requires server-retrieved evidence. */
const LOOKUP_VERB =
  /\b(?:find|look up|lookup|search(?: for)?|research|locate|gather|collect|investigate|learn about|read up on|dig up)\b/i;
const WEB_CUE = /\b(?:internet|web|online|google|websites?|the net)\b/i;
const SOURCE_NOUN =
  /\b(?:manuals?|documentation|docs|datasheets?|sources?|specifications?|specs|guides?|articles?|papers?|references?|information|info|background|citations?)\b/i;
export function webResearchRequested(goal) {
  if (WEB_CUE.test(goal) && LOOKUP_VERB.test(goal) && SOURCE_NOUN.test(goal)) return true;
  return /\b(?:find|look up|lookup|search(?: for)?|research|locate)\b.{0,80}\b(?:manuals?|documentation|docs|datasheets?|sources?|specifications?|specs|guides?|articles?|papers?|references?)\b/i.test(
    goal,
  );
}
export function routeGoal(goal, successCriteria = []) {
  if (typeof goal !== "string" || !goal.trim() || goal.length > 2000)
    throw fail("Describe a goal in 1–2000 characters.");
  let route;
  const supplier = /\bPO[-_ ]?\d{3,}\b|\bpurchase orders?\b/i.test(goal);
  const inventory =
    /\binventory\b|\bstock\b|\bSKU[\s:-]|\b(?:bin|warehouse)\b|\bcycle[- ]count\b/i.test(goal);
  const taxi =
    /\bNY_TAXI\b|\btaxi\b|\b(?:trip|pickup|dropoff|cab)\w*\b.{0,40}\b(?:zone|night|busiest)\w*\b/i.test(
      goal,
    );
  const retail =
    /\bTPCDS_DB\b|\bretail\b|\breturn\w*\b.{0,60}\b(?:rate|categor|product|sale|item|customer)\w*\b|\b(?:product|sale|item|customer|categor)\w*\b.{0,60}\breturn\w*\b/i.test(
      goal,
    );
  if (
    /\b(?:ignore|override|bypass)\b.{0,60}\b(?:instructions|policy|rules|approval|validation)\b|\b(?:system|developer)\s*:/i.test(
      goal,
    )
  )
    route = interpretation(
      "unknown",
      0.2,
      "What business result do you want, without changing the team's permissions or instructions?",
    );
  // A named purchase order is a supplier delivery investigation, even if it mentions stock.
  else if (supplier && !taxi && !retail)
    route = purchaseOrderId(goal)
      ? interpretation("supplier_delivery", 0.95)
      : interpretation(
          "unknown",
          0.4,
          "Which purchase order should the team investigate? Give its number, for example PO-1042.",
        );
  else if ([inventory, taxi, retail].filter(Boolean).length > 1)
    route = interpretation(
      "unknown",
      0.4,
      "Which problem should the team investigate first: inventory, taxi activity, or retail returns?",
    );
  else if (/\b(?:talk|chat|speak|conversation)\b.{0,40}\b(?:with|to)\b/i.test(goal))
    route = interpretation("conversation", 0.96);
  else if (inventory) route = interpretation("inventory", 0.96);
  else if (!taxi && !retail && dataPreviewRequested(goal))
    route = interpretation("unknown", 0.5, PREVIEW_CLARIFICATION);
  else if (taxi) route = interpretation("taxi_analytics", 0.94);
  else if (retail) route = interpretation("retail_analytics", 0.94);
  else if (webResearchRequested(goal)) route = interpretation("research", 0.9);
  else if (
    /\b(?:prepare|draft|write|summarize|review|plan|report|readiness|release|research|agenda|outline|presentation|demo)\b/i.test(
      goal,
    )
  )
    route = interpretation("general", 0.85);
  else
    route = interpretation(
      "unknown",
      0.3,
      "What specific result should the team produce, and which records or context should it use?",
    );
  if (successCriteria.length) route.successCriteria = successCriteria;
  return validateInterpretation(route, goal);
}

/** Requests that need server-read evidence rather than an agent opinion. Inventory work is
 * opt-in: the composer handles it, while the group chat routes it to an investigation. */
export function dataIntent(message, { inventory = false } = {}) {
  if (typeof message !== "string" || !message.trim() || message.length > 2000) return null;
  let route;
  try {
    route = routeGoal(message);
  } catch {
    return null;
  }
  const workflows = ["zetaris-investigation", "web-research"];
  if (inventory) workflows.push("inventory-investigation");
  return workflows.includes(route.workflow) || dataPreviewRequested(message)
    ? { kind: "data_request", goal: message.trim() }
    : null;
}
