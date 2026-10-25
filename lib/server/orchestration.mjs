import { createHash } from "node:crypto";
import { assertOperationContract, assignedOperationTask } from "../operations-contracts.mjs";
import { isPhase3 } from "../reasoning-contracts.mjs";
import { InventoryReasoningState } from "./inventory-reasoning-state.mjs";
import {
  validateDeliverables,
  validateWorkerResult,
  workerRequirements,
  OVERLAP_EXPECTED,
  contentSimilarity,
} from "./deliverable-validation.mjs";
import { fenceUntrusted, isThirdParty } from "./untrusted-content.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const REPEAT_THRESHOLD = 0.8;
// Total characters of teammate handoffs one dispatch may carry (hermes-agent summary budget).
const HANDOFF_BUDGET = 3000;
const PENDING = new Set([
  "waiting",
  "ready",
  "waiting_evidence",
  "waiting_planner_validation",
  "waiting_result_validation",
]);

/** Structured result entry adapted from hermes-agent's delegate result contract (MIT). */
function handoffEntry(result) {
  const value = parsed(result);
  return {
    deliverableId: value?.deliverableId ?? null,
    summary: typeof value?.content === "string" ? value.content : "",
    uncertainty: Array.isArray(value?.uncertainty) ? value.uncertainty.slice(0, 10) : [],
    evidenceIds: Array.isArray(value?.evidenceIds) ? value.evidenceIds.slice(0, 40) : [],
  };
}

/** Head 40% / tail 60% so a long handoff keeps its opening and its conclusion. */
function budgeted(handoff, chars) {
  const limit = Math.max(200, chars - 200);
  if (handoff.summary.length <= limit) return { ...handoff, truncated: false };
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  return {
    ...handoff,
    summary: `${handoff.summary.slice(0, head)} … [${handoff.summary.length - limit} chars omitted] … ${handoff.summary.slice(-tail)}`,
    truncated: true,
  };
}
const parsed = (result) => {
  try {
    const value = JSON.parse(result);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
const text = (value, max) => typeof value === "string" && value.trim() && value.length <= max;
const active = new Set([
  "queued",
  "submitted",
  "returning",
  "running",
  "cancel_requested",
  "outcome_unknown",
  "waiting_approval",
  "waiting_question",
]);
const uncertain = new Set(["outcome_unknown", "stopped", "interrupted"]);
const hashId = (...parts) =>
  createHash("sha256").update(parts.join(":"), "utf8").digest("hex").slice(0, 40);
const runtimeTaskId = (incidentId, taskId, attempt) =>
  `orch_${hashId(incidentId, taskId, attempt)}`;
const handoffId = (incidentId, fromTaskId, toTaskId) =>
  `handoff_${hashId(incidentId, fromTaskId, toTaskId)}`;

function contract(kind, value) {
  try {
    return assertOperationContract(kind, value);
  } catch {
    throw fail(400, `Invalid ${kind} contract.`);
  }
}

/** Deterministic scheduler. The registry chooses a reviewed manifest and verified seat; the
 * evidence repository owns EvidenceItems; TaskRuntime remains the sole execution path. */
export class OrchestrationService {
  constructor(runtime, { registry, evidence } = {}) {
    this.runtime = runtime;
    this.registry = registry;
    this.evidence = evidence;
    this.reconciling = new Set();
    this.scheduled = new Set();
    this.unsubscribe = runtime.db.subscribe((event) => {
      if (event.kind !== "task" || !event.data.orchestrationId) return;
      const incidentId = event.data.orchestrationId;
      if (this.scheduled.has(incidentId)) return;
      this.scheduled.add(incidentId);
      queueMicrotask(() => {
        this.scheduled.delete(incidentId);
        if (!runtime.closed) this.reconcile(incidentId);
      });
    });
  }

  close() {
    this.unsubscribe();
  }

  get(incidentId) {
    if (!id(incidentId)) throw fail(400, "Invalid incident ID.");
    const plan = this.runtime.db.record("orchestration", incidentId);
    if (!plan || plan.gatewayId !== this.runtime.gatewayId)
      throw fail(404, "Orchestration not found.");
    return plan;
  }

  all() {
    return this.runtime.db
      .records("orchestration")
      .filter((plan) => plan.gatewayId === this.runtime.gatewayId);
  }

  list() {
    return this.all()
      .slice(-50)
      .reverse()
      .map((plan) => ({
        incidentId: plan.incident.incidentId,
        goal: plan.incident.goal,
        status: plan.status,
        childCount: plan.children.length,
        createdAt: plan.incident.createdAt,
        updatedAt: plan.updatedAt,
        revision: plan.revision,
      }));
  }

  /** Accept an explicit Planner decomposition using the finalized Phase 0 records. */
  create(input, revisionOf = null) {
    const incident = contract("incident", input?.incident);
    if (
      !Array.isArray(input?.tasks) ||
      input.tasks.length < 1 ||
      input.tasks.length > 12 ||
      !Number.isSafeInteger(input.maxParallelTasks ?? 2) ||
      (input.maxParallelTasks ?? 2) < 1 ||
      (input.maxParallelTasks ?? 2) > 3
    )
      throw fail(400, "Invalid orchestration graph or parallel limit.");
    validateDeliverables(input.tasks);
    const children = input.tasks.map((task) => {
      if (
        !task ||
        !id(task.taskId) ||
        !text(task.message, 8000) ||
        !Array.isArray(task.dependencies ?? []) ||
        !Array.isArray(task.requiredEvidenceFrom ?? []) ||
        !Array.isArray(task.evidenceContextFrom ?? []) ||
        !Array.isArray(task.resultContextFrom ?? []) ||
        !Array.isArray(task.handoffFrom ?? []) ||
        (task.requirements !== undefined &&
          (!task.requirements ||
            typeof task.requirements !== "object" ||
            Array.isArray(task.requirements))) ||
        (task.requiresPlannerOutputFrom !== undefined && !id(task.requiresPlannerOutputFrom)) ||
        !Number.isSafeInteger(task.maxRetries ?? 0) ||
        (task.maxRetries ?? 0) < 0 ||
        (task.maxRetries ?? 0) > 2
      )
        throw fail(400, "Invalid orchestration task or retry limit.");
      const dependencies = [...new Set(task.dependencies ?? [])];
      const requiredEvidenceFrom = [...new Set(task.requiredEvidenceFrom ?? [])];
      const evidenceContextFrom = [...new Set(task.evidenceContextFrom ?? [])];
      const resultContextFrom = [...new Set(task.resultContextFrom ?? [])];
      const handoffFrom = [...new Set(task.handoffFrom ?? [])];
      if (
        dependencies.length > 11 ||
        requiredEvidenceFrom.length > 11 ||
        requiredEvidenceFrom.some((dependency) => !dependencies.includes(dependency)) ||
        evidenceContextFrom.length > 11 ||
        evidenceContextFrom.some((dependency) => !requiredEvidenceFrom.includes(dependency)) ||
        resultContextFrom.length > 11 ||
        resultContextFrom.some((dependency) => !dependencies.includes(dependency)) ||
        handoffFrom.length > 11 ||
        handoffFrom.some((dependency) => !dependencies.includes(dependency)) ||
        (task.requiresPlannerOutputFrom && !dependencies.includes(task.requiresPlannerOutputFrom))
      )
        throw fail(400, "Evidence gates must name prerequisite tasks.");
      const operation = contract("task", {
        taskId: runtimeTaskId(incident.incidentId, task.taskId, 1),
        incidentId: incident.incidentId,
        requester: task.requester ?? { kind: "user" },
        role: task.role,
        dependencies: dependencies.map((dependency) =>
          runtimeTaskId(incident.incidentId, dependency, 1),
        ),
        status: "planned",
        retryCount: 0,
      });
      return {
        nodeId: task.taskId,
        dependsOn: dependencies,
        operation,
        message: task.message.trim(),
        ...(task.deliverable ? { deliverable: structuredClone(task.deliverable) } : {}),
        ...(task.requirements ? { requirements: task.requirements } : {}),
        requiredEvidenceFrom,
        ...(evidenceContextFrom.length ? { evidenceContextFrom } : {}),
        ...(resultContextFrom.length ? { resultContextFrom } : {}),
        ...(handoffFrom.length ? { handoffFrom } : {}),
        ...(task.requiresPlannerOutputFrom
          ? { requiresPlannerOutputFrom: task.requiresPlannerOutputFrom }
          : {}),
        maxRetries: task.maxRetries ?? 0,
        evidenceIds: [],
        attempts: [],
        phase: "waiting",
      };
    });
    const byId = new Map(children.map((child) => [child.nodeId, child]));
    if (byId.size !== children.length) throw fail(400, "Operation task IDs must be unique.");
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = (child) => {
      const taskId = child.nodeId;
      if (visiting.has(taskId)) throw fail(400, "Orchestration dependencies contain a cycle.");
      if (visited.has(taskId)) return;
      visiting.add(taskId);
      for (const dependency of child.dependsOn) {
        const parent = byId.get(dependency);
        if (!parent) throw fail(400, "Orchestration dependency does not exist.");
        visit(parent);
      }
      visiting.delete(taskId);
      visited.add(taskId);
      ordered.push(child);
    };
    children.forEach(visit);
    if (
      children.some((child) =>
        (child.handoffFrom ?? []).some((nodeId) => !byId.get(nodeId)?.deliverable),
      )
    )
      throw fail(400, "Handoffs can only come from tasks with a structured deliverable.");
    if (
      ordered.some(
        (child) =>
          child.requiresPlannerOutputFrom &&
          !["planner", "nightshift-planner"].includes(
            byId.get(child.requiresPlannerOutputFrom)?.operation.role,
          ),
      )
    )
      throw fail(400, "Planner output gate must name a prerequisite Planner task.");
    const request = {
      incident,
      maxParallelTasks: input.maxParallelTasks ?? 2,
      children: ordered.map(
        ({
          nodeId,
          dependsOn,
          operation,
          message,
          deliverable,
          requirements,
          requiredEvidenceFrom,
          evidenceContextFrom,
          resultContextFrom,
          handoffFrom,
          requiresPlannerOutputFrom,
          maxRetries,
        }) => ({
          nodeId,
          dependsOn,
          operation,
          message,
          ...(deliverable ? { deliverable } : {}),
          ...(requirements ? { requirements } : {}),
          requiredEvidenceFrom,
          ...(evidenceContextFrom ? { evidenceContextFrom } : {}),
          ...(resultContextFrom ? { resultContextFrom } : {}),
          ...(handoffFrom ? { handoffFrom } : {}),
          ...(requiresPlannerOutputFrom ? { requiresPlannerOutputFrom } : {}),
          maxRetries,
        }),
      ),
    };
    const inputHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const existing = this.runtime.db.record("orchestration", incident.incidentId);
    if (existing) {
      if (
        existing.gatewayId !== this.runtime.gatewayId ||
        existing.inputHash !== inputHash ||
        (existing.revisionOf ?? null) !== revisionOf
      )
        throw fail(409, "Incident ID was already used for another plan.");
      return this.reconcile(incident.incidentId);
    }
    if (!this.registry?.assign || !this.registry?.dispatchOrchestration)
      throw fail(503, "Registry assignment and enforced dispatch are unavailable.");
    if (ordered.some((child) => child.requiredEvidenceFrom.length) && !this.evidence?.get)
      throw fail(503, "Evidence lookup is unavailable for this plan.");
    if (!this.registry.runtimeFor) this.runtime.require("chat.send");
    for (const child of ordered) {
      if (child.operation.requester.kind === "agent") this.verifyBinding(child.operation.requester);
      const selection = child.requirements
        ? this.registry.selectTask({
            role: child.operation.role,
            requirements: child.requirements,
            task: { taskId: child.operation.taskId, message: child.message, retryCount: 0 },
          })
        : this.registry.assign({ incident, task: child.operation });
      if (!selection?.manifest || !selection?.assignment) {
        child.phase = "blocked";
        child.operation.status = "blocked";
        child.dispatchCode = "no_eligible_agent";
        child.uncertainty = selection.reason;
        continue;
      }
      const manifest = contract("agentManifest", selection?.manifest);
      const executionRuntime = this.registry.runtimeFor?.(selection.assignment) ?? this.runtime;
      const provider =
        executionRuntime.gateway.provider === "nightshift"
          ? "meterless-nightshift"
          : executionRuntime.gateway.provider;
      if (
        manifest.id !== child.operation.role ||
        manifest.provider !== provider ||
        child.maxRetries > manifest.limits.maxRetries
      )
        throw fail(409, "Registry role or retry permission does not match the plan.");
      child.manifest = manifest;
      child.skillIds = selection.skills?.map((skill) => skill.id) ?? [];
      child.target = this.verifyBinding(selection?.assignment);
      if (selection.executionDecision) child.executionDecision = selection.executionDecision;
    }
    const now = new Date().toISOString();
    this.runtime.db.saveRecord("orchestration", incident.incidentId, {
      incident,
      ...(revisionOf ? { revisionOf } : {}),
      inputHash,
      gatewayId: this.runtime.gatewayId,
      maxParallelTasks: request.maxParallelTasks,
      children: ordered,
      handoffs: [],
      statusEvents: [],
      status: ordered.some((child) => child.dispatchCode === "no_eligible_agent")
        ? "unresolved"
        : "planned",
      updatedAt: now,
    });
    return this.reconcile(incident.incidentId);
  }

  /** A worker contribution that repeats a completed sibling without citing new evidence.
   * Synthesis and review deliverables are expected to overlap and are never compared. */
  repetition(plan, child, task) {
    if (OVERLAP_EXPECTED.has(child.deliverable.kind) || child.deliverable.duplicateReason)
      return null;
    const own = parsed(task.result);
    if (typeof own?.content !== "string") return null;
    let best = null;
    for (const sibling of plan.children) {
      if (
        sibling === child ||
        sibling.phase !== "completed" ||
        !sibling.deliverable ||
        OVERLAP_EXPECTED.has(sibling.deliverable.kind)
      )
        continue;
      const other = parsed(sibling.result);
      if (typeof other?.content !== "string") continue;
      const newEvidence = (own.evidenceIds ?? []).some(
        (id) => !(other.evidenceIds ?? []).includes(id),
      );
      const similarity = contentSimilarity(own.content, other.content);
      if (!newEvidence && similarity >= REPEAT_THRESHOLD && similarity > (best?.similarity ?? 0))
        best = {
          similarTo: sibling.deliverable.id,
          similarity: Math.round(similarity * 100) / 100,
        };
    }
    return best;
  }

  /** Queue Team Lead guidance for a task's next dispatch. Guidance that arrives after the
   * task started is recorded as missed, never silently dropped. */
  steer({ incidentId, nodeId, message }) {
    if (typeof message !== "string" || !message.trim() || message.length > 1000)
      throw fail(400, "Guidance must be 1–1000 characters.");
    const plan = this.get(incidentId);
    const child = plan.children.find((item) => item.nodeId === nodeId);
    if (!child) throw fail(404, "Task not found in this plan.");
    const entry = { text: message.trim(), at: new Date().toISOString() };
    const queued = PENDING.has(child.phase) && !child.stopRequested;
    if (queued) child.steers = [...(child.steers ?? []), entry].slice(-10);
    else
      child.missedSteers = [...(child.missedSteers ?? []), { ...entry, phase: child.phase }].slice(
        -10,
      );
    this.runtime.db.saveRecord("orchestration", incidentId, plan, plan.revision);
    this.reconcile(incidentId);
    return { nodeId, status: queued ? "queued" : "missed", phase: child.phase };
  }

  /** Stop a task and its dependents from being dispatched. An attempt already running is
   * never killed; its result is still reconciled. */
  stop({ incidentId, nodeId, reason = "" }) {
    const plan = this.get(incidentId);
    const child = plan.children.find((item) => item.nodeId === nodeId);
    if (!child) throw fail(404, "Task not found in this plan.");
    if (child.phase === "completed") return { nodeId, status: "already_completed" };
    const running = ["queued", "running"].includes(child.phase);
    child.stopRequested = {
      reason: String(reason).trim().slice(0, 300) || "no reason given",
      at: new Date().toISOString(),
    };
    this.runtime.db.saveRecord("orchestration", incidentId, plan, plan.revision);
    this.reconcile(incidentId);
    return { nodeId, status: running ? "stopping_after_current_attempt" : "stopped" };
  }

  /** Team view: who does what, how far along, and what was handed on. */
  team(incidentId) {
    const plan = this.reconcile(incidentId);
    return {
      incidentId,
      goal: plan.incident.goal,
      status: plan.status,
      members: plan.children.map((child) => ({
        nodeId: child.nodeId,
        role: child.operation.role,
        seatId: child.target?.seatId ?? null,
        phase: child.phase,
        attempts: child.attempts.length,
        dependsOn: child.dependsOn,
        deliverable: child.deliverable
          ? { id: child.deliverable.id, kind: child.deliverable.kind }
          : null,
        runtime: child.executionDecision?.runtime ?? null,
        handoffChars: child.handoff?.summary.length ?? 0,
        steers: (child.steers ?? []).length,
        missedSteers: (child.missedSteers ?? []).length,
        stopped: !!child.stopRequested,
        uncertainty: child.uncertainty ?? null,
        waitReason: child.waitReason ?? null,
      })),
    };
  }

  verifyBinding(binding) {
    const runtime = this.registry.runtimeFor?.(binding) ?? this.runtime;
    if (
      !binding ||
      !id(binding.seatId) ||
      !id(binding.agentId) ||
      !id(binding.sessionKey) ||
      binding.gatewayId !== runtime.gatewayId ||
      !Number.isSafeInteger(binding.bindingRevision) ||
      binding.bindingRevision < 1
    )
      throw fail(409, "Agent assignment does not have a verified runtime identity.");
    const resolved = runtime.resolve(binding.seatId, binding.sessionKey);
    if (
      resolved.agentId !== binding.agentId ||
      resolved.seat.binding.revision !== binding.bindingRevision
    )
      throw fail(409, "Agent assignment changed; review the plan before dispatch.");
    return {
      seatId: resolved.seat.seatId,
      agentId: resolved.agentId,
      bindingRevision: resolved.seat.binding.revision,
      gatewayId: runtime.gatewayId,
      sessionKey: resolved.sessionKey,
    };
  }

  /** Lane B stores the EvidenceItem first; this method records only its checked reference. */
  attachEvidence({ incidentId, taskId, evidenceIds }) {
    if (
      !this.evidence?.get ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.length < 1 ||
      evidenceIds.length > 40 ||
      evidenceIds.some((evidenceId) => !id(evidenceId))
    )
      throw fail(400, "Invalid evidence references or evidence lookup unavailable.");
    const current = this.get(incidentId);
    const child = current.children.find((item) =>
      item.attempts.some((attempt) => attempt.runtimeTaskId === taskId),
    );
    if (!child) throw fail(404, "Operation task not found.");
    const checked = evidenceIds.map((evidenceId) => {
      const item = this.evidence.get(evidenceId);
      const evidence = contract("evidenceItem", item);
      if (
        evidence.evidenceId !== evidenceId ||
        evidence.incidentId !== incidentId ||
        evidence.taskId !== taskId
      )
        throw fail(409, "Evidence does not belong to this incident task.");
      return evidenceId;
    });
    const plan = structuredClone(current);
    const target = plan.children.find((item) => item.nodeId === child.nodeId);
    target.evidenceIds = [...new Set([...target.evidenceIds, ...checked])].slice(-100);
    if (target.evidenceIds.length === child.evidenceIds.length) return current;
    plan.updatedAt = new Date().toISOString();
    this.runtime.db.saveRecord("orchestration", incidentId, plan, current.revision);
    return this.reconcile(incidentId);
  }

  /** Release gated work only after server code validates the durable Planner result. */
  confirmPlannerOutput({ incidentId, nodeId, outputHash }) {
    const current = this.get(incidentId);
    const planner = current.children.find((child) => child.nodeId === nodeId);
    const taskId = planner?.attempts.at(-1)?.runtimeTaskId;
    const task = taskId && this.runtime.db.getTask(taskId);
    if (
      !planner ||
      !["planner", "nightshift-planner"].includes(planner.operation.role) ||
      !current.children.some((child) => child.requiresPlannerOutputFrom === nodeId) ||
      task?.status !== "completed" ||
      typeof task.result !== "string" ||
      createHash("sha256").update(task.result).digest("hex") !== outputHash
    )
      throw fail(409, "A completed, schema-validated Planner result is required.");
    if (
      current.plannerOutput?.nodeId === nodeId &&
      current.plannerOutput?.outputHash === outputHash
    )
      return current;
    if (current.plannerOutput) throw fail(409, "Planner result changed after validation.");
    const plan = structuredClone(current);
    plan.plannerOutput = { nodeId, taskId, outputHash, validatedAt: new Date().toISOString() };
    plan.updatedAt = new Date().toISOString();
    this.runtime.db.saveRecord("orchestration", incidentId, plan, current.revision);
    return this.reconcile(incidentId);
  }

  /** Freeze one completed producer's current references before evidence-dependent dispatch. */
  confirmEvidenceSet({ incidentId, nodeId, evidenceIds, reconciliation, reasoningContext }) {
    const current = this.get(incidentId);
    const producer = current.children.find((child) => child.nodeId === nodeId);
    const taskId = producer?.attempts.at(-1)?.runtimeTaskId;
    if (
      !producer ||
      this.runtime.db.getTask(taskId)?.status !== "completed" ||
      !current.children.some((child) => child.evidenceContextFrom?.includes(nodeId)) ||
      !Array.isArray(evidenceIds) ||
      !evidenceIds.length ||
      evidenceIds.length > 40 ||
      evidenceIds.some((value) => !id(value)) ||
      JSON.stringify(evidenceIds) !== JSON.stringify(producer.evidenceIds)
    )
      throw fail(409, "A completed producer and its exact evidence IDs are required.");
    for (const evidenceId of evidenceIds) {
      const item = contract("evidenceItem", this.evidence?.get(evidenceId));
      if (
        item.incidentId !== incidentId ||
        item.taskId !== taskId ||
        !item.freshUntil ||
        Date.parse(item.freshUntil) <= Date.now()
      )
        throw fail(409, "The evidence set is outside scope or stale.");
    }
    if (current.evidenceSet) {
      if (
        current.evidenceSet.nodeId === nodeId &&
        current.evidenceSet.taskId === taskId &&
        JSON.stringify(current.evidenceSet.evidenceIds) === JSON.stringify(evidenceIds)
      )
        return current;
      throw fail(409, "The confirmed evidence set changed; create a revision.");
    }
    const plan = structuredClone(current);
    plan.evidenceSet = {
      nodeId,
      taskId,
      evidenceIds: [...evidenceIds],
      confirmedAt: new Date().toISOString(),
      ...(reconciliation ? { reconciliation: structuredClone(reconciliation) } : {}),
      ...(reasoningContext ? { reasoningContext: structuredClone(reasoningContext) } : {}),
    };
    plan.updatedAt = new Date().toISOString();
    this.runtime.db.saveRecord("orchestration", incidentId, plan, current.revision);
    return this.reconcile(incidentId);
  }

  /** Server-validated reasoning can be supplied to a dependent Critic by exact result hash. */
  confirmResultContext({ incidentId, nodeId, outputHash }) {
    const current = this.get(incidentId);
    const source = current.children.find((child) => child.nodeId === nodeId);
    const taskId = source?.attempts.at(-1)?.runtimeTaskId;
    const task = taskId && this.runtime.db.getTask(taskId);
    if (
      !source ||
      !current.children.some((child) => child.resultContextFrom?.includes(nodeId)) ||
      task?.status !== "completed" ||
      typeof task.result !== "string" ||
      createHash("sha256").update(task.result).digest("hex") !== outputHash
    )
      throw fail(409, "A completed, server-validated reasoning result is required.");
    if (
      current.confirmedResult?.nodeId === nodeId &&
      current.confirmedResult?.taskId === taskId &&
      current.confirmedResult?.outputHash === outputHash
    )
      return current;
    if (current.confirmedResult) throw fail(409, "Confirmed reasoning changed; create a revision.");
    const plan = structuredClone(current);
    plan.confirmedResult = { nodeId, taskId, outputHash, confirmedAt: new Date().toISOString() };
    plan.updatedAt = new Date().toISOString();
    this.runtime.db.saveRecord("orchestration", incidentId, plan, current.revision);
    return this.reconcile(incidentId);
  }

  /** Persist the Critic's Phase 0 verdict without turning execution into verified success. */
  recordVerification(input, { dryRun = false } = {}) {
    const result = contract("verificationResult", input);
    const current = this.get(result.incidentId);
    if (current.status !== "awaiting_verification")
      throw fail(409, "All workers must finish before verification is recorded.");
    const child = current.children.find((item) =>
      item.attempts.some((attempt) => attempt.runtimeTaskId === result.taskId),
    );
    const latest = child?.attempts.at(-1);
    const task = this.runtime.db.getTask(result.taskId);
    if (
      !child ||
      latest?.runtimeTaskId !== result.taskId ||
      child.operation.taskId !== result.taskId ||
      child.phase !== "completed" ||
      task?.status !== "completed" ||
      task.gatewayId !== this.runtime.gatewayId ||
      task.orchestrationId !== result.incidentId ||
      task.orchestrationNodeId !== child.nodeId ||
      task.agentId !== child.operation.assignment?.agentId ||
      task.sessionKey !== child.operation.assignment?.sessionKey ||
      task.bindingRevision !== child.operation.assignment?.bindingRevision
    )
      throw fail(409, "Verification must target the current completed runtime attempt.");
    if (result.verdict === "revise" && result.evidenceIds.length === 0)
      throw fail(409, "A revision verdict needs recorded evidence.");
    if (!this.evidence?.get && result.evidenceIds.length)
      throw fail(503, "Evidence lookup is unavailable for verification.");
    for (const evidenceId of result.evidenceIds) {
      const evidence = contract("evidenceItem", this.evidence.get(evidenceId));
      const owner = current.children.find((item) => item.evidenceIds.includes(evidenceId));
      if (
        !owner ||
        evidence.evidenceId !== evidenceId ||
        evidence.incidentId !== result.incidentId ||
        !owner.attempts.some((attempt) => attempt.runtimeTaskId === evidence.taskId)
      )
        throw fail(409, "Verification evidence is outside this task's recorded scope.");
    }
    if (current.verification) {
      if (JSON.stringify(current.verification) === JSON.stringify(result)) return current;
      throw fail(409, "This plan already has a different verification verdict.");
    }
    if (dryRun) return current;
    const plan = structuredClone(current);
    plan.verification = result;
    plan.updatedAt = new Date().toISOString();
    return this.runtime.db.saveRecord("orchestration", result.incidentId, plan, current.revision);
  }

  /** One bounded revision; original attempts and verdict remain in their original plan. */
  revise({ originalIncidentId, revisionIncident, reason, evidenceIds, tasks, maxParallelTasks }) {
    const original = this.get(originalIncidentId);
    if (original.revisionOf || original.verification?.verdict !== "revise")
      throw fail(409, "A failed first-pass Critic verdict is required for revision.");
    if (
      original.verification.reason !== reason ||
      JSON.stringify(original.verification.evidenceIds) !== JSON.stringify(evidenceIds)
    )
      throw fail(409, "Revision reason and evidence must match the recorded Critic verdict.");
    const incident = contract("incident", revisionIncident);
    if (incident.incidentId === originalIncidentId)
      throw fail(409, "A revision needs a distinct incident ID.");
    const prior = this.all().find((plan) => plan.revisionOf === originalIncidentId);
    if (
      (original.revisedIncidentId && original.revisedIncidentId !== incident.incidentId) ||
      (prior && prior.incident.incidentId !== incident.incidentId)
    )
      throw fail(409, "Only one revised plan is allowed for an incident.");
    const revised = this.create({ incident, tasks, maxParallelTasks }, originalIncidentId);
    if (!original.revisedIncidentId) {
      const current = this.get(originalIncidentId);
      const linked = structuredClone(current);
      linked.revisedIncidentId = incident.incidentId;
      linked.updatedAt = new Date().toISOString();
      this.runtime.db.saveRecord("orchestration", originalIncidentId, linked, current.revision);
    }
    return revised;
  }

  evidenceReady(incidentId, child) {
    if (!child.evidenceIds.length) return false;
    for (const evidenceId of child.evidenceIds) {
      const evidence = contract("evidenceItem", this.evidence?.get(evidenceId));
      if (
        evidence.evidenceId !== evidenceId ||
        evidence.incidentId !== incidentId ||
        !child.attempts.some((attempt) => attempt.runtimeTaskId === evidence.taskId)
      )
        throw fail(409, "Recorded evidence reference changed or disappeared.");
      if (evidence.freshUntil && Date.parse(evidence.freshUntil) > Date.now()) return true;
    }
    return false;
  }

  reconcileAll() {
    for (const plan of this.all())
      if (plan.status !== "awaiting_verification") this.reconcile(plan.incident.incidentId);
  }

  reconcile(incidentId) {
    if (this.reconciling.has(incidentId)) return this.get(incidentId);
    this.reconciling.add(incidentId);
    try {
      const current = this.get(incidentId);
      if (current.status === "awaiting_verification") return current;
      const plan = structuredClone(current);
      const byId = new Map(plan.children.map((child) => [child.nodeId, child]));
      let occupied = 0;
      const occupiedByAgent = new Map();
      for (const child of plan.children) {
        const last = child.attempts.at(-1);
        const task = last && this.runtime.db.getTask(last.runtimeTaskId);
        if (!task) continue;
        last.status = task.status;
        if (task.completedAt) last.completedAt = task.completedAt;
        if (typeof task.result === "string") last.result = task.result;
        if (typeof task.error === "string") last.error = task.error;
        child.operation = assignedOperationTask({
          incidentId,
          requester: child.operation.requester,
          role: child.operation.role,
          dependencies: child.operation.dependencies,
          retryCount: child.attempts.length - 1,
          task,
        });
        if (active.has(task.status)) {
          occupied++;
          occupiedByAgent.set(task.agentId, (occupiedByAgent.get(task.agentId) ?? 0) + 1);
        }
      }
      let dispatchHalted =
        // Emergency stop: no new dispatch; attempts in flight are still reconciled.
        !!this.runtime.estop?.engaged() ||
        current.status === "failed" ||
        plan.children.some((child) => {
          const last = child.attempts.at(-1);
          const status = last && this.runtime.db.getTask(last.runtimeTaskId)?.status;
          return uncertain.has(status);
        });
      for (const child of plan.children) {
        if (child.dispatchCode === "no_eligible_agent") {
          dispatchHalted = true;
          continue;
        }
        const last = child.attempts.at(-1);
        const task = last && this.runtime.db.getTask(last.runtimeTaskId);
        child.operation.dependencies = child.dependsOn.map(
          (dependency) => byId.get(dependency).operation.taskId,
        );
        let redispatch = false;
        if (task?.status === "completed") {
          if (child.deliverable) {
            const evidence = [
              ...new Set([...(child.dispatchedEvidenceIds ?? []), ...child.evidenceIds]),
            ]
              .map((id) => this.evidence?.get(id))
              .filter(
                (item) =>
                  item &&
                  (item.taskId === task.taskId ||
                    child.dispatchedEvidenceIds?.includes(item.evidenceId)),
              );
            child.deliverableCheck = validateWorkerResult({
              incident: plan.incident,
              deliverable: child.deliverable,
              result: task.result,
              evidence,
            });
            if (!child.deliverableCheck.pass) {
              // One bounded schema repair with the exact issues, as in hermes-agent's single
              // error-only output-schema retry; then the failure stands.
              if (
                !child.schemaRepair?.attempt &&
                !child.stopRequested &&
                child.attempts.length <= child.manifest.limits.maxRetries
              ) {
                child.schemaRepair ??= {
                  requestedAt: new Date().toISOString(),
                  issues: child.deliverableCheck.issues,
                };
                redispatch = true;
              } else {
                child.phase = "unresolved";
                child.uncertainty = child.deliverableCheck.issues.join(" ");
                dispatchHalted = true;
                continue;
              }
            }
            const repeat = redispatch ? null : this.repetition(plan, child, task);
            if (repeat) {
              child.reviewSignals = { repeats: repeat, escalated: false };
              // One bounded revision when the reviewed template still permits a retry;
              // otherwise the signal goes to the Critic and Lead instead of rejecting.
              if (child.distinctRevision?.attempt) child.reviewSignals.escalated = true;
              else if (child.distinctRevision) redispatch = true;
              else if (child.attempts.length <= child.manifest.limits.maxRetries) {
                child.distinctRevision = { requestedAt: new Date().toISOString(), ...repeat };
                redispatch = true;
              } else child.reviewSignals.escalated = true;
            } else if (child.reviewSignals?.repeats) delete child.reviewSignals;
          }
          if (redispatch && child.stopRequested) redispatch = false;
          if (!redispatch) {
            child.phase = "completed";
            child.result = task.result ?? null;
            if (child.deliverable && child.deliverableCheck?.pass)
              child.handoff = handoffEntry(task.result);
            delete child.uncertainty;
            continue;
          }
        }
        if (!redispatch && uncertain.has(task?.status)) {
          child.phase = "unresolved";
          child.uncertainty =
            task.status === "outcome_unknown"
              ? "The runtime cannot confirm whether this attempt executed; no automatic retry."
              : "The attempt stopped before a confirmed outcome.";
          dispatchHalted = true;
          continue;
        }
        if (
          !redispatch &&
          task?.status === "failed" &&
          (task.error !== "Gateway rejected task submission." ||
            child.attempts.length > child.maxRetries)
        ) {
          child.phase = "failed";
          dispatchHalted = true;
          continue;
        }
        if (!redispatch && task && task.status !== "failed") {
          child.phase = task.status === "queued" ? "queued" : "running";
          delete child.uncertainty;
          continue;
        }
        // A stop blocks further dispatch only; an attempt already running was handled above.
        if (child.stopRequested) {
          child.phase = "stopped";
          child.operation.status = "blocked";
          child.uncertainty = `Stopped by the Team Lead: ${child.stopRequested.reason}`;
          continue;
        }
        const parents = child.dependsOn.map((dependency) => byId.get(dependency));
        if (parents.some((parent) => ["failed", "blocked", "stopped"].includes(parent.phase))) {
          child.phase = "blocked";
          child.operation.status = "blocked";
          dispatchHalted = true;
          continue;
        }
        if (parents.some((parent) => parent.phase === "unresolved")) {
          child.phase = "unresolved";
          child.uncertainty = "A prerequisite task outcome is unresolved.";
          dispatchHalted = true;
          continue;
        }
        if (parents.some((parent) => parent.phase !== "completed")) {
          child.phase = "waiting";
          delete child.uncertainty;
          continue;
        }
        if (child.requiresPlannerOutputFrom) {
          const source = byId.get(child.requiresPlannerOutputFrom);
          const result = this.runtime.db.getTask(source.operation.taskId)?.result;
          if (
            plan.plannerOutput?.nodeId !== source.nodeId ||
            plan.plannerOutput?.taskId !== source.operation.taskId ||
            typeof result !== "string" ||
            createHash("sha256").update(result).digest("hex") !== plan.plannerOutput.outputHash
          ) {
            child.phase = "waiting_planner_validation";
            child.operation.status = "blocked";
            delete child.uncertainty;
            continue;
          }
        }
        try {
          if (
            child.requiredEvidenceFrom.some(
              (dependency) => !this.evidenceReady(incidentId, byId.get(dependency)),
            )
          ) {
            child.phase = "waiting_evidence";
            child.operation.status = "blocked";
            delete child.uncertainty;
            continue;
          }
        } catch {
          child.phase = "unresolved";
          child.uncertainty = "A recorded evidence reference is unavailable or invalid.";
          dispatchHalted = true;
          continue;
        }
        let dispatchMessage = child.message;
        if (child.deliverable)
          dispatchMessage += `\nCanonical assignment (return the structured result, not another worker's plan): ${workerRequirements(plan.incident, child)}`;
        if (redispatch && child.schemaRepair && !child.schemaRepair.attempt)
          dispatchMessage += `\nRepair request: your previous result failed these server checks; fix every one and return only the JSON object: ${JSON.stringify(child.schemaRepair.issues)}`;
        else if (redispatch)
          dispatchMessage += `\nRevision request: your previous result repeated deliverable ${child.distinctRevision.similarTo} (similarity ${child.distinctRevision.similarity}) without new evidence. Contribute findings that deliverable does not already contain, or state that you have nothing distinct to add.`;
        const reviewInputs = OVERLAP_EXPECTED.has(child.deliverable?.kind)
          ? child.dependsOn
              .map((nodeId) => byId.get(nodeId))
              .filter((parent) => parent.reviewSignals)
              .map((parent) => ({ deliverableId: parent.deliverable?.id, ...parent.reviewSignals }))
          : [];
        if (reviewInputs.length)
          dispatchMessage += `\nReview signals on prerequisite contributions (hints, not proof): ${JSON.stringify(reviewInputs)}`;
        if (dispatchMessage.length > 8000) {
          child.phase = "unresolved";
          child.uncertainty = "Canonical assignment exceeds the specialist input limit.";
          dispatchHalted = true;
          continue;
        }
        let dispatchedEvidenceIds = [];
        if (child.evidenceContextFrom?.length) {
          const sources = child.evidenceContextFrom.map((nodeId) => byId.get(nodeId));
          const source = sources[0];
          if (
            sources.length !== 1 ||
            plan.evidenceSet?.nodeId !== source.nodeId ||
            plan.evidenceSet?.taskId !== source.operation.taskId ||
            JSON.stringify(plan.evidenceSet?.evidenceIds) !== JSON.stringify(source.evidenceIds)
          ) {
            child.phase = "waiting_evidence";
            child.operation.status = "blocked";
            continue;
          }
          try {
            if (isPhase3(plan))
              new InventoryReasoningState(this.runtime.operations).validateBundle(plan);
            const context = source.evidenceIds.map((evidenceId) => {
              const item = contract("evidenceItem", this.evidence.get(evidenceId));
              if (
                item.incidentId !== incidentId ||
                item.taskId !== source.operation.taskId ||
                !item.freshUntil ||
                Date.parse(item.freshUntil) <= Date.now()
              )
                throw fail(409, "Evidence context is stale or outside scope.");
              return {
                evidenceId,
                source: item.source,
                recordId: item.recordId,
                sourceTimestamp: item.sourceTimestamp,
                content: isThirdParty(item.source)
                  ? fenceUntrusted(item.source, item.content)
                  : item.content,
              };
            });
            dispatchMessage += `\nCurrent authorized evidence (cite only these IDs): ${JSON.stringify(context)}`;
            if (plan.evidenceSet?.reasoningContext) {
              const bundle = plan.evidenceSet.reasoningContext;
              const context = {
                bundleId: bundle.bundleId,
                schemaVersion: bundle.schemaVersion,
                scope: bundle.scope,
                temporalScope: bundle.temporalScope,
                checks: bundle.checks,
                reviewedReadTemplates: bundle.audits.map((audit) => audit.templateId),
                businessRules: bundle.businessRules,
                memory: bundle.memory,
                attempt: plan.revisionOf ? 2 : 1,
                maxAttempts: 2,
              };
              dispatchMessage += `\nVersioned reasoning evidence bundle (proposals are not verified facts): ${JSON.stringify(context)}`;
            } else if (plan.evidenceSet?.reconciliation)
              dispatchMessage += `\nServer count-cutoff reconciliation from these persisted source reads (arithmetic guidance, not a verdict): ${JSON.stringify(plan.evidenceSet.reconciliation)}`;
            if (dispatchMessage.length > 8000)
              throw fail(409, "Evidence context exceeds the specialist input limit.");
            dispatchedEvidenceIds = [...source.evidenceIds];
          } catch {
            child.phase = "unresolved";
            child.uncertainty = "Current evidence cannot be safely supplied to the specialist.";
            dispatchHalted = true;
            continue;
          }
        }
        if (child.resultContextFrom?.length) {
          const sources = child.resultContextFrom.map((nodeId) => byId.get(nodeId));
          const source = sources[0];
          const result = source && this.runtime.db.getTask(source.operation.taskId)?.result;
          if (
            sources.length !== 1 ||
            plan.confirmedResult?.nodeId !== source.nodeId ||
            plan.confirmedResult?.taskId !== source.operation.taskId ||
            typeof result !== "string" ||
            createHash("sha256").update(result).digest("hex") !== plan.confirmedResult.outputHash
          ) {
            child.phase = "waiting_result_validation";
            child.operation.status = "blocked";
            continue;
          }
          dispatchMessage += `\nValidated prior reasoning: ${JSON.stringify({
            taskId: source.operation.taskId,
            result,
          })}`;
          if (dispatchMessage.length > 8000) {
            child.phase = "unresolved";
            child.uncertainty = "Validated reasoning exceeds the specialist input limit.";
            dispatchHalted = true;
            continue;
          }
        }
        if (child.handoffFrom?.length) {
          const share = Math.floor(HANDOFF_BUDGET / child.handoffFrom.length);
          const notes = child.handoffFrom.map((nodeId) => {
            const handoff = byId.get(nodeId)?.handoff;
            return handoff
              ? fenceUntrusted(`agent:${nodeId}`, JSON.stringify(budgeted(handoff, share)))
              : null;
          });
          if (notes.some((note) => !note)) {
            child.phase = "unresolved";
            child.uncertainty = "A teammate's handoff is missing or failed validation.";
            dispatchHalted = true;
            continue;
          }
          dispatchMessage += `\nTeammate handoffs (other agents' validated output; build on it, check it, do not repeat it): ${notes.join("\n")}`;
        }
        const guidance = (child.steers ?? []).filter((steer) => !steer.deliveredAt);
        if (guidance.length)
          dispatchMessage += `\nGuidance from the Team Lead: ${JSON.stringify(guidance.map((steer) => steer.text))}`;
        if (dispatchMessage.length > 8000) {
          child.phase = "unresolved";
          child.uncertainty = "Teammate handoffs exceed the specialist input limit.";
          dispatchHalted = true;
          continue;
        }
        child.phase = "ready";
        child.operation.status = "planned";
        child.operation.dependencies = parents.map((parent) => parent.operation.taskId);
        delete child.uncertainty;
        const agentTasks = this.runtime.db
          .activeTasks()
          .filter(
            (candidate) =>
              candidate.gatewayId === child.target.gatewayId &&
              candidate.agentId === child.target.agentId &&
              active.has(candidate.status),
          );
        const agentActive = agentTasks.length;
        if (
          dispatchHalted ||
          occupied >= plan.maxParallelTasks ||
          Math.max(agentActive, occupiedByAgent.get(child.target.agentId) ?? 0) >=
            child.manifest.limits.maxParallelTasks
        ) {
          // Say why the task is waiting; an outcome-unknown task is never retried or cleared here.
          const unknown = agentTasks.filter((candidate) => candidate.status === "outcome_unknown");
          child.waitReason = dispatchHalted
            ? "Dispatch is paused for this plan."
            : occupied >= plan.maxParallelTasks
              ? `Waiting for a free slot (${plan.maxParallelTasks} tasks run in parallel).`
              : `Waiting: agent ${child.target.agentId} already has ${Math.max(agentActive, occupiedByAgent.get(child.target.agentId) ?? 0)} active task(s)${unknown.length ? `, including ${unknown.length} with an unknown outcome that needs operator review (${unknown.map((candidate) => candidate.taskId).join(", ")})` : ""}.`;
          continue;
        }
        delete child.waitReason;
        try {
          const selection = child.requirements
            ? this.registry.selectTask({
                role: child.operation.role,
                requirements: child.requirements,
                pinned: child.target,
                task: {
                  taskId: runtimeTaskId(incidentId, child.nodeId, child.attempts.length + 1),
                  message: dispatchMessage,
                  retryCount: child.attempts.length,
                },
              })
            : this.registry.assign({ incident: plan.incident, task: child.operation });
          if (!selection?.manifest || !selection?.assignment) {
            child.phase = "blocked";
            child.operation.status = "blocked";
            child.dispatchCode = "no_eligible_agent";
            child.uncertainty = selection.reason;
            dispatchHalted = true;
            continue;
          }
          const manifest = contract("agentManifest", selection?.manifest);
          const target = this.verifyBinding(selection?.assignment);
          if (
            (child.executionDecision &&
              ["optionId", "runtime", "modelProvider", "model"].some(
                (key) => child.executionDecision[key] !== selection.executionDecision?.[key],
              )) ||
            JSON.stringify(manifest) !== JSON.stringify(child.manifest) ||
            JSON.stringify(target) !== JSON.stringify(child.target) ||
            JSON.stringify(selection.skills?.map((skill) => skill.id) ?? []) !==
              JSON.stringify(child.skillIds ?? [])
          )
            throw fail(409, "Agent assignment or permission changed before dispatch.");
        } catch {
          child.phase = "blocked";
          child.operation.status = "blocked";
          child.dispatchError = "Agent assignment or permission changed. Review this plan.";
          dispatchHalted = true;
          continue;
        }
        const attempt = child.attempts.length + 1;
        const taskId = runtimeTaskId(incidentId, child.nodeId, attempt);
        try {
          const dispatched = this.registry.dispatchOrchestration({
            requestId: taskId,
            selection: { manifest: child.manifest, assignment: child.target },
            task: {
              taskId,
              message: dispatchMessage,
              retryCount: attempt - 1,
              requester: child.operation.requester,
              skillIds: child.skillIds ?? [],
            },
          });
          if (dispatched.status !== "accepted") {
            if (dispatched.status === "outcome_unknown") {
              child.phase = "unresolved";
              child.uncertainty = "Specialist dispatch outcome is unknown; no automatic retry.";
              dispatchHalted = true;
              continue;
            }
            throw fail(409, "Specialist dispatch was rejected.");
          }
          const submitted = this.runtime.db.getTask(taskId);
          if (!submitted)
            throw fail(409, "Accepted specialist task is missing from the durable runtime.");
          // Tag the existing runtime record; TaskRuntime remains the execution authority.
          if (submitted.orchestrationId !== incidentId)
            this.runtime.db.updateTask(taskId, {
              orchestrationId: incidentId,
              orchestrationNodeId: child.nodeId,
              attempt,
            });
          const persisted = this.runtime.db.getTask(taskId);
          child.attempts.push({
            runtimeTaskId: taskId,
            status: persisted.status,
            createdAt: persisted.createdAt,
          });
          if (redispatch && child.schemaRepair && !child.schemaRepair.attempt)
            child.schemaRepair.attempt = attempt;
          else if (redispatch) child.distinctRevision.attempt = attempt;
          if (child.steers?.length)
            child.steers = child.steers.map((steer) =>
              steer.deliveredAt ? steer : { ...steer, deliveredAt: persisted.createdAt, attempt },
            );
          if (dispatchedEvidenceIds.length) child.dispatchedEvidenceIds = dispatchedEvidenceIds;
          child.operation = assignedOperationTask({
            incidentId,
            requester: child.operation.requester,
            role: child.operation.role,
            dependencies: parents.map((parent) => parent.operation.taskId),
            retryCount: attempt - 1,
            task: persisted,
          });
          child.phase = persisted.status === "queued" ? "queued" : "running";
          occupied++;
          occupiedByAgent.set(
            child.target.agentId,
            (occupiedByAgent.get(child.target.agentId) ?? 0) + 1,
          );
          for (const parent of parents) {
            const fromTaskId = parent.operation.taskId;
            const toTaskId = child.operation.taskId;
            const id = handoffId(incidentId, fromTaskId, toTaskId);
            if (!plan.handoffs.some((handoff) => handoff.handoffId === id))
              plan.handoffs.push({
                handoffId: id,
                incidentId,
                fromTaskId,
                toTaskId,
                fromNodeId: parent.nodeId,
                toNodeId: child.nodeId,
                fromAssignment: parent.operation.assignment,
                toAssignment: child.operation.assignment,
                evidenceIds: [...parent.evidenceIds],
                recordedAt: new Date().toISOString(),
              });
          }
        } catch (error) {
          if (error.status === 503) continue;
          child.phase = "blocked";
          child.operation.status = "blocked";
          child.dispatchError =
            error.status === 409
              ? "Agent assignment changed. Review this plan."
              : "The task could not be queued. Review this plan.";
          dispatchHalted = true;
        }
      }
      plan.status = plan.children.every((child) => child.phase === "completed")
        ? "awaiting_verification"
        : plan.children.some((child) => child.dispatchCode === "no_eligible_agent")
          ? "unresolved"
          : plan.children.some((child) => ["failed", "blocked"].includes(child.phase))
            ? "failed"
            : plan.children.some((child) => ["unresolved", "stopped"].includes(child.phase))
              ? "unresolved"
              : plan.children.some((child) => ["queued", "running"].includes(child.phase))
                ? "running"
                : "planned";
      const at = new Date().toISOString();
      for (let i = 0; i < plan.children.length; i++) {
        const before = current.children[i];
        const after = plan.children[i];
        if (
          before.phase !== after.phase ||
          before.operation.status !== after.operation.status ||
          before.attempts.length !== after.attempts.length
        )
          plan.statusEvents.push({
            eventId: `status_${hashId(
              incidentId,
              after.nodeId,
              current.revision,
              plan.statusEvents.length,
            )}`,
            incidentId,
            nodeId: after.nodeId,
            taskId: after.operation.taskId,
            from: before.phase,
            to: after.phase,
            fromOperationStatus: before.operation.status,
            toOperationStatus: after.operation.status,
            attempt: after.attempts.length,
            at,
          });
      }
      if (current.status !== plan.status)
        plan.statusEvents.push({
          eventId: `status_${hashId(
            incidentId,
            "parent",
            current.revision,
            plan.statusEvents.length,
          )}`,
          incidentId,
          from: current.status,
          to: plan.status,
          at,
        });
      plan.statusEvents = plan.statusEvents.slice(-200);
      if (
        JSON.stringify(plan.children) === JSON.stringify(current.children) &&
        JSON.stringify(plan.handoffs) === JSON.stringify(current.handoffs) &&
        plan.status === current.status
      )
        return current;
      plan.updatedAt = at;
      return this.runtime.db.saveRecord("orchestration", incidentId, plan, current.revision);
    } finally {
      this.reconciling.delete(incidentId);
    }
  }
}
