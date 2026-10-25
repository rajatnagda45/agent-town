import { assertOperationContract } from "../operations-contracts.mjs";
import { isDeepStrictEqual } from "node:util";

export const OPERATION_NAMESPACES = Object.freeze({
  incident: "operation.incident",
  task: "operation.task",
  evidenceItem: "operation.evidence",
  artifact: "operation.artifact",
  handoff: "operation.handoff",
  agentManifest: "operation.agentManifest",
  verificationResult: "operation.verification",
});

const ID_FIELDS = Object.freeze({
  incident: "incidentId",
  task: "taskId",
  evidenceItem: "evidenceId",
  artifact: "artifactId",
  handoff: "handoffId",
  agentManifest: "id",
  verificationResult: "verificationId",
});

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Persist validated operation records in the existing revisioned SQLite ledger. */
export class OperationRecords {
  constructor(db) {
    this.db = db;
  }

  namespace(kind) {
    const namespace = OPERATION_NAMESPACES[kind];
    if (!namespace) throw fail(400, `Unknown operation record kind: ${kind}`);
    return namespace;
  }

  decode(kind, stored) {
    if (!stored) return null;
    const value = assertOperationContract(kind, stored.value);
    if (stored.id !== value[ID_FIELDS[kind]])
      throw new Error(`Stored ${kind} ID does not match its contract value.`);
    return { id: stored.id, revision: stored.revision, value };
  }

  get(kind, id) {
    return this.decode(kind, this.db.record(this.namespace(kind), id));
  }

  list(kind) {
    return this.db.records(this.namespace(kind)).map((stored) => this.decode(kind, stored));
  }

  put(kind, value, expectedRevision) {
    const namespace = this.namespace(kind);
    assertOperationContract(kind, value);
    const id = value[ID_FIELDS[kind]];
    const previous = this.get(kind, id);
    if (previous && isDeepStrictEqual(previous.value, value)) return previous;
    if (previous && expectedRevision === undefined)
      throw fail(409, `Existing ${kind} requires its current revision to change.`);
    return this.decode(
      kind,
      this.db.saveRecord(namespace, id, { value }, expectedRevision, (stored) => ({
        id: stored.id,
        revision: stored.revision,
        ...(value.incidentId ? { incidentId: value.incidentId } : {}),
        ...(value.taskId ? { taskId: value.taskId } : {}),
      })),
    );
  }
}
