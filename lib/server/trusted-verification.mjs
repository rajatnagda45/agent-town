import { assertOperationContract } from "../operations-contracts.mjs";
import { resolveDataTaskScope } from "./data-integration.mjs";
import { isPhase3 } from "../reasoning-contracts.mjs";
import { InventoryReasoningState } from "./inventory-reasoning-state.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Internal verifier boundary. It has no model-facing or browser write route. */
export class TrustedVerificationService {
  constructor(runtime, records, { clock = () => new Date() } = {}) {
    this.runtime = runtime;
    this.records = records;
    this.clock = clock;
  }

  record({ verification, lesson }) {
    assertOperationContract("verificationResult", verification);
    const task = this.runtime.db.getTask(verification.taskId);
    resolveDataTaskScope(this.runtime, this.records, verification.incidentId, verification.taskId);
    if (task.status !== "completed")
      throw fail(409, "Execution must finish before a verification result is recorded.");
    const orchestration = this.runtime.db.record("orchestration", verification.incidentId);
    if (
      orchestration &&
      (!Array.isArray(orchestration.children) ||
        !orchestration.children.some(
          (child) =>
            child.operation?.taskId === verification.taskId &&
            child.attempts?.at(-1)?.runtimeTaskId === verification.taskId,
        ))
    )
      throw fail(409, "Verification task is not the current incident attempt.");
    const now = this.clock().getTime();
    if (orchestration && isPhase3(orchestration) && verification.verdict === "pass")
      new InventoryReasoningState(this.runtime.operations).assertPassing(orchestration);
    if (Date.parse(verification.checkedAt) > now)
      throw fail(400, "Verification time cannot be in the future.");
    if (new Set(verification.evidenceIds).size !== verification.evidenceIds.length)
      throw fail(400, "Verification contains duplicate evidence IDs.");
    const evidence = verification.evidenceIds.map(
      (id) => this.records.get("evidenceItem", id)?.value,
    );
    if (
      evidence.some((item) => {
        const audit = item?.auditRef && this.runtime.db.record("operation.dataRead", item.auditRef);
        let owner;
        try {
          owner =
            item &&
            resolveDataTaskScope(this.runtime, this.records, verification.incidentId, item.taskId);
        } catch {
          return true;
        }
        return (
          !item ||
          item.incidentId !== verification.incidentId ||
          (orchestration &&
            !orchestration.children.some(
              (child) =>
                child.evidenceIds?.includes(item.evidenceId) &&
                child.attempts?.some((attempt) => attempt.runtimeTaskId === item.taskId),
            )) ||
          this.runtime.db.getTask(item.taskId)?.status !== "completed" ||
          audit?.incidentId !== verification.incidentId ||
          audit.taskId !== item.taskId ||
          audit.binding?.seatId !== owner.seatId ||
          audit.binding?.agentId !== owner.agentId ||
          audit.binding?.gatewayId !== owner.gatewayId ||
          audit.binding?.sessionKey !== owner.sessionKey ||
          audit.binding?.bindingRevision !== owner.bindingRevision ||
          !audit.evidenceIds?.includes(item.evidenceId) ||
          !audit.sourceRefs?.some(
            (source) => source.source === item.source && source.recordId === item.recordId,
          ) ||
          Date.parse(item.retrievedAt) > Date.parse(verification.checkedAt)
        );
      })
    )
      throw fail(409, "Verification references missing or unrelated persisted evidence.");
    if (
      verification.artifactIds?.some((id) => {
        const artifact = this.records.get("artifact", id)?.value;
        return (
          !artifact ||
          artifact.incidentId !== verification.incidentId ||
          artifact.taskId !== verification.taskId
        );
      })
    )
      throw fail(409, "Verification references missing or unrelated artifacts.");
    if (
      verification.verdict === "pass" &&
      (!evidence.length ||
        evidence.some((item) => !item.freshUntil || Date.parse(item.freshUntil) <= now))
    )
      throw fail(409, "Passing verification requires currently fresh evidence.");
    const stored = this.records.put("verificationResult", verification);
    const memory =
      verification.verdict === "pass" && lesson
        ? this.runtime.memory.writeVerified({
            taskId: verification.taskId,
            verificationId: verification.verificationId,
            content: lesson.content,
            applicability: lesson.applicability,
          })
        : null;
    return { verification: stored.value, revision: stored.revision, lesson: memory };
  }
}
