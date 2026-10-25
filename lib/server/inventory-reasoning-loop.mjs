import { createHash } from "node:crypto";
import { readCorrelatedNightshiftResult } from "./nightshift-reasoning.mjs";
import {
  INVENTORY_READS,
  INVENTORY_TEMPLATES,
  inventoryId,
  readInventoryEvidence,
} from "./inventory-investigation.mjs";
import { reconcileInventoryEvidence } from "./inventory-reconciliation.mjs";
import { PHASE3_CONSTRAINT, isPhase3, phase3Messages } from "../reasoning-contracts.mjs";
import { InventoryReasoningState } from "./inventory-reasoning-state.mjs";
import { SPECIALIST_CATALOGUE } from "./specialist-catalogue.mjs";

const key = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const text = (value, max = 2000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const list = (value) =>
  Array.isArray(value) && value.length <= 40 && value.every((item) => text(item, 500));
const criteriaPrefix = "inventory-reconciliation-v1:";
const verdictId = (incidentId) =>
  `inventory_${createHash("sha256").update(incidentId).digest("hex").slice(0, 32)}`;

function criteriaFromIncident(incident) {
  const encoded = incident.constraints.find((item) => item.startsWith(criteriaPrefix));
  if (!encoded) throw new Error("Inventory criteria are missing from the persisted incident.");
  const criteria = JSON.parse(encoded.slice(criteriaPrefix.length));
  if (
    !inventoryId(criteria.scenarioId) ||
    !inventoryId(criteria.sku) ||
    !inventoryId(criteria.locationId) ||
    !Number.isSafeInteger(criteria.ledgerQuantity) ||
    criteria.ledgerQuantity < 0 ||
    !Number.isSafeInteger(criteria.physicalQuantity) ||
    criteria.physicalQuantity < 0 ||
    !Number.isSafeInteger(criteria.maxUnexplainedUnits) ||
    criteria.maxUnexplainedUnits < 0 ||
    criteria.maxUnexplainedUnits > 100
  )
    throw new Error("Persisted inventory criteria are invalid.");
  return criteria;
}

export function roles(provider) {
  return provider === "nightshift"
    ? {
        planner: "nightshift-planner",
        reader: "nightshift-analyst",
        analyst: "nightshift-analyst",
        critic: "nightshift-critic",
      }
    : {
        planner: "planner",
        reader: "data-steward-researcher",
        analyst: "data-steward-researcher",
        critic: "critic",
      };
}

/** The runtime family that executes a plan. Output correlation and role names are
 * family-specific, so every child of one plan stays within the family the router chose. */
export function planFamily(operations, plan) {
  const provider = plan?.children?.find((child) => child.manifest)?.manifest.provider;
  if (provider === "meterless-nightshift") return "nightshift";
  return provider ?? operations.runtime.gateway.provider;
}

/** Routed mode: the router ranks eligible planner contexts across runtimes; unrouted mode
 * keeps the primary runtime. Each child then carries reviewed requirements bound to that family. */
export function chooseFamily(operations) {
  if (!operations.routed) return { family: operations.runtime.gateway.provider };
  const selection = operations.routing.selectTask({
    requirements: {
      capabilities: ["decompose_task"],
      tools: [],
      permissions: { dataAccess: "none", sensitiveWrites: "denied" },
    },
    preflight: true,
  });
  if (selection.status !== "assigned")
    throw new Error(`No eligible execution option: ${selection.reason}`);
  return { family: selection.executionDecision.runtime, routed: true };
}

export function withRequirements(tasks, family) {
  return tasks.map((task) => {
    const manifest = SPECIALIST_CATALOGUE.find(
      (entry) => entry.manifest.id === task.role,
    )?.manifest;
    return {
      ...task,
      requirements: {
        requiredRuntime: family,
        capabilities: manifest.capabilities.slice(0, 1),
        tools: [],
        permissions: manifest.permissions,
      },
    };
  });
}

function graph(criteria, missingEvidence = [], provider = "openclaw", goal = "", version = 1) {
  const role = roles(provider);
  const scope = `scenario ${criteria.scenarioId}, SKU ${criteria.sku} at ${criteria.locationId}`;
  const reviewedGraph = {
    goal,
    acceptanceCriteria: ["inventory-count", "inventory-reconciliation"],
    tasks: [
      { taskId: "reader", role: role.reader, dependencies: ["planner"] },
      { taskId: "analyst", role: role.analyst, dependencies: ["reader"] },
      { taskId: "critic", role: role.critic, dependencies: ["reader", "analyst"] },
    ],
  };
  const request = missingEvidence.length
    ? ` Specifically seek: ${missingEvidence.join("; ")}.`
    : "";
  const tasks = [
    {
      taskId: "planner",
      role: role.planner,
      message: `Plan a read-only investigation of ${scope}. Ledger ${criteria.ledgerQuantity}; physical ${criteria.physicalQuantity}; maximum unexplained ${criteria.maxUnexplainedUnits}. The reviewed task graph and criteria are ${JSON.stringify(reviewedGraph)}. Return exactly that JSON object, preserving its field names, array shapes, roles, IDs, dependencies and goal. Do not add tasks, explanations, markdown, or a verdict.`,
    },
    {
      taskId: "reader",
      role: role.reader,
      message: `Prepare the server-scoped inventory evidence read for ${scope}. Do not infer a verdict or adjust inventory.`,
      dependencies: ["planner"],
      requiresPlannerOutputFrom: "planner",
    },
    {
      taskId: "analyst",
      role: role.analyst,
      message: `Analyze the attached inventory count and explanation evidence for ${scope}.${request} Return only a JSON object with hypothesis (string), explanationEvidenceIds (array of supplied evidence ID strings), claimedExplainedUnits (nonnegative integer), and missingEvidence (array of strings). Use the server count-cutoff reconciliation supplied below: claimedExplainedUnits is its explainedQuantity, and explanationEvidenceIds are exactly its sourceExplanationEvidenceIds. Ledger and count rows establish the discrepancy; they are not explanation evidence unless a posted ledger receipt is linked to a receipt shortfall. Describe any remaining unexplained units in missingEvidence. Do not adjust inventory, add other fields, or use markdown.`,
      dependencies: ["reader"],
      requiredEvidenceFrom: ["reader"],
      evidenceContextFrom: ["reader"],
    },
    {
      taskId: "critic",
      role: role.critic,
      message: `Challenge the analyst's explanation for ${scope}. Return only a JSON object with hypothesisSupported (boolean), missingEvidence (array of strings), and conflictingEvidenceIds (array of supplied evidence ID strings). Compare the Analyst's quantity and explanation IDs with the server count-cutoff reconciliation supplied below. If its difference is positive, reject a complete explanation and describe the unsupported units in missingEvidence. Use conflictingEvidenceIds only for records that genuinely contradict the explanation; ledger and count rows are ordinary context, not conflicts. Do not approve an adjustment, add other fields, or use markdown.`,
      dependencies: ["reader", "analyst"],
      requiredEvidenceFrom: ["reader"],
      evidenceContextFrom: ["reader"],
      resultContextFrom: ["analyst"],
    },
  ];
  return version === 3 ? phase3Messages(tasks) : tasks;
}

function reasoningObject(result, role) {
  const text = result.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  let value;
  try {
    value = JSON.parse(fenced ? fenced[1] : text);
  } catch {
    throw new Error(`${role} result is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${role} result is not a JSON object.`);
  return value;
}

function parseAnalysis(result) {
  const value = reasoningObject(result, "Analyst");
  if (
    !value ||
    !text(value.hypothesis) ||
    !Array.isArray(value.explanationEvidenceIds) ||
    value.explanationEvidenceIds.length > 40 ||
    !value.explanationEvidenceIds.every(key) ||
    new Set(value.explanationEvidenceIds).size !== value.explanationEvidenceIds.length ||
    !Number.isSafeInteger(value.claimedExplainedUnits) ||
    value.claimedExplainedUnits < 0 ||
    !list(value.missingEvidence)
  )
    throw new Error("Analyst result does not match the reasoning schema.");
  return value;
}

function parsePlanner(result, incident, provider) {
  const value = reasoningObject(result, "Planner");
  const role = roles(provider);
  const expected = [
    { taskId: "reader", role: role.reader, dependencies: ["planner"] },
    { taskId: "analyst", role: role.analyst, dependencies: ["reader"] },
    { taskId: "critic", role: role.critic, dependencies: ["reader", "analyst"] },
  ];
  if (
    !value ||
    value.goal !== incident.goal ||
    !Array.isArray(value.acceptanceCriteria) ||
    JSON.stringify(value.acceptanceCriteria) !==
      JSON.stringify(incident.acceptanceCriteria.map((item) => item.criterionId)) ||
    JSON.stringify(value.tasks) !== JSON.stringify(expected)
  )
    throw new Error("Planner result does not match the accepted task graph schema.");
  return value;
}

function parseCritique(result) {
  const value = reasoningObject(result, "Critic");
  if (
    !value ||
    typeof value.hypothesisSupported !== "boolean" ||
    !list(value.missingEvidence) ||
    !Array.isArray(value.conflictingEvidenceIds) ||
    value.conflictingEvidenceIds.length > 40 ||
    !value.conflictingEvidenceIds.every(key)
  )
    throw new Error("Critic result does not match the reasoning schema.");
  return value;
}

function evidenceContent(item, incidentId, taskId, runtime) {
  if (!item || item.incidentId !== incidentId || item.taskId !== taskId || !item.auditRef)
    throw new Error("Reasoning references evidence outside the producer task.");
  const audit = runtime.db.record("operation.dataRead", item.auditRef);
  if (
    audit?.incidentId !== incidentId ||
    audit.taskId !== taskId ||
    !audit.evidenceIds?.includes(item.evidenceId)
  )
    throw new Error("Reasoning references evidence without a matching data-read audit.");
  return {
    content: JSON.parse(item.content),
    fresh: !!item.freshUntil && Date.parse(item.freshUntil) > Date.now(),
  };
}

function persistedInventoryReads(operations, { incidentId, taskId }) {
  const audits = operations.runtime.db
    .records("operation.dataRead")
    .filter((item) => item.incidentId === incidentId && item.taskId === taskId);
  const reads = {};
  for (const [kind, templateId] of INVENTORY_READS) {
    const matches = audits.filter((item) => item.templateId === templateId);
    if (matches.length !== 1) throw new Error(`Expected one persisted ${kind} source-read audit.`);
    const audit = matches[0];
    const evidence = audit.evidenceIds.map(
      (id) => operations.records.get("evidenceItem", id)?.value,
    );
    if (evidence.some((item) => !item))
      throw new Error(`Persisted ${kind} evidence is unavailable.`);
    reads[kind] = { auditRef: audit.id, scope: audit.binding, evidence };
  }
  return reads;
}

function completedRoleResult(operations, plan, nodeId) {
  const child = plan.children.find((item) => item.nodeId === nodeId);
  const taskId = child?.attempts.at(-1)?.runtimeTaskId;
  const task = taskId && operations.runtime.db.getTask(taskId);
  const assignment = child?.operation.assignment;
  if (
    !task ||
    task.status !== "completed" ||
    child.operation.taskId !== taskId ||
    task.orchestrationId !== plan.incident.incidentId ||
    task.orchestrationNodeId !== nodeId ||
    task.seatId !== assignment?.seatId ||
    task.agentId !== assignment?.agentId ||
    task.sessionKey !== assignment?.sessionKey ||
    task.bindingRevision !== assignment?.bindingRevision ||
    task.gatewayId !== assignment?.gatewayId
  )
    throw new Error("Reasoning must come from the current completed, bound attempt.");
  if (planFamily(operations, plan) === "nightshift")
    return readCorrelatedNightshiftResult({
      runtime: operations.runtime,
      records: operations.records,
      taskId,
      role: child.operation.role,
      contextRole: nodeId === "reader" ? "analyst" : nodeId,
    }).text;
  return task.result;
}

/** Lane A composition: Lane D dispatches each role; Lane C supplies durable task results.
 * The trusted verifier alone validates and persists the resulting Phase 0 verdict. */
export class InventoryReasoningLoop {
  constructor(operations, { templates } = {}) {
    this.operations = operations;
    this.templates =
      templates ?? operations.data?.reader?.inventoryTemplates ?? INVENTORY_TEMPLATES;
    this.reasoning = new InventoryReasoningState(operations, { templates: this.templates });
  }

  start({
    incidentId,
    goal,
    criteria,
    createdAt = new Date().toISOString(),
    reasoningVersion = 1,
  }) {
    if (![1, 3].includes(reasoningVersion))
      throw new Error("Unsupported inventory reasoning version.");
    if (!key(incidentId) || !text(goal) || !criteria || !Number.isFinite(Date.parse(createdAt)))
      throw new Error("A goal, incident ID and measurable criteria are required.");
    const checked = criteriaFromIncident({
      constraints: [`${criteriaPrefix}${JSON.stringify(criteria)}`],
    });
    const prior = this.operations.records.get("incident", incidentId)?.value;
    const version = prior
      ? prior.constraints.includes(PHASE3_CONSTRAINT)
        ? 3
        : 1
      : reasoningVersion;
    const plan = this.operations.create({
      incident: {
        incidentId,
        goal,
        constraints: [
          "Read only; no inventory adjustment.",
          `${criteriaPrefix}${JSON.stringify(checked)}`,
          ...(version === 3 ? [PHASE3_CONSTRAINT] : []),
        ],
        taskType: "inventory-investigation",
        acceptanceCriteria: [
          {
            criterionId: "inventory-count",
            description: `Confirm ledger ${checked.ledgerQuantity} and physical ${checked.physicalQuantity} units from current evidence.`,
          },
          {
            criterionId: "inventory-reconciliation",
            description: `Explain the variance with at most ${checked.maxUnexplainedUnits} unaccounted units.`,
          },
        ],
        createdAt: prior?.createdAt ?? createdAt,
      },
      tasks: (({ family, routed }) => {
        const tasks = graph(checked, [], family, goal, version);
        return routed ? withRequirements(tasks, family) : tasks;
      })(chooseFamily(this.operations)),
    });
    if (isPhase3(plan)) this.reasoning.save(plan, {});
    return plan;
  }

  acceptPlanner(incidentId) {
    const plan = this.operations.reconcile(incidentId);
    const result = completedRoleResult(this.operations, plan, "planner");
    parsePlanner(result, plan.incident, planFamily(this.operations, plan));
    const outputHash = createHash("sha256").update(result).digest("hex");
    return this.operations.syncPlan(
      this.operations.orchestration.confirmPlannerOutput({
        incidentId,
        nodeId: "planner",
        outputHash,
      }),
    );
  }

  /** Persist and attach the four reviewed reads before the Analyst is released. */
  async collectEvidence(incidentId) {
    const plan = this.operations.reconcile(incidentId);
    const reader = plan.children.find((child) => child.nodeId === "reader");
    completedRoleResult(this.operations, plan, "reader");
    const existing = this.operations.runtime.db
      .records("operation.dataRead")
      .filter((item) => item.incidentId === incidentId && item.taskId === reader.operation.taskId);
    if (existing.length) {
      if (
        INVENTORY_READS.every(
          ([, templateId]) =>
            existing.filter((item) => item.templateId === templateId).length === 1,
        )
      )
        return persistedInventoryReads(this.operations, {
          incidentId,
          taskId: reader.operation.taskId,
        });
      throw new Error("Inventory source reads are partial; operator recovery is required.");
    }
    const criteria = criteriaFromIncident(plan.incident);
    return readInventoryEvidence(this.operations, {
      incidentId,
      taskId: reader.operation.taskId,
      scenarioId: criteria.scenarioId,
      sku: criteria.sku,
      locationId: criteria.locationId,
    });
  }

  /** Call after every producer read is persisted and attached; this releases the Analyst. */
  confirmEvidence(incidentId) {
    const plan = this.operations.reconcile(incidentId);
    const reader = plan.children.find((child) => child.nodeId === "reader");
    completedRoleResult(this.operations, plan, "reader");
    if (!reader.evidenceIds.length)
      throw new Error("Current inventory evidence must be attached before Analyst dispatch.");
    for (const id of reader.evidenceIds) {
      const item = this.operations.records.get("evidenceItem", id)?.value;
      const checked = evidenceContent(
        item,
        incidentId,
        reader.operation.taskId,
        this.operations.runtime,
      );
      if (!checked.fresh) throw new Error("Stale inventory evidence cannot be dispatched.");
    }
    const criteria = criteriaFromIncident(plan.incident);
    const reads = persistedInventoryReads(this.operations, {
      incidentId,
      taskId: reader.operation.taskId,
    });
    const calculation = reconcileInventoryEvidence(reads, {
      incidentId,
      taskId: reader.operation.taskId,
      scenarioId: criteria.scenarioId,
      sku: criteria.sku,
      locationId: criteria.locationId,
      templates: this.templates,
    });
    if (calculation.status === "unresolved") throw new Error(calculation.reason);
    if (
      calculation.ledgerQuantity !== criteria.ledgerQuantity ||
      calculation.countQuantity !== criteria.physicalQuantity
    )
      throw new Error("Time-aligned count evidence conflicts with the measurable criteria.");
    const sourceExplanationEvidenceIds = [
      ...new Set(
        calculation.conclusions
          .filter((item) => ["unposted_transfer_out", "receipt_shortfall"].includes(item.code))
          .flatMap((item) => item.evidenceIds),
      ),
    ];
    const reasoningContext = isPhase3(plan) ? this.reasoning.createBundle(plan) : undefined;
    return this.operations.syncPlan(
      this.operations.orchestration.confirmEvidenceSet({
        incidentId,
        nodeId: "reader",
        evidenceIds: reader.evidenceIds,
        reasoningContext,
        reconciliation: {
          ledgerQuantity: calculation.ledgerQuantity,
          countQuantity: calculation.countQuantity,
          discrepancy: calculation.missingQuantity,
          explainedQuantity: calculation.explainedQuantity,
          difference: calculation.difference,
          countCutoffAt: calculation.countCutoffAt,
          ledgerCountEvidenceIds:
            calculation.conclusions.find((item) => item.code === "ledger_vs_count")?.evidenceIds ??
            [],
          sourceExplanationEvidenceIds,
          sourceReadAuditRefs: Object.fromEntries(
            INVENTORY_READS.map(([kind]) => [kind, reads[kind].auditRef]),
          ),
        },
      }),
    );
  }

  /** Check the completed Analyst's citations before the Critic receives its result. */
  acceptAnalyst(incidentId) {
    const plan = this.operations.reconcile(incidentId);
    const reader = plan.children.find((child) => child.nodeId === "reader");
    const analyst = plan.children.find((child) => child.nodeId === "analyst");
    const result = completedRoleResult(this.operations, plan, "analyst");
    const analysis = isPhase3(plan)
      ? this.reasoning.analysis(plan, result, true)
      : parseAnalysis(result);
    if (
      !plan.evidenceSet ||
      JSON.stringify(plan.evidenceSet.evidenceIds) !== JSON.stringify(reader.evidenceIds) ||
      JSON.stringify(analyst.dispatchedEvidenceIds) !== JSON.stringify(reader.evidenceIds) ||
      analysis.explanationEvidenceIds.some((id) => !reader.evidenceIds.includes(id))
    )
      throw new Error("Analyst cited evidence outside the current dispatched set.");
    for (const id of reader.evidenceIds) {
      const item = this.operations.records.get("evidenceItem", id)?.value;
      const checked = evidenceContent(
        item,
        incidentId,
        reader.operation.taskId,
        this.operations.runtime,
      );
      if (!checked.fresh) throw new Error("Analyst evidence expired before Critic dispatch.");
    }
    const criteria = criteriaFromIncident(plan.incident);
    const calculation = reconcileInventoryEvidence(
      persistedInventoryReads(this.operations, { incidentId, taskId: reader.operation.taskId }),
      {
        incidentId,
        taskId: reader.operation.taskId,
        scenarioId: criteria.scenarioId,
        sku: criteria.sku,
        locationId: criteria.locationId,
        templates: this.templates,
      },
    );
    if (calculation.status === "unresolved") throw new Error(calculation.reason);
    const outputHash = createHash("sha256").update(result).digest("hex");
    return this.operations.syncPlan(
      this.operations.orchestration.confirmResultContext({
        incidentId,
        nodeId: "analyst",
        outputHash,
      }),
    );
  }

  /** Return persisted reasoning and deterministic checks; never trust a model-supplied verdict. */
  check(incidentId) {
    const plan = this.operations.reconcile(incidentId);
    if (plan.status !== "awaiting_verification")
      throw new Error("Planner, Analyst and Critic must finish before checking the investigation.");
    const criteria = criteriaFromIncident(plan.incident);
    const planner = plan.children.find((child) => child.nodeId === "planner");
    const reader = plan.children.find((child) => child.nodeId === "reader");
    const analyst = plan.children.find((child) => child.nodeId === "analyst");
    const critic = plan.children.find((child) => child.nodeId === "critic");
    const issues = [];
    const missingEvidence = [];
    try {
      completedRoleResult(this.operations, plan, "reader");
    } catch (error) {
      issues.push(error.message);
    }
    let plannerPlan;
    let analysis;
    let critique;
    let analystResult;
    try {
      const plannerResult = completedRoleResult(this.operations, plan, "planner");
      plannerPlan = parsePlanner(plannerResult, plan.incident, planFamily(this.operations, plan));
      if (
        plan.plannerOutput?.taskId !== planner.operation.taskId ||
        createHash("sha256").update(plannerResult).digest("hex") !== plan.plannerOutput.outputHash
      )
        issues.push("Planner graph was not confirmed before dispatch.");
    } catch (error) {
      issues.push(error.message);
    }
    try {
      analystResult = completedRoleResult(this.operations, plan, "analyst");
      analysis = isPhase3(plan)
        ? this.reasoning.analysis(plan, analystResult)
        : parseAnalysis(analystResult);
      if (
        plan.confirmedResult?.taskId !== analyst.operation.taskId ||
        createHash("sha256").update(analystResult).digest("hex") !== plan.confirmedResult.outputHash
      )
        issues.push("Analyst reasoning was not confirmed before Critic dispatch.");
    } catch (error) {
      issues.push(error.message);
      analysis = {
        hypothesis: "Analyst result is invalid.",
        explanationEvidenceIds: [],
        claimedExplainedUnits: 0,
        missingEvidence: [],
      };
    }
    try {
      const result = completedRoleResult(this.operations, plan, "critic");
      if (isPhase3(plan)) {
        const decision = this.reasoning.critic(plan, result);
        const primary = this.reasoning
          .state(plan)
          .analysis?.hypotheses.find(
            (h) => h.hypothesisId === this.reasoning.state(plan).analysis.primaryHypothesisId,
          );
        critique = {
          hypothesisSupported: decision.decision === "ACCEPT",
          missingEvidence: decision.missingEvidence,
          conflictingEvidenceIds: primary?.contradictingEvidenceIds ?? [],
        };
        if (decision.decision === "UNCERTAIN")
          issues.push(`Critic remains uncertain: ${decision.reasoning}`);
      } else critique = parseCritique(result);
    } catch (error) {
      issues.push(error.message);
      critique = { hypothesisSupported: false, missingEvidence: [], conflictingEvidenceIds: [] };
    }
    if (
      plan.evidenceSet?.taskId !== reader.operation.taskId ||
      JSON.stringify(plan.evidenceSet?.evidenceIds) !== JSON.stringify(reader.evidenceIds) ||
      JSON.stringify(analyst.dispatchedEvidenceIds) !== JSON.stringify(reader.evidenceIds) ||
      JSON.stringify(critic.dispatchedEvidenceIds) !== JSON.stringify(reader.evidenceIds)
    )
      issues.push("Analyst did not receive the current confirmed evidence set.");
    missingEvidence.push(...analysis.missingEvidence, ...critique.missingEvidence);
    const evidence = [];
    for (const id of reader.evidenceIds) {
      const item = this.operations.records.get("evidenceItem", id)?.value;
      try {
        const checked = evidenceContent(
          item,
          incidentId,
          reader.operation.taskId,
          this.operations.runtime,
        );
        evidence.push({ item, content: checked.content });
        if (!checked.fresh)
          missingEvidence.push(`A current replacement for evidence ${id} is needed.`);
      } catch {
        issues.push(`Evidence ${id} is missing, malformed, or lacks a matching audit.`);
      }
    }
    let calculation;
    try {
      calculation = reconcileInventoryEvidence(
        persistedInventoryReads(this.operations, { incidentId, taskId: reader.operation.taskId }),
        {
          incidentId,
          taskId: reader.operation.taskId,
          scenarioId: criteria.scenarioId,
          sku: criteria.sku,
          locationId: criteria.locationId,
          templates: this.templates,
        },
      );
    } catch (error) {
      issues.push(error.message);
    }
    if (calculation?.status === "unresolved") issues.push(calculation.reason);
    if (calculation && calculation.status !== "unresolved") {
      if (
        calculation.ledgerQuantity !== criteria.ledgerQuantity ||
        calculation.countQuantity !== criteria.physicalQuantity
      )
        issues.push("Time-aligned count evidence conflicts with the measurable criteria.");
      const sourceExplanationIds = [
        ...new Set(
          calculation.conclusions
            .filter((item) => ["unposted_transfer_out", "receipt_shortfall"].includes(item.code))
            .flatMap((item) => item.evidenceIds),
        ),
      ];
      if (
        JSON.stringify([...analysis.explanationEvidenceIds].sort()) !==
        JSON.stringify(sourceExplanationIds.sort())
      )
        issues.push("Analyst explanation references do not match applicable persisted evidence.");
      if (analysis.claimedExplainedUnits !== calculation.explainedQuantity)
        issues.push("Analyst quantity does not equal the time-aligned source records.");
      if (calculation.status === "conflicting")
        issues.push("Source support exceeds the observed shortage.");
    }
    if (critique.conflictingEvidenceIds.some((id) => !reader.evidenceIds.includes(id)))
      issues.push("Critic cited evidence outside the investigation.");
    if (critique.conflictingEvidenceIds.length)
      issues.push("Critic identified conflicting evidence.");
    if (!critique.hypothesisSupported)
      missingEvidence.push("Critic did not support the current hypothesis.");
    const discrepancy = calculation?.missingQuantity ?? null;
    const explained = calculation?.explainedQuantity ?? 0;
    const unexplained = calculation?.difference ?? null;
    if (unexplained !== null && unexplained > criteria.maxUnexplainedUnits)
      missingEvidence.push(`${unexplained} unit(s) still need source-backed explanation.`);
    if (unexplained !== null && unexplained < 0)
      issues.push("Explanations exceed the observed shortage.");
    const evidenceIds = [
      ...new Set(calculation?.conclusions?.flatMap((item) => item.evidenceIds) ?? []),
    ];
    const verdict =
      issues.length || !evidenceIds.length
        ? "unresolved"
        : missingEvidence.length
          ? plan.revisionOf
            ? "unresolved"
            : "revise"
          : "pass";
    if (isPhase3(plan))
      this.reasoning.evaluate(plan, completedRoleResult(this.operations, plan, "critic"), issues);
    return {
      incidentId,
      plannerPlan,
      hypothesis: analysis.hypothesis,
      evidenceIds,
      missingEvidence: [...new Set(missingEvidence)],
      issues,
      reconciliation: {
        discrepancy,
        explained,
        unexplained,
        openingAt: calculation?.openingAt ?? null,
        countCutoffAt: calculation?.countCutoffAt ?? null,
        excludedEvidence: calculation?.excludedEvidence ?? [],
        sourceMode: calculation?.sourceMode ?? null,
      },
      verdict,
    };
  }

  finish(incidentId, { checkedAt = new Date().toISOString() } = {}) {
    const plan = this.operations.orchestration.get(incidentId);
    if (isPhase3(plan)) {
      const stored = this.reasoning.recoverVerification(plan);
      if (stored) {
        const review = {
          ...JSON.parse(stored.reason),
          incidentId,
          verdict: stored.verdict,
          evidenceIds: stored.evidenceIds,
        };
        if (stored.verdict === "pass") {
          try {
            const lesson = this.reasoning.lesson(plan, review.hypothesis);
            this.operations.runtime.memory.writeVerified({
              taskId: stored.taskId,
              verificationId: stored.verificationId,
              ...lesson,
            });
          } catch (error) {
            // A recovered verdict retains its original time. Expired or changed proof cannot create a new lesson.
            if (error.status !== 409) throw error;
          }
        }
        return { verification: stored, review };
      }
    }
    if (plan.verification) {
      if (isPhase3(plan)) this.reasoning.verified(plan, plan.verification);
      return { verification: plan.verification, review: this.check(incidentId) };
    }
    const review = this.check(incidentId);
    const critic = this.operations.orchestration
      .get(incidentId)
      .children.find((child) => child.nodeId === "critic");
    const reason = JSON.stringify({
      hypothesis: review.hypothesis,
      reconciliation: review.reconciliation,
      issues: review.issues,
      missingEvidence: review.missingEvidence,
    });
    const verification = {
      verificationId: verdictId(incidentId),
      incidentId,
      taskId: critic.operation.taskId,
      verdict: review.verdict,
      evidenceIds: review.evidenceIds,
      reason,
      checkedAt,
    };
    const saved = this.operations.recordVerification({
      verification,
      ...(isPhase3(plan) && verification.verdict === "pass"
        ? { lesson: this.reasoning.lesson(plan, review.hypothesis) }
        : {}),
    }).verification;
    if (isPhase3(plan)) this.reasoning.verified(plan, saved);
    return { verification: saved, review };
  }

  revise(originalIncidentId, revisionIncidentId, { scenarioId } = {}) {
    const original = this.operations.orchestration.get(originalIncidentId);
    if (original.verification?.verdict !== "revise")
      throw new Error("A persisted revise verdict is required before a second attempt.");
    if (!key(revisionIncidentId)) throw new Error("A valid revision incident ID is required.");
    const reason = JSON.parse(original.verification.reason);
    const previousCriteria = criteriaFromIncident(original.incident);
    const criteria = { ...previousCriteria, scenarioId: scenarioId ?? previousCriteria.scenarioId };
    if (!inventoryId(criteria.scenarioId))
      throw new Error("A valid revision scenario ID is required.");
    if (isPhase3(original)) this.reasoning.authorizeRevision(original, criteria.scenarioId);
    const revisionIncident = {
      ...original.incident,
      incidentId: revisionIncidentId,
      goal: `${original.incident.goal} Resolve: ${reason.missingEvidence.join("; ")}`,
      constraints: original.incident.constraints.map((item) =>
        item.startsWith(criteriaPrefix) ? `${criteriaPrefix}${JSON.stringify(criteria)}` : item,
      ),
      createdAt:
        this.operations.records.get("incident", revisionIncidentId)?.value.createdAt ??
        new Date().toISOString(),
    };
    return this.operations.revise({
      originalIncidentId,
      revisionIncident,
      reason: original.verification.reason,
      evidenceIds: original.verification.evidenceIds,
      tasks: (() => {
        // A revision stays in the original plan's runtime family.
        const family = planFamily(this.operations, original);
        const tasks = graph(
          criteria,
          reason.missingEvidence,
          family,
          revisionIncident.goal,
          isPhase3(original) ? 3 : 1,
        );
        return this.operations.routed ? withRequirements(tasks, family) : tasks;
      })(),
    });
  }
}
