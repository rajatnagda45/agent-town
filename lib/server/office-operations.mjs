import { OperationRecords } from "./operation-records.mjs";
import { SpecialistJournal } from "./specialist-journal.mjs";
import { SpecialistRegistry } from "./specialist-registry.mjs";
import { OrchestrationService } from "./orchestration.mjs";
import { DataEvidenceService } from "./data-integration.mjs";
import { TrustedVerificationService } from "./trusted-verification.mjs";
import { isPhase3 } from "../reasoning-contracts.mjs";
import { InventoryReasoningState } from "./inventory-reasoning-state.mjs";
import { createHash } from "node:crypto";
import { ExecutionRouter } from "./execution-router.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Server-only composition. Existing task HTTP endpoints remain the runtime authority. */
export class OfficeOperations {
  /** @param {any} runtime @param {{ specialists?: any, dataReader?: any, clock?: () => Date }} [options] */
  constructor(runtime, { specialists = {}, dataReader = null, clock } = {}) {
    this.runtime = runtime;
    this.records = new OperationRecords(runtime.db);
    this.journal = new SpecialistJournal(runtime.db, runtime.gatewayId);
    const evidence = { get: (id) => this.records.get("evidenceItem", id)?.value };
    this.registry = new SpecialistRegistry({
      runtime,
      journal: this.journal,
      evidence,
      grants: specialists.grants ?? [],
      profiles: specialists.profiles ?? {},
      enforcement: specialists.enforcement,
    });
    const executionOptions =
      typeof specialists.executionOptions === "function"
        ? specialists.executionOptions(this.registry)
        : specialists.executionOptions;
    this.routing = executionOptions?.length
      ? new ExecutionRouter(this.registry, executionOptions, {
          preference: specialists.executionPreference ?? [],
        })
      : this.registry;
    /** True only when task-level routing across verified execution options is active. */
    this.routed = this.routing !== this.registry;
    this.orchestration = new OrchestrationService(runtime, { registry: this.routing, evidence });
    this.data = dataReader
      ? new DataEvidenceService(runtime, this.records, dataReader, clock ? { clock } : undefined)
      : null;
    this.verifier = new TrustedVerificationService(
      runtime,
      this.records,
      clock ? { clock } : undefined,
    );
  }

  syncPlan(plan) {
    this.records.put(
      "incident",
      plan.incident,
      this.records.get("incident", plan.incident.incidentId)?.revision,
    );
    for (const child of plan.children) {
      const value = child.operation;
      this.records.put("task", value, this.records.get("task", value.taskId)?.revision);
    }
    return plan;
  }

  create(input) {
    return this.syncPlan(this.orchestration.create(input));
  }

  /** Capability-based entry. Provisioning is bounded and occurs before the trusted plan is created. */
  async createWithSpecialists(input) {
    if (!input?.incident?.incidentId || !Array.isArray(input.tasks))
      throw fail(400, "An incident and reviewed task requirements are required.");
    let newAgents = 0;
    const tasks = [];
    for (const task of input.tasks) {
      if (!task.requirements) {
        tasks.push(task);
        continue;
      }
      let selection = this.routing.selectTask({
        role: task.role,
        requirements: task.requirements,
        task: { message: task.message, retryCount: 0 },
      });
      if (selection.status === "provision_required") {
        // Automatic hiring is limited to read-only, denied-write profiles.
        if (
          ++newAgents <= 2 &&
          selection.manifest.permissions.sensitiveWrites === "denied" &&
          selection.manifest.permissions.dataAccess !== "scoped_write"
        ) {
          const requestId = createHash("sha256")
            .update(`${input.incident.incidentId}:${task.taskId}:${selection.manifest.id}`)
            .digest("hex")
            .slice(0, 40);
          try {
            const provisioned = await this.registry.provision({
              requestId,
              manifestId: selection.manifest.id,
              requester: task.requester ?? { kind: "user" },
            });
            if (["bound", "binding_pending"].includes(provisioned.status)) {
              await this.runtime.refresh();
              this.registry.recover();
            }
          } catch {
            // The plan below records no_eligible_agent; creation is never retried here.
          }
          selection = this.registry.selectTask({
            role: selection.manifest.id,
            requirements: task.requirements,
          });
        }
      }
      tasks.push({ ...task, role: selection.manifest?.id ?? task.role ?? "unassigned" });
    }
    return this.create({ ...input, tasks });
  }

  /** Small same-origin office entry; browser input cannot choose a provider or grant tools. */
  async requestSpecialist({ requestId, goal, kind }) {
    this.runtime.estop?.assertClear();
    if (
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(requestId) ||
      typeof goal !== "string" ||
      !goal.trim() ||
      goal.length > 2000 ||
      !["research", "maintenance-manual"].includes(kind)
    )
      throw fail(400, "A valid specialist request, goal, and reviewed capability are required.");
    const requirements =
      kind === "research"
        ? {
            capabilities: ["research_external_sources"],
            tools: ["tavily.search"],
            permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
            skillIds: [],
          }
        : {
            capabilities: ["review_maintenance_history", "interpret_equipment_manual"],
            tools: [],
            permissions: { dataAccess: "none", sensitiveWrites: "denied" },
            skillIds: ["equipment-manual-review"],
          };
    const incidentId = `specialist_${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ goal: goal.trim(), kind }))
      .digest("hex");
    const prior = this.runtime.db.record("office.specialistRequest", incidentId);
    if (prior && prior.requestHash !== requestHash)
      throw fail(409, "Specialist request ID was already used for another task.");
    const createdAt = prior?.createdAt ?? new Date().toISOString();
    if (!prior)
      this.runtime.db.saveRecord("office.specialistRequest", incidentId, {
        incidentId,
        requestHash,
        kind,
        createdAt,
      });
    const plan = await this.createWithSpecialists({
      incident: {
        incidentId,
        goal: goal.trim(),
        taskType: "investigation",
        constraints: ["Read only. No equipment control, inventory changes, or external writes."],
        acceptanceCriteria: [
          {
            criterionId: "evidence-linked-result",
            description:
              "Cite supplied source evidence, identify uncertainty, and do not claim verified success without review.",
          },
        ],
        createdAt,
      },
      tasks: [{ taskId: "specialist", message: goal.trim(), requirements, maxRetries: 0 }],
    });
    // Persist the routing outcome either way: the chosen option or the specific block reason.
    const executionDecision = plan.children[0].executionDecision ?? null;
    const blockedReason = executionDecision ? null : (plan.children[0].uncertainty ?? null);
    const record = this.runtime.db.record("office.specialistRequest", incidentId);
    if (
      record &&
      (!("executionDecision" in record) ||
        JSON.stringify([record.executionDecision, record.blockedReason]) !==
          JSON.stringify([executionDecision, blockedReason]))
    )
      this.runtime.db.saveRecord(
        "office.specialistRequest",
        incidentId,
        { ...record, executionDecision, blockedReason },
        record.revision,
      );
    return {
      incidentId,
      status: plan.status,
      taskId: plan.children[0].operation.taskId,
      role: plan.children[0].operation.role,
      reason: plan.children[0].uncertainty ?? null,
      executionDecision,
    };
  }
  reconcile(incidentId) {
    return this.syncPlan(this.orchestration.reconcile(incidentId));
  }
  revise(input) {
    return this.syncPlan(this.orchestration.revise(input));
  }

  async readEvidence(input) {
    if (!this.data) throw fail(503, "A reviewed data reader is not configured.");
    const result = await this.data.read(input);
    this.orchestration.attachEvidence({
      incidentId: input.incidentId,
      taskId: input.taskId,
      evidenceIds: result.evidence.map((item) => item.evidenceId),
    });
    this.syncPlan(this.orchestration.get(input.incidentId));
    return result;
  }

  recordVerification(input) {
    const { verification } = input;
    this.syncPlan(this.orchestration.get(verification.incidentId));
    this.orchestration.recordVerification(verification, { dryRun: true });
    const result = this.verifier.record(input);
    this.orchestration.recordVerification(verification);
    return result;
  }

  async recover() {
    this.registry.recover();
    if (this.runtime.gateway.provider === "openclaw" && this.runtime.agentsReady)
      await this.registry.refreshSessions().catch(() => {});
    this.orchestration.reconcileAll();
    for (const plan of this.orchestration.all()) {
      this.syncPlan(plan);
      if (isPhase3(plan)) new InventoryReasoningState(this).recoverVerification(plan);
    }
  }

  close() {
    this.orchestration.close();
    this.registry.close();
  }
}
