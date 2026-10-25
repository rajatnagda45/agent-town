import { assertOperationContract } from "../operations-contracts.mjs";

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const bounded = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

function parseJsonObject(text) {
  if (!bounded(text, 32000)) throw fail("Nightshift response is empty or too large.");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail("Nightshift response must be one JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail("Nightshift response must be one JSON object.");
  return value;
}

/** A model proposal is data. The existing orchestrator and registry still authorize dispatch. */
export function parsePlannerResponse(
  text,
  { allowedRoles = ["data-steward-researcher", "critic"] } = {},
) {
  if (
    !Array.isArray(allowedRoles) ||
    allowedRoles.some((role) => !["data-steward-researcher", "critic"].includes(role))
  )
    throw fail("Planner role allowlist is invalid.");
  const value = parseJsonObject(text);
  if (
    !exact(value, ["tasks", "reason"]) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length < 1 ||
    value.tasks.length > 12 ||
    !bounded(value.reason, 1000)
  )
    throw fail("Invalid Planner response shape.");
  const taskIds = new Set();
  const tasks = value.tasks.map((task) => {
    if (
      !exact(task, ["taskId", "role", "message", "dependencies", "requiredEvidenceFrom"]) ||
      !id(task.taskId) ||
      !allowedRoles.includes(task.role) ||
      !bounded(task.message, 8000) ||
      !Array.isArray(task.dependencies) ||
      !Array.isArray(task.requiredEvidenceFrom) ||
      task.dependencies.some((dependency) => !id(dependency)) ||
      task.requiredEvidenceFrom.some((dependency) => !id(dependency)) ||
      new Set(task.dependencies).size !== task.dependencies.length ||
      new Set(task.requiredEvidenceFrom).size !== task.requiredEvidenceFrom.length ||
      task.requiredEvidenceFrom.some((dependency) => !task.dependencies.includes(dependency)) ||
      taskIds.has(task.taskId)
    )
      throw fail("Invalid Planner task or duplicate ID.");
    taskIds.add(task.taskId);
    return {
      taskId: task.taskId,
      role: task.role,
      message: task.message.trim(),
      dependencies: task.dependencies,
      requiredEvidenceFrom: task.requiredEvidenceFrom,
    };
  });
  if (
    tasks.some((task) =>
      task.dependencies.some(
        (dependency) => dependency === task.taskId || !taskIds.has(dependency),
      ),
    )
  )
    throw fail("Planner dependencies must name other proposed tasks.");
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (task) => {
    if (visiting.has(task.taskId)) throw fail("Planner dependencies contain a cycle.");
    if (visited.has(task.taskId)) return;
    visiting.add(task.taskId);
    for (const dependency of task.dependencies) visit(byId.get(dependency));
    visiting.delete(task.taskId);
    visited.add(task.taskId);
  };
  tasks.forEach(visit);
  return { tasks, reason: value.reason.trim() };
}

/** The Critic cannot invent source evidence IDs or select its own verifier identity. */
export function parseCriticResponse(text, { allowedEvidenceIds }) {
  const value = parseJsonObject(text);
  if (
    !exact(value, ["verdict", "evidenceIds", "reason"]) ||
    !["pass", "revise", "unresolved"].includes(value.verdict) ||
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length > 10 ||
    value.evidenceIds.some((evidenceId) => !id(evidenceId)) ||
    new Set(value.evidenceIds).size !== value.evidenceIds.length ||
    !Array.isArray(allowedEvidenceIds) ||
    value.evidenceIds.some((evidenceId) => !allowedEvidenceIds.includes(evidenceId)) ||
    !bounded(value.reason, 5000) ||
    (value.verdict === "pass" && value.evidenceIds.length === 0)
  )
    throw fail("Invalid Critic response or unrecognized evidence.");
  return { verdict: value.verdict, evidenceIds: value.evidenceIds, reason: value.reason.trim() };
}

/** Server-generated identity and time; TrustedVerificationService remains the final gate. */
export function verificationFromCritique({
  critique,
  verificationId,
  incidentId,
  taskId,
  checkedAt,
}) {
  if (!id(verificationId) || !id(incidentId) || !id(taskId))
    throw fail("Server verification identity is required.");
  return assertOperationContract("verificationResult", {
    verificationId,
    incidentId,
    taskId,
    checkedAt,
    verdict: critique.verdict,
    evidenceIds: critique.evidenceIds,
    reason: critique.reason,
  });
}

/** Inventory and other domains can validate their own JSON after this provider proof. */
export function readCorrelatedNightshiftResult({
  runtime,
  records,
  taskId,
  role,
  contextRole = role,
}) {
  const task = runtime.db.getTask(taskId);
  const operation = records.get("task", taskId)?.value;
  const audit = runtime.gateway.runAudit?.(taskId);
  const seat = task && runtime.db.getSeat(task.seatId);
  let context;
  try {
    context =
      task &&
      runtime.gateway.verifiedReasoningContext?.(task.sessionKey, {
        agentId: task.agentId,
        seatId: task.seatId,
        bindingRevision: task.bindingRevision,
      });
  } catch {
    /* Stale contexts fail the checks below. */
  }
  if (
    runtime.gateway.provider !== "nightshift" ||
    !task ||
    task.status !== "completed" ||
    !operation ||
    operation.role !== role ||
    operation.taskId !== taskId ||
    operation.assignment?.runtimeTaskId !== taskId ||
    operation.assignment?.seatId !== task.seatId ||
    operation.assignment?.agentId !== task.agentId ||
    operation.assignment?.gatewayId !== task.gatewayId ||
    operation.assignment?.sessionKey !== task.sessionKey ||
    operation.assignment?.bindingRevision !== task.bindingRevision ||
    context?.role !== contextRole ||
    context.seatId !== task.seatId ||
    context.sessionKey !== task.sessionKey ||
    seat?.binding?.agentId !== task.agentId ||
    seat.binding.revision !== task.bindingRevision ||
    audit?.outcome !== "completed" ||
    audit.runId !== task.runId ||
    audit.model !== runtime.gateway.model
  )
    throw fail("A completed, correlated Nightshift role task with a current binding is required.");
  return { audit, text: task.result };
}

/** Strict generic response shapes; a domain may use readCorrelatedNightshiftResult instead. */
export function readNightshiftReasoningTask({
  runtime,
  records,
  taskId,
  role,
  allowedEvidenceIds,
}) {
  const { audit, text } = readCorrelatedNightshiftResult({ runtime, records, taskId, role });
  if (role === "planner") return { audit, proposal: parsePlannerResponse(text) };
  if (role === "critic")
    return { audit, proposal: parseCriticResponse(text, { allowedEvidenceIds }) };
  throw fail("Unsupported Nightshift reasoning role.");
}
