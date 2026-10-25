import type {
  AgentManifest,
  ArtifactRecord,
  EvidenceItem,
  HandoffRecord,
  Incident,
  OperationContractKind,
  OperationTask,
  VerificationResult,
} from "../operations-contracts.mjs";

export type OperationRecordValue = {
  incident: Incident;
  task: OperationTask;
  evidenceItem: EvidenceItem;
  artifact: ArtifactRecord;
  handoff: HandoffRecord;
  agentManifest: AgentManifest;
  verificationResult: VerificationResult;
};

export interface StoredOperationRecord<K extends OperationContractKind> {
  id: string;
  revision: number;
  value: OperationRecordValue[K];
}

export const OPERATION_NAMESPACES: Readonly<Record<OperationContractKind, string>>;

export class OperationRecords {
  constructor(db: import("./task-db.mjs").TaskDatabase);
  namespace(kind: OperationContractKind): string;
  get<K extends OperationContractKind>(kind: K, id: string): StoredOperationRecord<K> | null;
  list<K extends OperationContractKind>(kind: K): Array<StoredOperationRecord<K>>;
  put<K extends OperationContractKind>(
    kind: K,
    value: OperationRecordValue[K],
    expectedRevision?: number,
  ): StoredOperationRecord<K>;
}
