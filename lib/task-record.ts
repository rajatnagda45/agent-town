export interface ComposedTask {
  id: string;
  status: string;
  error?: string;
  verdict: string | null;
  input: { goal: string };
  route: {
    workflow: string;
    dataSources: string[];
    risk: string;
    confidence: number;
    successCriteria: string[];
    clarification: string | null;
  };
  evidence: Array<{ evidenceId: string; source: string; content: string; retrievedAt: string }>;
  attempts: Array<{
    taskId: string;
    role: string;
    stage: string;
    seatId: string | null;
    executionDecision?: {
      runtime: string;
      modelProvider: string;
      model: string | null;
      reason: string[];
      rejected: Array<{ optionId: string; missing: string[] }>;
    };
  }>;
  contract?: {
    source: "inferred" | "caller";
    deliverable: {
      kind: string;
      minutes?: number;
      mode?: "exact" | "max" | "min";
      requiredSegments?: Array<{ label: string; minutes: number }>;
    };
  } | null;
  actions: Array<{ kind: string; status: string; executed: boolean; reason?: string }>;
  checks: Array<{
    description?: string;
    status: string;
    issues?: string[];
    ranking?: Array<{ id: string; label: string; value: number }>;
  }>;
  analysis?: { summary: string; alternatives: string[] };
  critic?: { decision: string; reason: string };
  report?: { summary: string; verified: boolean; scope: string };
  revisionHistory?: unknown[];
}

/** A local snapshot of the displayed record, not a signed attestation or a fresh verification. */
export function taskRecord(task: ComposedTask) {
  return {
    schema: "agent-town.investigation-record.v1",
    notice:
      "Local snapshot; review before sharing. No fresh verification or provider execution is performed.",
    taskId: task.id,
    status: task.status,
    verdict: task.verdict,
    goal: task.input.goal,
    workflow: task.route.workflow,
    sources: [...task.route.dataSources],
    report: task.report
      ? {
          summary: task.report.summary,
          verified: task.report.verified,
          scope: task.report.scope,
        }
      : null,
    evidence: task.evidence.map(({ evidenceId, source, retrievedAt, content }) => ({
      evidenceId,
      source,
      retrievedAt,
      synthetic: content.includes("SYNTHETIC DATA"),
    })),
    attempts: task.attempts.map(({ taskId, role, stage, seatId }) => ({
      taskId,
      role,
      stage,
      seatId,
    })),
    checks: task.checks.map(({ status, description, issues }) => ({ status, description, issues })),
    actions: task.actions.map(({ kind, status, executed }) => ({ kind, status, executed })),
    limitations: [
      "Source contents, attachments, runtime credentials, and provider audit records are excluded.",
      "Use the original task and source records to verify provenance; seat IDs do not prove independent agents.",
      "Verification applies only to the reported scope. This file is editable and is not an authenticity certificate.",
    ],
  };
}
