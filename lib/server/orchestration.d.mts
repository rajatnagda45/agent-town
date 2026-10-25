import type {
  AgentManifest,
  EvidenceItem,
  Incident,
  OperationTask,
  VerificationResult,
} from "../operations-contracts.mjs";
import type { ReasoningBundle } from "../reasoning-contracts.mjs";

export interface OrchestrationTaskInput {
  /** Stable graph node ID. OperationTask.taskId becomes the durable runtime attempt ID. */
  taskId: string;
  requester?: OperationTask["requester"];
  role: string;
  message: string;
  deliverable?: {
    id: string;
    description: string;
    kind: "report" | "research" | "agenda" | "synthesis" | "review";
    minutes?: number;
    /** exact (default): total equals minutes; max: at most; min: at least. */
    mode?: "exact" | "max" | "min";
    requiredSegments?: Array<{ label: string; minutes: number }>;
    duplicateReason?: string;
  };
  /** Reviewed capability requirements; selection goes through the shared router. */
  requirements?: Record<string, unknown>;
  /** Stable graph node IDs, translated to runtime task IDs in OperationTask. */
  dependencies?: string[];
  requiredEvidenceFrom?: string[];
  /** Persisted producer references appended to the dispatch message after confirmation. */
  evidenceContextFrom?: string[];
  /** Completed, server-validated task result appended to the dispatch message. */
  resultContextFrom?: string[];
  /** Dependencies whose validated deliverable is handed to this task as context. */
  handoffFrom?: string[];
  /** Hold dispatch until server code confirms the named Planner's durable JSON result. */
  requiresPlannerOutputFrom?: string;
  maxRetries?: number;
}

export interface OrchestrationInput {
  incident: Incident;
  tasks: OrchestrationTaskInput[];
  maxParallelTasks?: number;
}

export type VerifiedAssignment = Omit<NonNullable<OperationTask["assignment"]>, "runtimeTaskId">;

export interface OrchestrationRegistry {
  dispatchOrchestration(input: {
    requestId: string;
    selection: { manifest: AgentManifest; assignment: VerifiedAssignment };
    task: { taskId: string; message: string; retryCount: number };
  }): { status: string; runtimeTaskId?: string };
  assign(input: { incident: Incident; task: OperationTask }): {
    status?: "assigned";
    manifest: AgentManifest;
    assignment: VerifiedAssignment;
  };
}

export interface OrchestrationEvidenceRepository {
  get(evidenceId: string): EvidenceItem | undefined;
}

export interface OrchestrationAttempt {
  runtimeTaskId: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
}

export interface OrchestrationChild {
  nodeId: string;
  dependsOn: string[];
  operation: OperationTask;
  message: string;
  requiredEvidenceFrom: string[];
  evidenceContextFrom?: string[];
  resultContextFrom?: string[];
  dispatchedEvidenceIds?: string[];
  requiresPlannerOutputFrom?: string;
  maxRetries: number;
  evidenceIds: string[];
  attempts: OrchestrationAttempt[];
  phase: string;
  uncertainty?: string;
  result?: string | null;
  manifest: AgentManifest;
  target: VerifiedAssignment;
  dispatchCode?: string;
  deliverable?: OrchestrationTaskInput["deliverable"];
  requirements?: Record<string, unknown>;
  /** Router decision: runtime, verified upstream model provider (or "unknown"), reason. */
  executionDecision?: {
    optionId: string;
    runtime: string;
    modelProvider: string;
    model: string | null;
    reason: string[];
    rejected: Array<{ optionId: string; missing: string[] }>;
    [key: string]: unknown;
  };
  /** Why a ready task is not dispatched yet (concurrency, paused dispatch). */
  waitReason?: string;
  /** One bounded request for a distinct contribution after a repeated result. */
  distinctRevision?: {
    requestedAt: string;
    similarTo: string;
    similarity: number;
    attempt?: number;
  };
  /** Review hints for the Critic and Lead; never an automatic pass or rejection. */
  reviewSignals?: {
    repeats?: { similarTo: string; similarity: number };
    escalated: boolean;
  };
}

export interface OrchestrationHandoff {
  handoffId: string;
  incidentId: string;
  fromTaskId: string;
  toTaskId: string;
  fromNodeId: string;
  toNodeId: string;
  fromAssignment: NonNullable<OperationTask["assignment"]>;
  toAssignment: NonNullable<OperationTask["assignment"]>;
  evidenceIds: string[];
  recordedAt: string;
}

export interface OrchestrationStatusEvent {
  eventId: string;
  incidentId: string;
  nodeId?: string;
  taskId?: string;
  from: string;
  to: string;
  fromOperationStatus?: OperationTask["status"];
  toOperationStatus?: OperationTask["status"];
  attempt?: number;
  at: string;
}

export interface OrchestrationPlan {
  id: string;
  revision: number;
  incident: Incident;
  gatewayId: string;
  maxParallelTasks: number;
  children: OrchestrationChild[];
  handoffs: OrchestrationHandoff[];
  statusEvents: OrchestrationStatusEvent[];
  status: "planned" | "running" | "failed" | "unresolved" | "awaiting_verification";
  verification?: VerificationResult;
  plannerOutput?: { nodeId: string; taskId: string; outputHash: string; validatedAt: string };
  evidenceSet?: {
    nodeId: string;
    taskId: string;
    evidenceIds: string[];
    confirmedAt: string;
    reconciliation?: InventoryReconciliationGuidance;
    reasoningContext?: ReasoningBundle;
  };
  confirmedResult?: { nodeId: string; taskId: string; outputHash: string; confirmedAt: string };
  revisionOf?: string;
  revisedIncidentId?: string;
  updatedAt: string;
}

export interface InventoryReconciliationGuidance {
  ledgerQuantity: number;
  countQuantity: number;
  discrepancy: number;
  explainedQuantity: number;
  difference: number;
  countCutoffAt: string;
  ledgerCountEvidenceIds: string[];
  sourceExplanationEvidenceIds: string[];
  sourceReadAuditRefs: Record<string, string>;
}

export interface OrchestrationSummary {
  incidentId: string;
  goal: string;
  status: OrchestrationPlan["status"];
  childCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export declare class OrchestrationService {
  constructor(
    runtime: object,
    adapters?: {
      registry?: OrchestrationRegistry;
      evidence?: OrchestrationEvidenceRepository;
    },
  );
  close(): void;
  create(input: OrchestrationInput): OrchestrationPlan;
  get(incidentId: string): OrchestrationPlan;
  list(): OrchestrationSummary[];
  /** Queue Team Lead guidance for pending work; late guidance is recorded as missed. */
  steer(input: { incidentId: string; nodeId: string; message: string }): {
    nodeId: string;
    status: "queued" | "missed";
    phase: string;
  };
  /** Stop further dispatch of a task and its dependents; in-flight work is not killed. */
  stop(input: { incidentId: string; nodeId: string; reason?: string }): {
    nodeId: string;
    status: "stopped" | "stopping_after_current_attempt" | "already_completed";
  };
  team(incidentId: string): {
    incidentId: string;
    goal: string;
    status: string;
    members: Array<{
      nodeId: string;
      role: string;
      seatId: string | null;
      phase: string;
      attempts: number;
      dependsOn: string[];
      handoffChars: number;
      steers: number;
      missedSteers: number;
      stopped: boolean;
      uncertainty: string | null;
      [key: string]: unknown;
    }>;
  };
  attachEvidence(input: {
    incidentId: string;
    taskId: string;
    evidenceIds: string[];
  }): OrchestrationPlan;
  confirmPlannerOutput(input: {
    incidentId: string;
    nodeId: string;
    outputHash: string;
  }): OrchestrationPlan;
  confirmEvidenceSet(input: {
    incidentId: string;
    nodeId: string;
    evidenceIds: string[];
    reconciliation?: InventoryReconciliationGuidance;
    reasoningContext?: ReasoningBundle;
  }): OrchestrationPlan;
  confirmResultContext(input: {
    incidentId: string;
    nodeId: string;
    outputHash: string;
  }): OrchestrationPlan;
  recordVerification(result: VerificationResult): OrchestrationPlan;
  revise(input: {
    originalIncidentId: string;
    revisionIncident: Incident;
    reason: string;
    evidenceIds: string[];
    tasks: OrchestrationTaskInput[];
    maxParallelTasks?: number;
  }): OrchestrationPlan;
  reconcile(incidentId: string): OrchestrationPlan;
  reconcileAll(): void;
}
