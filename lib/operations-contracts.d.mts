import type { PersistentTaskItem, TaskStatus } from "../types/game";

export interface Incident {
  incidentId: string;
  goal: string;
  constraints: string[];
  taskType: string;
  acceptanceCriteria: Array<{ criterionId: string; description: string }>;
  createdAt: string;
}

export interface OperationTask {
  taskId: string;
  incidentId: string;
  parentTaskId?: string;
  requester:
    | { kind: "user" }
    | {
        kind: "agent";
        seatId: string;
        agentId: string;
        bindingRevision: number;
        gatewayId: string;
        sessionKey: string;
      };
  role: string;
  dependencies: string[];
  status: "planned" | "blocked" | TaskStatus;
  retryCount: number;
  /** Present only after TaskRuntime accepts the task. */
  assignment?: {
    runtimeTaskId: string;
    seatId: string;
    agentId: string;
    bindingRevision: number;
    gatewayId: string;
    sessionKey: string;
  };
}

export interface EvidenceItem {
  evidenceId: string;
  incidentId: string;
  taskId: string;
  source: string;
  recordId: string;
  /** Null means the source gave no timestamp; callers must not invent one. */
  sourceTimestamp: string | null;
  retrievedAt: string;
  /** Optional expiry time; absence does not imply the evidence is current. */
  freshUntil?: string;
  /** Server-created reference to the persisted source read audit. */
  auditRef?: string;
  content: string;
}

export interface AgentBindingIdentity {
  seatId: string;
  agentId: string;
  bindingRevision: number;
  gatewayId: string;
  sessionKey: string;
}

export interface ArtifactRecord {
  artifactId: string;
  incidentId: string;
  taskId: string;
  mediaType: string;
  uri: string;
  sha256: string;
  description: string;
  createdAt: string;
}

export interface HandoffRecord {
  handoffId: string;
  incidentId: string;
  fromTaskId: string;
  toTaskId: string;
  from: AgentBindingIdentity;
  to: AgentBindingIdentity;
  summary: string;
  evidenceIds: string[];
  artifactIds: string[];
  status: "proposed" | "accepted" | "rejected";
  createdAt: string;
}

export interface AgentManifest {
  id: string;
  version: string;
  source: string;
  provider: string;
  capabilities: string[];
  skills: string[];
  tools: string[];
  permissions: {
    dataAccess: "none" | "read_only" | "scoped_write";
    sensitiveWrites: "denied" | "approval_required";
  };
  limits: {
    maxRetries: number;
    maxParallelTasks: number;
    maxRuntimeSeconds: number;
    maxToolCalls: number;
  };
}

export interface VerificationResult {
  verificationId: string;
  incidentId: string;
  taskId: string;
  verdict: "pass" | "revise" | "unresolved";
  evidenceIds: string[];
  artifactIds?: string[];
  reason: string;
  checkedAt: string;
}

export type OperationContractKind =
  | "incident"
  | "task"
  | "evidenceItem"
  | "artifact"
  | "handoff"
  | "agentManifest"
  | "verificationResult";

export const OPERATION_TASK_STATUSES: readonly OperationTask["status"][];
export const OPERATION_SCHEMAS: Record<OperationContractKind, Record<string, unknown>>;
export function assertOperationContract<K extends OperationContractKind>(
  kind: K,
  value: unknown,
): {
  incident: Incident;
  task: OperationTask;
  evidenceItem: EvidenceItem;
  artifact: ArtifactRecord;
  handoff: HandoffRecord;
  agentManifest: AgentManifest;
  verificationResult: VerificationResult;
}[K];
export function assignedOperationTask(input: {
  incidentId: string;
  parentTaskId?: string;
  requester: OperationTask["requester"];
  role: string;
  dependencies?: string[];
  retryCount?: number;
  task: PersistentTaskItem;
}): OperationTask;
