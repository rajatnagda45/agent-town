import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertOperationContract } from "../operations-contracts.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const READABLE = new Set(["queued", "submitted", "running", "completed"]);

/** Resolve a data read from persisted task and seat identity, never a caller-supplied scope. */
export function resolveDataTaskScope(runtime, records, incidentId, taskId) {
  const incident = records.get("incident", incidentId)?.value;
  const linked = records.get("task", taskId)?.value;
  const task = runtime.db.getTask(taskId);
  if (
    !incident ||
    !linked ||
    !task ||
    linked.incidentId !== incidentId ||
    !READABLE.has(task.status)
  )
    throw fail(404, "No readable task belongs to this incident.");
  const { seat, agentId, sessionKey } = runtime.resolve(task.seatId, task.sessionKey);
  const binding = linked.assignment;
  if (
    !binding ||
    binding.runtimeTaskId !== task.taskId ||
    binding.seatId !== seat.seatId ||
    binding.agentId !== agentId ||
    binding.bindingRevision !== seat.binding.revision ||
    binding.gatewayId !== task.gatewayId ||
    binding.sessionKey !== sessionKey ||
    task.bindingRevision !== seat.binding.revision ||
    task.agentId !== agentId ||
    task.gatewayId !== runtime.gatewayId
  )
    throw fail(409, "Task binding changed or does not match the persisted incident task.");
  return Object.freeze({
    incidentId,
    taskId,
    seatId: seat.seatId,
    agentId,
    gatewayId: task.gatewayId,
    sessionKey,
    bindingRevision: seat.binding.revision,
  });
}

export class DataEvidenceService {
  constructor(runtime, records, reader, { clock = () => new Date() } = {}) {
    this.runtime = runtime;
    this.records = records;
    this.reader = reader;
    this.clock = clock;
  }

  async read({ incidentId, taskId, templateId, parameters = {}, requestId }) {
    const scope = resolveDataTaskScope(this.runtime, this.records, incidentId, taskId);
    let request;
    if (requestId !== undefined) {
      if (typeof requestId !== "string" || !requestId.length || requestId.length > 200)
        throw fail(400, "Invalid data request ID.");
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ scope, templateId, parameters }))
        .digest("hex");
      request = this.runtime.db.record("operation.dataRequest", requestId);
      if (request) {
        if (request.fingerprint !== fingerprint)
          throw fail(409, "Data request ID belongs to different parameters or binding.");
        if (request.status === "completed") return request.result;
        if (request.status === "started")
          this.runtime.db.saveRecord(
            "operation.dataRequest",
            requestId,
            { ...request, status: "execution_outcome_unknown" },
            request.revision,
          );
        throw Object.assign(
          fail(
            409,
            "Data request outcome is unknown or failed; reconcile its audit before retrying with a new request ID.",
          ),
          { executionOutcomeUnknown: request.status !== "failed" },
        );
      }
      request = this.runtime.db.saveRecord(
        "operation.dataRequest",
        requestId,
        {
          fingerprint,
          status: "started",
          incidentId,
          taskId,
          templateId,
          startedAt: this.clock().toISOString(),
          plannedQuery: this.reader.describeRead?.({ templateId, parameters }),
        },
        0,
      );
    }
    this.runtime.services?.observe(this.reader.serviceId, "unverified");
    let result;
    try {
      result = await this.reader.read({ templateId, parameters, scope });
    } catch (error) {
      this.runtime.services?.observe(
        error?.serviceId,
        error?.serviceStatus,
        error?.queryDiagnostics?.outcome === "timeout" ? "query_timeout" : undefined,
      );
      if (request) {
        // Failed reads remain non-retryable under the same request ID. Persist only
        // structured server diagnostics, never arbitrary provider messages/headers.
        const diagnostics = {};
        for (const key of [
          "sql",
          "requestId",
          "stage",
          "method",
          "timeoutMs",
          "elapsedMs",
          "outcome",
          "httpStatus",
          "tokenAcquired",
          "cleanup",
        ]) {
          const value = error.queryDiagnostics?.[key];
          if (["string", "number", "boolean"].includes(typeof value)) diagnostics[key] = value;
        }
        this.runtime.db.saveRecord(
          "operation.dataRequest",
          requestId,
          {
            ...request,
            status: diagnostics.outcome === "timeout" ? "execution_outcome_unknown" : "failed",
            finishedAt: this.clock().toISOString(),
            diagnostics,
          },
          request.revision,
        );
      }
      throw error;
    }
    const current = resolveDataTaskScope(this.runtime, this.records, incidentId, taskId);
    if (!isDeepStrictEqual(current, scope) || !isDeepStrictEqual(result.scope, scope))
      throw fail(409, "Data task binding changed during the read.");
    if (!Array.isArray(result.evidence) || result.evidence.length > 100)
      throw fail(502, "Data adapter returned invalid evidence.");
    for (const item of result.evidence) {
      assertOperationContract("evidenceItem", item);
      if (
        item.incidentId !== incidentId ||
        item.taskId !== taskId ||
        !item.source.startsWith(`${result.mode}:`)
      )
        throw fail(502, "Data adapter returned evidence outside the verified task scope.");
    }
    const readId = `dataread_${createHash("sha256")
      .update(
        JSON.stringify([
          incidentId,
          taskId,
          templateId,
          Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)),
          result.mode,
          result.evidence.map((item) => item.evidenceId),
        ]),
      )
      .digest("hex")}`;
    const saved = result.evidence.map((item) => {
      const previous = this.records.get("evidenceItem", item.evidenceId);
      if (previous) {
        const oldSource = { ...previous.value };
        const newSource = { ...item };
        delete oldSource.retrievedAt;
        delete oldSource.auditRef;
        delete newSource.retrievedAt;
        if (!isDeepStrictEqual(oldSource, newSource))
          throw fail(409, "Evidence ID was reused for different source content.");
        if (previous.value.auditRef !== readId)
          throw fail(409, "Evidence ID was reused for a different data read audit.");
        return previous.value;
      }
      return this.records.put("evidenceItem", { ...item, auditRef: readId }).value;
    });
    const existingAudit = this.runtime.db.record("operation.dataRead", readId);
    if (!existingAudit)
      this.runtime.db.saveRecord(
        "operation.dataRead",
        readId,
        {
          incidentId,
          taskId,
          templateId,
          mode: result.mode,
          evidenceIds: saved.map((item) => item.evidenceId),
          sourceRefs: saved.map((item) => ({ source: item.source, recordId: item.recordId })),
          binding: scope,
          createdAt: this.clock().toISOString(),
          ...(result.queryDiagnostics ? { diagnostics: result.queryDiagnostics } : {}),
        },
        undefined,
        (stored) => ({ id: stored.id, revision: stored.revision, incidentId, taskId }),
      );
    if (result.mode === "zetaris" || result.mode === "web")
      this.runtime.services?.observe(result.mode === "web" ? "web-search" : "zetaris", "available");
    const response = {
      evidence: saved,
      auditRef: readId,
      scope,
      ...(result.queryDiagnostics ? { diagnostics: result.queryDiagnostics } : {}),
    };
    if (request)
      this.runtime.db.saveRecord(
        "operation.dataRequest",
        requestId,
        { ...request, status: "completed", result: response },
        request.revision,
      );
    return response;
  }
}
