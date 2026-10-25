import { createHash, randomUUID } from "node:crypto";
import {
  InventoryReasoningLoop,
  chooseFamily,
  roles as familyRoles,
  withRequirements,
} from "./inventory-reasoning-loop.mjs";
import { INVENTORY_READS } from "./inventory-investigation.mjs";
import { InventoryReasoningState } from "./inventory-reasoning-state.mjs";

const id = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const fail = (status, message) => Object.assign(new Error(message), { status });
const bounded = (value, max) => typeof value === "string" && !!value.trim() && value.length <= max;

function planFor(runtime, incidentId) {
  if (!id(incidentId)) throw fail(400, "Invalid investigation ID.");
  const plan = runtime.operations?.orchestration?.get(incidentId);
  if (!plan || plan.incident?.taskType !== "inventory-investigation")
    throw fail(404, "Inventory investigation not found.");
  return plan;
}

function criteriaFrom(plan) {
  const encoded = plan.incident.constraints.find((item) =>
    item.startsWith("inventory-reconciliation-v1:"),
  );
  if (!encoded) return null;
  try {
    return JSON.parse(encoded.slice("inventory-reconciliation-v1:".length));
  } catch {
    return null;
  }
}

function reportFrom(plan) {
  if (!plan.verification) return null;
  let reason = {};
  try {
    reason = JSON.parse(plan.verification.reason);
  } catch {
    // A malformed reason remains visible as an unresolved report.
  }
  return {
    verdict: plan.verification.verdict,
    checkedAt: plan.verification.checkedAt,
    verificationId: plan.verification.verificationId,
    evidenceIds: plan.verification.evidenceIds,
    hypothesis: bounded(reason.hypothesis, 2000) ? reason.hypothesis : null,
    reconciliation: reason.reconciliation ?? null,
    issues: Array.isArray(reason.issues) ? reason.issues.filter((item) => bounded(item, 500)) : [],
    missingEvidence: Array.isArray(reason.missingEvidence)
      ? reason.missingEvidence.filter((item) => bounded(item, 500))
      : [],
  };
}

/** Safe, resumable projection. Raw evidence content is available only through evidenceDetail. */
export function investigationView(runtime, incidentId) {
  const plan = planFor(runtime, incidentId);
  const records = runtime.operations.records;
  const evidence = plan.children.flatMap((child) =>
    (child.evidenceIds ?? []).flatMap((evidenceId) => {
      const item = records.get("evidenceItem", evidenceId)?.value;
      if (!item || item.incidentId !== incidentId || item.taskId !== child.operation.taskId)
        return [];
      let syntheticLabel = false;
      try {
        syntheticLabel = JSON.parse(item.content).synthetic_label === "SYNTHETIC DATA";
      } catch {
        // Malformed content is rejected at the evidence gate.
      }
      return [
        {
          evidenceId,
          taskId: item.taskId,
          source: item.source,
          sourceTimestamp: item.sourceTimestamp,
          retrievedAt: item.retrievedAt,
          freshUntil: item.freshUntil ?? null,
          syntheticLabel,
        },
      ];
    }),
  );
  const tasks = plan.children.map((child) => {
    const taskId = child.operation.taskId;
    const dispatch = runtime.operations.journal.get("dispatch", `lane-d-${taskId}`);
    return {
      nodeId: child.nodeId,
      taskId,
      role: child.operation.role,
      dependencies: child.dependsOn,
      status: child.phase,
      selectionReason: dispatch?.selectionReason ?? child.dispatchCode ?? null,
      specialist: dispatch?.manifestId ?? child.manifest?.id ?? null,
      retryCount: Math.max(0, (child.attempts?.length ?? 1) - 1),
    };
  });
  const reader = plan.children.find((child) => child.nodeId === "reader");
  const readAudits = runtime.db
    .records("operation.dataRead")
    .filter(
      (audit) => audit.incidentId === incidentId && audit.taskId === reader?.operation.taskId,
    );
  const readsCollected = INVENTORY_READS.every(([, templateId]) =>
    readAudits.some((audit) => audit.templateId === templateId),
  );
  let hypothesis = null;
  let critique = null;
  for (const child of plan.children) {
    if (!["analyst", "critic"].includes(child.nodeId)) continue;
    const task = runtime.db.getTask(child.operation.taskId);
    if (task?.status !== "completed") continue;
    try {
      const output = JSON.parse(task.result);
      if (child.nodeId === "analyst" && bounded(output.hypothesis, 2000))
        hypothesis = output.hypothesis;
      if (child.nodeId === "critic" && typeof output.hypothesisSupported === "boolean")
        critique = {
          hypothesisSupported: output.hypothesisSupported,
          missingEvidence: Array.isArray(output.missingEvidence)
            ? output.missingEvidence.filter((item) => bounded(item, 500)).slice(0, 20)
            : [],
        };
    } catch {
      // Invalid model output remains an execution result, not a trusted conclusion.
    }
  }
  return {
    incidentId,
    goal: plan.incident.goal,
    acceptanceCriteria: plan.incident.acceptanceCriteria,
    criteria: criteriaFrom(plan),
    status: plan.status,
    revisionOf: plan.revisionOf ?? null,
    revisedIncidentId: plan.revisedIncidentId ?? null,
    tasks,
    readsCollected,
    evidenceConfirmed: !!plan.evidenceSet,
    analystValidated: !!plan.confirmedResult,
    evidence,
    synthetic: evidence.some((item) => item.syntheticLabel),
    hypothesis,
    critique,
    report: reportFrom(plan),
    reasoning: new InventoryReasoningState(runtime.operations).view(plan),
  };
}

export function investigationList(runtime) {
  return (runtime.operations?.orchestration?.all?.() ?? [])
    .filter((plan) => plan.incident?.taskType === "inventory-investigation")
    .slice(-20)
    .reverse()
    .map((plan) => ({
      incidentId: plan.incident.incidentId,
      goal: plan.incident.goal,
      status: plan.status,
      verdict: plan.verification?.verdict ?? null,
      createdAt: plan.incident.createdAt,
    }));
}

/** Check the actual reviewed registry and configured reader before creating an incident. */
export function inventoryEligibility(runtime) {
  if (runtime.operations.routed) return routedEligibility(runtime);
  const enforcement = runtime.operations.registry.enforcement;
  const roles = ["nightshift-planner", "nightshift-analyst", "nightshift-critic"].map((role) => {
    const result = runtime.operations.registry.assign({ task: { role } });
    const enforcementApproved =
      result.status === "assigned" &&
      enforcement?.authorizeSync?.({
        manifest: result.manifest,
        assignment: result.assignment,
        task: { role, message: "Read-only inventory eligibility preflight.", retryCount: 0 },
      }) === true;
    return {
      role,
      status: result.status,
      seatId: result.status === "assigned" ? result.assignment.seatId : null,
      enforcementApproved,
      reason: result.status === "assigned" ? null : result.reason,
    };
  });
  const provider = runtime.gateway.provider;
  const connection = runtime.gateway.status;
  const readerConfigured = !!runtime.operations.data;
  return {
    provider,
    connection,
    readerConfigured,
    roles,
    ready:
      provider === "nightshift" &&
      connection === "connected" &&
      readerConfigured &&
      roles.every((role) => role.status === "assigned" && role.enforcementApproved),
  };
}

export function evidenceDetail(runtime, incidentId, evidenceId) {
  const plan = planFor(runtime, incidentId);
  if (!id(evidenceId)) throw fail(400, "Invalid evidence ID.");
  const owner = plan.children.find((child) => child.evidenceIds?.includes(evidenceId));
  const item = runtime.operations.records.get("evidenceItem", evidenceId)?.value;
  if (!owner || !item || item.incidentId !== incidentId || item.taskId !== owner.operation.taskId)
    throw fail(404, "Evidence is not linked to this investigation.");
  const audit = item.auditRef && runtime.db.record("operation.dataRead", item.auditRef);
  if (
    audit?.incidentId !== incidentId ||
    audit.taskId !== item.taskId ||
    !audit.evidenceIds?.includes(evidenceId) ||
    !audit.sourceRefs?.some(
      (ref) => ref.source === item.source && ref.recordId === item.recordId,
    ) ||
    audit.binding?.incidentId !== incidentId ||
    audit.binding?.taskId !== item.taskId ||
    audit.binding?.agentId !== owner.operation.assignment?.agentId ||
    audit.binding?.seatId !== owner.operation.assignment?.seatId ||
    audit.binding?.sessionKey !== owner.operation.assignment?.sessionKey ||
    audit.binding?.gatewayId !== owner.operation.assignment?.gatewayId ||
    audit.binding?.bindingRevision !== owner.operation.assignment?.bindingRevision
  )
    throw fail(409, "Evidence source audit is unavailable.");
  return {
    evidenceId,
    source: item.source,
    recordId: item.recordId,
    sourceTimestamp: item.sourceTimestamp,
    retrievedAt: item.retrievedAt,
    freshUntil: item.freshUntil ?? null,
    content: JSON.parse(item.content),
  };
}

export function startInvestigation(runtime, input) {
  if (
    !input ||
    typeof input !== "object" ||
    !bounded(input.goal, 2000) ||
    !input.criteria ||
    typeof input.criteria !== "object" ||
    Array.isArray(input.criteria)
  )
    throw fail(400, "A goal and measurable success criteria are required.");
  const keys = [
    "scenarioId",
    "sku",
    "locationId",
    "ledgerQuantity",
    "physicalQuantity",
    "maxUnexplainedUnits",
  ];
  if (
    Object.keys(input).some((key) => !["goal", "criteria", "submissionId"].includes(key)) ||
    Object.keys(input.criteria).sort().join() !== [...keys].sort().join() ||
    (input.submissionId !== undefined && !id(input.submissionId))
  )
    throw fail(400, "Invalid investigation submission.");
  const incidentId = input.submissionId
    ? `inventory_${createHash("sha256").update(input.submissionId).digest("hex").slice(0, 32)}`
    : `inventory_${randomUUID().replaceAll("-", "")}`;
  try {
    new InventoryReasoningLoop(runtime.operations).start({
      incidentId,
      goal: input.goal.trim(),
      criteria: input.criteria,
      reasoningVersion: 3,
    });
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, error.message);
  }
  return investigationView(runtime, incidentId);
}

export async function actOnInvestigation(runtime, incidentId, action, input = {}) {
  planFor(runtime, incidentId);
  const loop = new InventoryReasoningLoop(runtime.operations);
  try {
    if (action === "accept-plan") loop.acceptPlanner(incidentId);
    else if (action === "collect-evidence") await loop.collectEvidence(incidentId);
    else if (action === "confirm-evidence") loop.confirmEvidence(incidentId);
    else if (action === "accept-analyst") loop.acceptAnalyst(incidentId);
    else if (action === "finish") loop.finish(incidentId);
    else if (action === "revise" && planFor(runtime, incidentId).revisedIncidentId) {
      const revised = investigationView(runtime, planFor(runtime, incidentId).revisedIncidentId);
      if (input.scenarioId && input.scenarioId !== revised.criteria?.scenarioId)
        throw fail(409, "Revision already uses a different evidence scenario.");
      return revised;
    } else if (action === "revise")
      return investigationView(
        runtime,
        loop.revise(incidentId, `inventory_${randomUUID().replaceAll("-", "")}`, {
          scenarioId: input.scenarioId,
        }).incident.incidentId,
      );
    else throw fail(400, "Unknown investigation action.");
  } catch (error) {
    if (error.status) throw error;
    throw fail(409, error.message);
  }
  return investigationView(runtime, incidentId);
}

/** Routed mode: report the router's per-role decision, including per-task authorization. */
function routedEligibility(runtime) {
  const readerConfigured = !!runtime.operations.data;
  let family = null;
  let blocked = null;
  try {
    ({ family } = chooseFamily(runtime.operations));
  } catch (error) {
    blocked = error.message;
  }
  const names = family ? familyRoles(family) : null;
  const roles = names
    ? withRequirements(
        [names.planner, names.analyst, names.critic].map((role) => ({ role })),
        family,
      ).map(({ role, requirements }) => {
        const result = runtime.operations.routing.selectTask({
          role,
          requirements,
          task: { message: "Read-only inventory eligibility preflight.", retryCount: 0 },
        });
        return {
          role,
          status: result.status,
          seatId: result.status === "assigned" ? result.assignment.seatId : null,
          enforcementApproved: result.executionDecision?.authorization === "verified_for_task",
          reason: result.status === "assigned" ? null : result.reason,
          executionDecision: result.executionDecision ?? null,
        };
      })
    : [];
  return {
    provider: family,
    connection: runtime.gateway.status,
    readerConfigured,
    routed: true,
    roles,
    ...(blocked ? { reason: blocked } : {}),
    ready:
      !!family &&
      readerConfigured &&
      roles.length === 3 &&
      roles.every((role) => role.status === "assigned" && role.enforcementApproved),
  };
}
