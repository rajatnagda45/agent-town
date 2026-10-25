import { createHash } from "node:crypto";
import { assertOperationContract } from "../operations-contracts.mjs";

const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
const isoTime = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Scope must come from a verified runtime binding, never an agent tool argument. */
export function assertDataScope(scope) {
  if (
    !scope ||
    !id(scope.incidentId) ||
    !id(scope.taskId) ||
    !id(scope.agentId) ||
    !id(scope.seatId) ||
    !id(scope.gatewayId) ||
    !id(scope.sessionKey) ||
    !Number.isSafeInteger(scope.bindingRevision) ||
    scope.bindingRevision < 1
  )
    throw new Error("A verified incident, task and agent binding are required for data reads.");
  return Object.freeze({
    incidentId: scope.incidentId,
    taskId: scope.taskId,
    agentId: scope.agentId,
    seatId: scope.seatId,
    gatewayId: scope.gatewayId,
    sessionKey: scope.sessionKey,
    bindingRevision: scope.bindingRevision,
  });
}

/** Keep the original source time separate from retrieval time; never infer one from the other. */
export function evidenceFromRecord({ row, template, scope, origin, retrievedAt }) {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new Error("Data source returned an invalid record.");
  if (!isoTime(retrievedAt)) throw new Error("Invalid evidence retrieval time.");
  const recordId = row[template.recordIdField];
  if (!(typeof recordId === "string" || Number.isSafeInteger(recordId)) || !id(String(recordId)))
    throw new Error("Data source record has no stable identifier.");
  const rawTime = template.timestampField ? row[template.timestampField] : null;
  if (rawTime !== null && rawTime !== undefined && !isoTime(rawTime))
    throw new Error("Data source returned an invalid source timestamp.");
  const sourceTimestamp = rawTime ?? null;
  const content = {};
  for (const field of template.fields) {
    const value = row[field];
    if (
      value !== undefined &&
      value !== null &&
      (typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean")
    )
      content[field] = value;
  }
  if (!Object.keys(content).length) throw new Error("Data source record has no allowed content.");
  const source = `${origin}:${template.source}`;
  const serialized = JSON.stringify(content);
  if (serialized.length > 12000)
    throw new Error("Data source record exceeds evidence content limit.");
  const evidenceId = createHash("sha256")
    .update(
      JSON.stringify([
        scope.incidentId,
        scope.taskId,
        source,
        String(recordId),
        sourceTimestamp,
        serialized,
      ]),
    )
    .digest("hex");
  const freshUntil =
    sourceTimestamp && Number.isSafeInteger(template.maxAgeMs) && template.maxAgeMs > 0
      ? new Date(Date.parse(sourceTimestamp) + template.maxAgeMs).toISOString()
      : undefined;
  return assertOperationContract("evidenceItem", {
    evidenceId,
    incidentId: scope.incidentId,
    taskId: scope.taskId,
    source,
    recordId: String(recordId),
    sourceTimestamp,
    retrievedAt,
    ...(freshUntil ? { freshUntil } : {}),
    content: serialized,
  });
}
