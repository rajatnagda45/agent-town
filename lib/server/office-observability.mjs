import { OperationRecords } from "./operation-records.mjs";

const recent = (rows, field) =>
  rows.sort((a, b) => String(b[field] ?? "").localeCompare(String(a[field] ?? ""))).slice(0, 80);
const reference = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const label = (value) =>
  typeof value === "string" && /^(?:synthetic|zetaris):[A-Za-z0-9_.-]{1,80}$/.test(value)
    ? value
    : "Recorded source";
const state = (value) =>
  typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : undefined;

/** A bounded, read-only view for the local single-user office. Raw evidence stays server-side. */
export function officeOverview(runtime) {
  const records = new OperationRecords(runtime.db);
  const cursor = runtime.db.cursor();
  const evidence = recent(
    records.list("evidenceItem").map(({ revision, value }) => ({
      evidenceId: value.evidenceId,
      incidentId: value.incidentId,
      taskId: value.taskId,
      source: label(value.source),
      sourceTimestamp: value.sourceTimestamp,
      retrievedAt: value.retrievedAt,
      freshUntil: value.freshUntil,
      revision,
    })),
    "retrievedAt",
  );
  const verificationById = new Map(
    records.list("verificationResult").map(({ revision, value }) => [
      value.verificationId,
      {
        verificationId: value.verificationId,
        incidentId: value.incidentId,
        taskId: value.taskId,
        verdict: value.verdict,
        checkedAt: value.checkedAt,
        evidenceIds: value.evidenceIds.map(reference).filter(Boolean).slice(0, 20),
        revision,
      },
    ]),
  );
  const operationTaskById = new Map(
    records.list("task").map(({ revision, value }) => [
      value.taskId,
      {
        taskId: value.taskId,
        incidentId: value.incidentId,
        parentTaskId: value.parentTaskId,
        role: reference(value.role),
        status: value.status,
        retryCount: value.retryCount,
        seatId: value.assignment?.seatId,
        revision,
      },
    ]),
  );
  const orchestration = runtime.operations?.orchestration ?? runtime.orchestration;
  for (const plan of orchestration?.all?.() ?? []) {
    const verdict = plan.verification;
    if (verdict?.verificationId && !verificationById.has(verdict.verificationId))
      verificationById.set(verdict.verificationId, {
        verificationId: verdict.verificationId,
        incidentId: verdict.incidentId,
        taskId: verdict.taskId,
        verdict: verdict.verdict,
        checkedAt: verdict.checkedAt,
        evidenceIds: verdict.evidenceIds.map(reference).filter(Boolean).slice(0, 20),
        revision: plan.revision,
      });
    for (const child of plan.children ?? []) {
      const task = child.operation;
      if (!task?.taskId) continue;
      operationTaskById.set(task.taskId, {
        taskId: task.taskId,
        incidentId: plan.incident?.incidentId,
        parentTaskId: task.parentTaskId,
        role: reference(task.role),
        status: child.phase ?? task.status,
        retryCount: Math.max(0, child.attempts?.length - 1 || 0),
        seatId: task.assignment?.seatId,
        revision: plan.revision,
      });
    }
  }
  const verification = recent([...verificationById.values()], "checkedAt");
  const operationTasks = [...operationTaskById.values()].slice(-100);
  const events = runtime.db
    .replay(Math.max(0, cursor - 100))
    .slice(-80)
    .reverse()
    .map(({ seq, kind, data }) => ({
      seq,
      kind,
      id: reference(data?.id ?? data?.taskId ?? data?.seatId ?? data?.runId),
      taskId: reference(data?.taskId),
      incidentId: reference(data?.incidentId),
      status: state(data?.status ?? data?.verdict ?? data?.connection),
      revision: Number.isSafeInteger(data?.revision) ? data.revision : undefined,
    }));
  const plans =
    typeof orchestration?.list === "function"
      ? orchestration
          .list()
          .slice(-50)
          .map((plan) => ({
            planId: plan.incidentId,
            status: plan.status,
            steps: plan.childCount ?? 0,
          }))
      : [];
  const registry = runtime.operations?.registry;
  const dispatches = registry?.journal?.list("dispatch") ?? [];
  const specialists = dispatches
    .slice(-50)
    .reverse()
    .map((row) => {
      const manifest = registry.entry(row.manifestId)?.manifest;
      return {
        id: row.id,
        manifestId: reference(row.manifestId),
        role: reference(row.manifestId),
        requestedBy: row.requester?.kind === "agent" ? "agent" : "user",
        reason: state(row.selectionReason) ?? "reviewed_assignment",
        taskId: reference(row.taskId),
        seatId: reference(row.assignment?.seatId),
        tools: (manifest?.tools ?? []).filter(reference).slice(0, 12),
        skills: (row.skills ?? [])
          .map((skill) => reference(skill.id))
          .filter(Boolean)
          .slice(0, 8),
        templateVersion: row.templateVersion,
        templateSource: row.templateSource ?? manifest?.source,
        executionStatus: state(row.status) ?? "unknown",
        lifecycle:
          row.status === "completed"
            ? "idle_for_reuse"
            : ["failed", "stopped", "interrupted", "outcome_unknown"].includes(row.status)
              ? "needs_review"
              : "assigned",
      };
    });
  const provisions = (registry?.journal?.list("provision") ?? [])
    .slice(-50)
    .reverse()
    .map((row) => ({
      id: row.id,
      manifestId: reference(row.manifestId),
      role: reference(row.manifestId),
      requestedBy: row.requester?.kind === "agent" ? "agent" : "user",
      reason: "provision_required",
      taskId: null,
      seatId: reference(row.seatId),
      tools: (registry.entry(row.manifestId)?.manifest.tools ?? []).filter(reference).slice(0, 12),
      skills: [],
      templateVersion: row.templateVersion,
      templateSource: row.templateSource,
      executionStatus: state(row.status) ?? "unknown",
      lifecycle: row.status === "bound" ? "idle_for_reuse" : "needs_review",
    }));
  return {
    cursor,
    generatedAt: new Date().toISOString(),
    evidence,
    verification,
    operationTasks,
    events,
    plans,
    specialists: [...specialists, ...provisions].slice(0, 80),
  };
}
