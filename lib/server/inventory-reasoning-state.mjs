import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReasoningContract, isPhase3 } from "../reasoning-contracts.mjs";
import { INVENTORY_READS, INVENTORY_TEMPLATES } from "./inventory-investigation.mjs";
import { reconcileInventoryEvidence } from "./inventory-reconciliation.mjs";
import { resolveDataTaskScope } from "./data-integration.mjs";
import { compileReadQuery } from "./data-source.mjs";

const namespace = "operation.reasoning";
const bundles = "operation.reasoningBundle";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameIds = (a, b) => isDeepStrictEqual([...a].sort(), [...b].sort());
const unique = (values) => [...new Set(values)];
const parse = (kind, result) => {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(result.trim());
  return assertReasoningContract(kind, JSON.parse(fenced ? fenced[1] : result));
};
const criteriaFor = (plan) =>
  JSON.parse(
    plan.incident.constraints
      .find((c) => c.startsWith("inventory-reconciliation-v1:"))
      .slice("inventory-reconciliation-v1:".length),
  );
const topic = ({ sku, locationId }) => `inventory-shortage:${sku}:${locationId}`;
const rules = [
  "Read only. No inventory adjustment or external action.",
  "Only inventory shortages are supported. Surplus and ambiguous timing remain unresolved.",
  "Use events strictly after opening and before the physical count; exclude post-cutoff records.",
  "A receipt shortfall must link to an applicable posted receipt of the same expected quantity.",
  "Memory prioritizes investigation and cannot replace current source evidence.",
];

/** Additive persisted state machine. Every attempt retains its own immutable bundle and output. */
export class InventoryReasoningState {
  constructor(operations, { templates } = {}) {
    this.operations = operations;
    this.db = operations.runtime.db;
    this.templates =
      templates ?? operations.data?.reader?.inventoryTemplates ?? INVENTORY_TEMPLATES;
  }

  state(plan) {
    const stored = this.db.record(namespace, plan.incident.incidentId);
    const root = plan.revisionOf ? this.operations.orchestration.get(plan.revisionOf) : plan;
    if (root.revisionOf) throw new Error("Reasoning attempt budget is exhausted.");
    if (stored) {
      const state = assertReasoningContract("state", stored.value);
      if (
        state.incidentId !== plan.incident.incidentId ||
        state.rootIncidentId !== root.incident.incidentId ||
        state.attempt !== (plan.revisionOf ? 2 : 1)
      )
        throw new Error("Persisted reasoning budget or incident ownership is invalid.");
      return state;
    }
    return {
      schemaVersion: 1,
      incidentId: plan.incident.incidentId,
      rootIncidentId: root.incident.incidentId,
      attempt: plan.revisionOf ? 2 : 1,
      maxAttempts: 2,
      stage: "awaiting_evidence",
      bundleId: null,
      analysis: null,
      critic: null,
      issues: [],
      verificationId: null,
      history: [{ stage: "awaiting_evidence", at: plan.incident.createdAt }],
    };
  }

  save(plan, patch) {
    const current = this.state(plan);
    const next = { ...current, ...patch };
    if (isDeepStrictEqual(current, next) && this.db.record(namespace, current.incidentId))
      return current;
    const transitions = {
      awaiting_evidence: ["evidence_ready"],
      evidence_ready: ["hypotheses_ready"],
      hypotheses_ready: ["evaluated"],
      evaluated: ["verified", "revision_required", "unresolved"],
      verified: [],
      revision_required: [],
      unresolved: [],
    };
    if (next.stage !== current.stage) {
      if (!transitions[current.stage].includes(next.stage))
        throw new Error("Invalid reasoning state transition.");
      next.history = [...current.history, { stage: next.stage, at: new Date().toISOString() }];
    }
    assertReasoningContract("state", next);
    const stored = this.db.record(namespace, current.incidentId);
    this.db.saveRecord(
      namespace,
      current.incidentId,
      { value: next },
      stored?.revision ?? 0,
      (row) => ({ incidentId: current.incidentId, revision: row.revision, stage: next.stage }),
    );
    return next;
  }

  reads(plan) {
    const reader = plan.children.find((child) => child.nodeId === "reader");
    const scope = resolveDataTaskScope(
      this.operations.runtime,
      this.operations.records,
      plan.incident.incidentId,
      reader.operation.taskId,
    );
    this.operations.registry.revalidate({
      manifest: reader.manifest,
      assignment: reader.operation.assignment,
    });
    const all = this.db
      .records("operation.dataRead")
      .filter((a) => a.incidentId === scope.incidentId && a.taskId === scope.taskId);
    const reads = {};
    for (const [kind, templateId] of INVENTORY_READS) {
      const matches = all.filter((a) => a.templateId === templateId);
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0].binding, scope))
        throw new Error("Missing or unauthorized source-read audit.");
      const audit = matches[0];
      const evidence = audit.evidenceIds.map((id) => {
        const item = this.operations.records.get("evidenceItem", id)?.value;
        if (
          !item ||
          item.incidentId !== scope.incidentId ||
          item.taskId !== scope.taskId ||
          item.auditRef !== audit.id ||
          !reader.evidenceIds.includes(id) ||
          !audit.sourceRefs.some((r) => r.recordId === item.recordId && r.source === item.source)
        )
          throw new Error("Bundle evidence is missing, cross-incident or unauthorized.");
        if (
          !item.freshUntil ||
          Date.parse(item.freshUntil) <= Date.now() ||
          Date.parse(item.retrievedAt) > Date.now()
        )
          throw new Error("Bundle evidence is stale or has a future retrieval time.");
        return item;
      });
      reads[kind] = { evidence, auditRef: audit.id, scope };
    }
    if (
      !sameIds(
        reader.evidenceIds,
        Object.values(reads).flatMap((r) => r.evidence.map((e) => e.evidenceId)),
      )
    )
      throw new Error("Bundle does not cover the exact attached evidence set.");
    return reads;
  }

  calculate(plan, reads = this.reads(plan)) {
    const criteria = criteriaFor(plan);
    return reconcileInventoryEvidence(reads, {
      ...criteria,
      incidentId: plan.incident.incidentId,
      taskId: plan.children.find((c) => c.nodeId === "reader").operation.taskId,
      templates: this.templates,
    });
  }

  checks(calculation) {
    return {
      supported: !["unresolved", "conflicting"].includes(calculation.status),
      reason: calculation.reason ?? "",
      ledgerQuantity: calculation.ledgerQuantity ?? null,
      countQuantity: calculation.countQuantity ?? null,
      discrepancy: calculation.missingQuantity ?? null,
      explained: calculation.explainedQuantity ?? null,
      unexplained: calculation.difference ?? null,
      applicableEvidenceIds: unique(calculation.conclusions.flatMap((c) => c.evidenceIds)),
      explanationEvidenceIds: unique(
        calculation.conclusions
          .filter((c) => ["unposted_transfer_out", "receipt_shortfall"].includes(c.code))
          .flatMap((c) => c.evidenceIds),
      ),
      excludedEvidence: calculation.excludedEvidence ?? [],
    };
  }

  memories(plan) {
    const critic = plan.children.find((c) => c.nodeId === "critic");
    const assignment = critic.operation.assignment ?? critic.target;
    const criteria = criteriaFor(plan);
    if (!assignment || !this.operations.runtime.memory) return [];
    return this.operations.runtime.memory
      .retrieve({ ...assignment, query: topic(criteria), limit: 5 })
      .filter((m) => m.applicability === topic(criteria))
      .map((m) => ({
        memoryId: m.id,
        verificationId: m.source.verificationId,
        incidentId: m.source.incidentId,
        evidenceIds: m.source.evidenceIds,
        freshUntil: m.freshUntil,
        content: m.content,
        applicability: m.applicability,
      }));
  }

  createBundle(plan) {
    const current = this.state(plan);
    if (current.bundleId) return this.validateBundle(plan);
    const reads = this.reads(plan);
    const calculation = this.calculate(plan, reads);
    const criteria = criteriaFor(plan);
    const value = {
      schemaVersion: 1,
      incidentId: plan.incident.incidentId,
      taskId: plan.children.find((c) => c.nodeId === "reader").operation.taskId,
      createdAt: new Date().toISOString(),
      scope: {
        scenarioId: criteria.scenarioId,
        sku: criteria.sku,
        locationId: criteria.locationId,
      },
      temporalScope: {
        openingAt: calculation.openingAt ?? null,
        countCutoffAt: calculation.countCutoffAt ?? null,
      },
      businessRules: {
        domain: "inventory-shortage-v1",
        maxUnexplainedUnits: criteria.maxUnexplainedUnits,
        rules,
      },
      evidence: Object.values(reads).flatMap((r) =>
        r.evidence.map((e) => ({
          evidenceId: e.evidenceId,
          revision: this.operations.records.get("evidenceItem", e.evidenceId).revision,
          source: e.source,
          recordId: e.recordId,
          auditRef: e.auditRef,
          sourceTimestamp: e.sourceTimestamp,
          retrievedAt: e.retrievedAt,
          freshUntil: e.freshUntil,
        })),
      ),
      audits: INVENTORY_READS.map(([kind, templateId]) => {
        const audit = this.db.record("operation.dataRead", reads[kind].auditRef);
        return {
          auditRef: audit.id,
          revision: audit.revision,
          templateId,
          createdAt: audit.createdAt,
        };
      }),
      memory: this.memories(plan),
      checks: this.checks(calculation),
    };
    const bundle = assertReasoningContract("bundle", {
      ...value,
      bundleId: `bundle_${digest(value)}`,
    });
    this.db.saveRecord(bundles, bundle.bundleId, { value: bundle }, 0, (row) => ({
      incidentId: bundle.incidentId,
      bundleId: row.id,
      revision: row.revision,
    }));
    this.save(plan, { stage: "evidence_ready", bundleId: bundle.bundleId });
    return bundle;
  }

  validateBundle(plan) {
    const state = this.state(plan);
    const bundle = assertReasoningContract(
      "bundle",
      this.db.record(bundles, state.bundleId)?.value,
    );
    const { bundleId, ...content } = bundle;
    if (bundleId !== `bundle_${digest(content)}` || bundle.incidentId !== plan.incident.incidentId)
      throw new Error("Bundle integrity or incident ownership failed.");
    const reads = this.reads(plan);
    const currentIds = Object.values(reads).flatMap((r) => r.evidence.map((e) => e.evidenceId));
    if (
      !sameIds(
        currentIds,
        bundle.evidence.map((e) => e.evidenceId),
      )
    )
      throw new Error("Bundle references changed.");
    for (const ref of bundle.evidence) {
      const current = this.operations.records.get("evidenceItem", ref.evidenceId);
      if (
        current.revision !== ref.revision ||
        Object.entries(ref).some(([k, v]) => k !== "revision" && current.value[k] !== v)
      )
        throw new Error("Bundle evidence revision changed.");
    }
    for (const ref of bundle.audits) {
      const audit = this.db.record("operation.dataRead", ref.auditRef);
      if (
        audit?.revision !== ref.revision ||
        audit.templateId !== ref.templateId ||
        audit.createdAt !== ref.createdAt
      )
        throw new Error("Bundle audit revision changed.");
    }
    const currentChecks = this.checks(this.calculate(plan, reads));
    if (!isDeepStrictEqual(bundle.checks, currentChecks))
      throw new Error("Bundle deterministic checks are no longer applicable.");
    const criteria = criteriaFor(plan);
    if (
      !isDeepStrictEqual(bundle.scope, {
        scenarioId: criteria.scenarioId,
        sku: criteria.sku,
        locationId: criteria.locationId,
      }) ||
      bundle.businessRules.maxUnexplainedUnits !== criteria.maxUnexplainedUnits ||
      !isDeepStrictEqual(bundle.businessRules.rules, rules)
    )
      throw new Error("Bundle business rules or scope no longer match the incident.");
    const applicable = this.memories(plan);
    if (bundle.memory.some((m) => !applicable.some((current) => isDeepStrictEqual(m, current))))
      throw new Error("Bundle memory is stale, superseded or outside scope.");
    return bundle;
  }

  analysis(plan, result, persist = false) {
    const bundle = this.validateBundle(plan);
    const analysis = parse("analysis", result);
    if (
      analysis.bundleId !== bundle.bundleId ||
      new Set(analysis.hypotheses.map((h) => h.hypothesisId)).size !== analysis.hypotheses.length ||
      (analysis.hypotheses.length
        ? !analysis.hypotheses.some((h) => h.hypothesisId === analysis.primaryHypothesisId)
        : analysis.primaryHypothesisId !== null)
    )
      throw new Error("Analyst cites a forged bundle or primary hypothesis.");
    for (const h of analysis.hypotheses) {
      if (
        h.supportingEvidenceIds.some((id) => !bundle.checks.applicableEvidenceIds.includes(id)) ||
        h.contradictingEvidenceIds.some(
          (id) => !bundle.evidence.some((e) => e.evidenceId === id),
        ) ||
        h.supportingEvidenceIds.some((id) => h.contradictingEvidenceIds.includes(id))
      )
        throw new Error("Hypothesis cites unsupported, excluded or contradictory references.");
    }
    const current = this.state(plan);
    if (current.analysis && !isDeepStrictEqual(current.analysis, analysis))
      throw new Error("Persisted hypotheses changed after dispatch.");
    if (persist && !current.analysis) this.save(plan, { stage: "hypotheses_ready", analysis });
    const primary = analysis.hypotheses.find(
      (h) => h.hypothesisId === analysis.primaryHypothesisId,
    );
    return {
      hypothesis: primary?.statement ?? "No supported hypothesis proposed.",
      explanationEvidenceIds: primary?.supportingEvidenceIds ?? [],
      claimedExplainedUnits: primary?.claimedExplainedUnits ?? 0,
      missingEvidence: primary?.missingEvidence ?? [
        "No hypothesis is supported by the current evidence.",
      ],
    };
  }

  critic(plan, result) {
    const bundle = this.validateBundle(plan);
    const state = this.state(plan);
    const critic = parse("critic", result);
    if (
      !state.analysis ||
      critic.bundleId !== bundle.bundleId ||
      critic.hypothesisIds.some(
        (id) => !state.analysis.hypotheses.some((h) => h.hypothesisId === id),
      ) ||
      critic.evidenceIds.some((id) => !bundle.evidence.some((e) => e.evidenceId === id))
    )
      throw new Error("Critic cited forged bundle, hypothesis or evidence references.");
    for (const task of critic.nextTasks) {
      if (
        !INVENTORY_READS.some(([, id]) => id === task.templateId) ||
        !isDeepStrictEqual(task.parameters, bundle.scope)
      )
        throw new Error("Critic proposed an unauthorized next task or scope.");
      compileReadQuery(this.templates[task.templateId], task.parameters);
    }
    if (new Set(critic.nextTasks.map((t) => t.templateId)).size !== critic.nextTasks.length)
      throw new Error("Critic proposed duplicate next tasks.");
    if (
      critic.decision === "REVISE" &&
      (!critic.missingEvidence.length || !critic.nextTasks.length)
    )
      throw new Error("Revision requires missing evidence and bounded read proposals.");
    if (
      critic.decision === "ACCEPT" &&
      (critic.missingEvidence.length ||
        critic.nextTasks.length ||
        !critic.hypothesisIds.includes(state.analysis.primaryHypothesisId) ||
        !bundle.checks.explanationEvidenceIds.every((id) => critic.evidenceIds.includes(id)))
    )
      throw new Error("Critic acceptance lacks complete primary hypothesis citations.");
    if (state.critic && !isDeepStrictEqual(state.critic, critic))
      throw new Error("Persisted Critic response changed.");
    return critic;
  }

  evaluate(plan, result, issues) {
    let critic = null;
    try {
      critic = this.critic(plan, result);
    } catch (error) {
      issues.push(error.message);
    }
    const current = this.state(plan);
    if (["hypotheses_ready", "evaluated"].includes(current.stage))
      this.save(plan, { stage: "evaluated", critic, issues: unique(issues).slice(0, 20) });
  }

  assertPassing(plan) {
    const bundle = this.validateBundle(plan);
    const state = this.state(plan);
    if (!state.analysis || !state.critic || state.issues.length)
      throw new Error("Passing reasoning is incomplete or has unresolved issues.");
    const analyst = plan.children.find((c) => c.nodeId === "analyst");
    const critic = plan.children.find((c) => c.nodeId === "critic");
    const analystTask = this.db.getTask(analyst.operation.taskId);
    const criticTask = this.db.getTask(critic.operation.taskId);
    if (
      analystTask?.status !== "completed" ||
      criticTask?.status !== "completed" ||
      createHash("sha256").update(analystTask.result).digest("hex") !==
        plan.confirmedResult?.outputHash
    )
      throw new Error("Passing reasoning must match the completed current attempts.");
    this.analysis(plan, analystTask.result);
    const decision = this.critic(plan, criticTask.result);
    const primary = state.analysis.hypotheses.find(
      (h) => h.hypothesisId === state.analysis.primaryHypothesisId,
    );
    const criteria = criteriaFor(plan);
    if (
      decision.decision !== "ACCEPT" ||
      !primary ||
      primary.missingEvidence.length ||
      primary.contradictingEvidenceIds.length ||
      !bundle.checks.supported ||
      bundle.checks.ledgerQuantity !== criteria.ledgerQuantity ||
      bundle.checks.countQuantity !== criteria.physicalQuantity ||
      bundle.checks.unexplained === null ||
      bundle.checks.unexplained < 0 ||
      bundle.checks.unexplained > criteria.maxUnexplainedUnits ||
      primary.claimedExplainedUnits !== bundle.checks.explained ||
      !sameIds(primary.supportingEvidenceIds, bundle.checks.explanationEvidenceIds)
    )
      throw new Error("Independent deterministic verification rejected the reasoning acceptance.");
  }

  verified(plan, verification) {
    const stage = { pass: "verified", revise: "revision_required", unresolved: "unresolved" }[
      verification.verdict
    ];
    const current = this.state(plan);
    if (current.stage === "hypotheses_ready") this.save(plan, { stage: "evaluated" });
    return this.save(plan, { stage, verificationId: verification.verificationId });
  }

  recoverVerification(plan) {
    const verificationId = `inventory_${createHash("sha256").update(plan.incident.incidentId).digest("hex").slice(0, 32)}`;
    const stored = this.operations.records.get("verificationResult", verificationId)?.value;
    if (!stored) return null;
    if (
      stored.incidentId !== plan.incident.incidentId ||
      stored.taskId !== plan.children.find((c) => c.nodeId === "critic").operation.taskId
    )
      throw new Error("Recovered verification is outside the current attempt.");
    this.operations.orchestration.recordVerification(stored);
    this.verified(plan, stored);
    return stored;
  }

  authorizeRevision(plan, scenarioId) {
    const state = this.state(plan);
    if (
      state.attempt !== 1 ||
      plan.revisionOf ||
      plan.verification?.verdict !== "revise" ||
      state.critic?.decision !== "REVISE"
    )
      throw new Error("Reasoning revision is unauthorized or the two-attempt budget is exhausted.");
    for (const proposal of state.critic.nextTasks)
      compileReadQuery(this.templates[proposal.templateId], { ...proposal.parameters, scenarioId });
    for (const child of plan.children) {
      if (this.db.getTask(child.operation.taskId)?.status !== "completed")
        throw new Error("Unknown or incomplete execution cannot be repeated automatically.");
      const latest = this.operations.registry.revalidate({
        manifest: child.manifest,
        assignment: child.operation.assignment,
      });
      if (
        this.operations.registry.enforcement?.authorizeSync?.({
          ...latest,
          task: { ...child.operation, message: child.message },
        }) !== true
      )
        throw new Error("Revision provider enforcement rejected a next task.");
    }
  }

  lesson(plan, hypothesis) {
    const criteria = criteriaFor(plan);
    return {
      content: `${topic(criteria)}: ${hypothesis}. Use current evidence; this lesson only prioritizes investigation.`,
      applicability: topic(criteria),
    };
  }

  view(plan) {
    if (!isPhase3(plan)) return null;
    const state = this.state(plan);
    const bundle = state.bundleId ? this.db.record(bundles, state.bundleId)?.value : null;
    const original = plan.revisionOf
      ? this.state(this.operations.orchestration.get(plan.revisionOf))
      : null;
    let rejectedCritic = null;
    if (!state.critic) {
      const critic = plan.children.find((c) => c.nodeId === "critic");
      const task = this.db.getTask(critic.operation.taskId);
      if (task?.status === "completed") {
        try {
          rejectedCritic = parse("critic", task.result);
        } catch {
          /* Raw output remains in task history. */
        }
      }
    }
    const hypothesisChecks = (state.analysis?.hypotheses ?? []).map((hypothesis) => ({
      hypothesisId: hypothesis.hypothesisId,
      arithmeticMatches: hypothesis.claimedExplainedUnits === bundle?.checks.explained,
      explanationReferencesMatch:
        !!bundle && sameIds(hypothesis.supportingEvidenceIds, bundle.checks.explanationEvidenceIds),
      contradictions: hypothesis.contradictingEvidenceIds.length,
      missingEvidence: hypothesis.missingEvidence.length,
    }));
    return {
      ...state,
      bundle,
      original,
      rejectedCritic,
      hypothesisChecks,
      remainingAttempts: plan.revisedIncidentId ? 0 : 2 - state.attempt,
    };
  }
}
