export interface ReasoningHypothesis {
  hypothesisId: string;
  statement: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
  claimedExplainedUnits: number;
}
export interface ReasoningAnalysis {
  bundleId: string;
  primaryHypothesisId: string | null;
  hypotheses: ReasoningHypothesis[];
}
export interface ReasoningCritic {
  bundleId: string;
  decision: "ACCEPT" | "REVISE" | "UNCERTAIN";
  hypothesisIds: string[];
  evidenceIds: string[];
  reasoning: string;
  missingEvidence: string[];
  nextTasks: Array<{
    templateId: string;
    parameters: { scenarioId: string; sku: string; locationId: string };
    reason: string;
  }>;
}
export interface ReasoningBundle {
  schemaVersion: 1;
  bundleId: string;
  incidentId: string;
  taskId: string;
  createdAt: string;
  scope: { scenarioId: string; sku: string; locationId: string };
  temporalScope: { openingAt: string | null; countCutoffAt: string | null };
  businessRules: { domain: "inventory-shortage-v1"; maxUnexplainedUnits: number; rules: string[] };
  evidence: Array<{
    evidenceId: string;
    revision: number;
    source: string;
    recordId: string;
    auditRef: string;
    sourceTimestamp: string;
    retrievedAt: string;
    freshUntil: string;
  }>;
  audits: Array<{ auditRef: string; revision: number; templateId: string; createdAt: string }>;
  memory: Array<{
    memoryId: string;
    verificationId: string;
    incidentId: string;
    evidenceIds: string[];
    freshUntil: string;
    content: string;
    applicability: string;
  }>;
  checks: {
    supported: boolean;
    reason: string;
    ledgerQuantity: number | null;
    countQuantity: number | null;
    discrepancy: number | null;
    explained: number | null;
    unexplained: number | null;
    applicableEvidenceIds: string[];
    explanationEvidenceIds: string[];
    excludedEvidence: Array<{ evidenceId: string; reason: string }>;
  };
}
export interface ReasoningState {
  schemaVersion: 1;
  incidentId: string;
  rootIncidentId: string;
  attempt: 1 | 2;
  maxAttempts: 2;
  stage:
    | "awaiting_evidence"
    | "evidence_ready"
    | "hypotheses_ready"
    | "evaluated"
    | "verified"
    | "revision_required"
    | "unresolved";
  bundleId: string | null;
  analysis: ReasoningAnalysis | null;
  critic: ReasoningCritic | null;
  issues: string[];
  verificationId: string | null;
  history: Array<{ stage: string; at: string }>;
}
export const REASONING_SCHEMAS: Record<string, object>;
export function assertReasoningContract(kind: "analysis", value: unknown): ReasoningAnalysis;
export function assertReasoningContract(kind: "critic", value: unknown): ReasoningCritic;
export function assertReasoningContract(kind: "bundle", value: unknown): ReasoningBundle;
export function assertReasoningContract(kind: "state", value: unknown): ReasoningState;
export const PHASE3_CONSTRAINT: string;
export function isPhase3(plan: { incident?: { constraints?: string[] } }): boolean;
export function phase3Messages<T extends { taskId: string; message: string }>(tasks: T[]): T[];
