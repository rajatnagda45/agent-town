import Ajv from "ajv";

const id = { type: "string", minLength: 1, maxLength: 128 };
const text = { type: "string", minLength: 1, maxLength: 2000 };
const ids = { type: "array", items: id, maxItems: 40, uniqueItems: true };
const missing = {
  type: "array",
  items: { ...text, maxLength: 500 },
  maxItems: 20,
  uniqueItems: true,
};
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const scope = object({
  scenarioId: { ...id, maxLength: 64 },
  sku: { ...id, maxLength: 64 },
  locationId: { ...id, maxLength: 64 },
});
const revision = { type: "integer", minimum: 1 };
const timestamp = { type: "string", format: "reasoning-time" };
const nullableTime = { anyOf: [timestamp, { type: "null" }] };
const quantity = { anyOf: [{ type: "integer" }, { type: "null" }] };
const hypothesis = object({
  hypothesisId: id,
  statement: text,
  supportingEvidenceIds: ids,
  contradictingEvidenceIds: ids,
  missingEvidence: missing,
  claimedExplainedUnits: { type: "integer", minimum: 0 },
});
const checks = object({
  supported: { type: "boolean" },
  reason: { type: "string", maxLength: 2000 },
  ledgerQuantity: quantity,
  countQuantity: quantity,
  discrepancy: quantity,
  explained: quantity,
  unexplained: quantity,
  applicableEvidenceIds: ids,
  explanationEvidenceIds: ids,
  excludedEvidence: {
    type: "array",
    maxItems: 40,
    items: object({ evidenceId: id, reason: text }),
  },
});

export const REASONING_SCHEMAS = {
  analysis: object({
    bundleId: id,
    primaryHypothesisId: { anyOf: [id, { type: "null" }] },
    hypotheses: { type: "array", minItems: 0, maxItems: 4, items: hypothesis },
  }),
  critic: object({
    bundleId: id,
    decision: { enum: ["ACCEPT", "REVISE", "UNCERTAIN"] },
    hypothesisIds: { ...ids, maxItems: 4 },
    evidenceIds: ids,
    reasoning: text,
    missingEvidence: missing,
    nextTasks: {
      type: "array",
      maxItems: 4,
      items: object({ templateId: id, parameters: scope, reason: { ...text, maxLength: 500 } }),
    },
  }),
  bundle: object({
    schemaVersion: { const: 1 },
    bundleId: id,
    incidentId: id,
    taskId: id,
    createdAt: timestamp,
    scope,
    temporalScope: object({ openingAt: nullableTime, countCutoffAt: nullableTime }),
    businessRules: object({
      domain: { const: "inventory-shortage-v1" },
      maxUnexplainedUnits: { type: "integer", minimum: 0, maximum: 100 },
      rules: { type: "array", minItems: 1, maxItems: 10, items: text },
    }),
    evidence: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: object({
        evidenceId: id,
        revision,
        source: text,
        recordId: id,
        auditRef: id,
        sourceTimestamp: timestamp,
        retrievedAt: timestamp,
        freshUntil: timestamp,
      }),
    },
    audits: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: object({ auditRef: id, revision, templateId: id, createdAt: timestamp }),
    },
    memory: {
      type: "array",
      maxItems: 5,
      items: object({
        memoryId: id,
        verificationId: id,
        incidentId: id,
        evidenceIds: ids,
        freshUntil: timestamp,
        content: text,
        applicability: text,
      }),
    },
    checks,
  }),
  state: object({
    schemaVersion: { const: 1 },
    incidentId: id,
    rootIncidentId: id,
    attempt: { type: "integer", minimum: 1, maximum: 2 },
    maxAttempts: { const: 2 },
    stage: {
      enum: [
        "awaiting_evidence",
        "evidence_ready",
        "hypotheses_ready",
        "evaluated",
        "verified",
        "revision_required",
        "unresolved",
      ],
    },
    bundleId: { anyOf: [id, { type: "null" }] },
    analysis: { anyOf: [{ $ref: "#/definitions/analysis" }, { type: "null" }] },
    critic: { anyOf: [{ $ref: "#/definitions/critic" }, { type: "null" }] },
    issues: missing,
    verificationId: { anyOf: [id, { type: "null" }] },
    history: { type: "array", maxItems: 8, items: object({ stage: id, at: timestamp }) },
  }),
};
REASONING_SCHEMAS.state.definitions = {
  analysis: REASONING_SCHEMAS.analysis,
  critic: REASONING_SCHEMAS.critic,
};
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addFormat("reasoning-time", (value) => Number.isFinite(Date.parse(value)));
const validators = Object.fromEntries(
  Object.entries(REASONING_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);
export function assertReasoningContract(kind, value) {
  if (!validators[kind]?.(value)) throw new Error(`Invalid Phase 3 ${kind} schema.`);
  return value;
}

export const PHASE3_CONSTRAINT = "inventory-reasoning-v3";
export const isPhase3 = (plan) =>
  Array.isArray(plan?.incident?.constraints) &&
  plan.incident.constraints.includes(PHASE3_CONSTRAINT);
export function phase3Messages(tasks) {
  return tasks.map((task) =>
    task.taskId === "analyst"
      ? {
          ...task,
          message:
            "Propose zero to four competing inventory-shortage hypotheses from the supplied versioned evidence bundle. Do not invent alternatives to reach a quota. Hypotheses are proposals, never verified facts. Use memory only to prioritize investigation, not as current evidence. Return only JSON: {bundleId, primaryHypothesisId (string or null), hypotheses:[{hypothesisId, statement, supportingEvidenceIds, contradictingEvidenceIds, missingEvidence, claimedExplainedUnits}]}. All evidence IDs must belong to the bundle. Support must be temporally applicable. Pick the best supported hypothesis as primary; use null only when there are none. Calculate claimedExplainedUnits from the attached records; cite exactly the applicable explanation records for the primary hypothesis. List unresolved gaps explicitly.",
        }
      : task.taskId === "critic"
        ? {
            ...task,
            message:
              "Challenge the supplied hypotheses against the current versioned evidence bundle and deterministic checks. Return only JSON: {bundleId, decision (ACCEPT, REVISE or UNCERTAIN), hypothesisIds, evidenceIds, reasoning, missingEvidence, nextTasks:[{templateId, parameters:{scenarioId,sku,locationId}, reason}]}. ACCEPT needs a supported primary hypothesis with complete applicable explanation citations and no gaps, contradictions or next tasks. REVISE requires specific missing evidence and one to four reviewed inventory read templates using this bundle's exact scope. UNCERTAIN ends unresolved. Only use supplied bundle/hypothesis/evidence IDs. Proposals never authorize tools or establish verified success. The server independently verifies any acceptance. Two reasoning attempts total are allowed.",
          }
        : task,
  );
}
