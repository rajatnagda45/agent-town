// Truthful lifecycle of one office request (a Work task), derived only from what is persisted:
// the composer record, its timeline of status transitions and execution events, its stage
// attempts and the runtime tasks they dispatched. Nothing here is inferred from agent text, and
// a stage with no record is "not recorded" or "not attempted", never shown as done.

const AWAITING = new Set(["needs_confirmation", "needs_clarification", "approval_required"]);
// Composer status order, used to tell which stages a task has moved past.
const ORDER = ["ready", "planning", "collecting", "analyzing", "reviewing", "completed"];
const reached = (record, status) => {
  if (record.status === status) return true;
  if ((record.timeline ?? []).some((event) => event.event === status)) return true;
  return ORDER.indexOf(record.status) > ORDER.indexOf(status) && ORDER.includes(record.status);
};
const at = (record, event) =>
  (record.timeline ?? []).find((entry) => entry.event === event)?.at ?? null;
const lastAt = (record, event) =>
  (record.timeline ?? []).findLast((entry) => entry.event === event)?.at ?? null;

/** Known blocking causes, matched on recorded errors; anything else stays unresolved. */
const DIAGNOSES = [
  ["missing_binding", /no available backend agent binding|binding (changed|is missing)|not bound/i],
  ["unassigned_seat", /unassigned seat|seat is not assigned|no available office agents/i],
  [
    "capability_not_discovered",
    /capability discovery|capability .* not (discovered|verified)|No eligible/i,
  ],
  ["permission_denied", /permission|forbidden|not permitted|\b403\b/i],
  ["authentication_failure", /unauthori[sz]ed|credentials were rejected|\b401\b|auth_failed/i],
  ["provider_unavailable", /unreachable|unavailable|disconnected|ECONNREFUSED|network/i],
  ["timeout", /timed out|timeout/i],
  ["missing_approval", /approval required|requires? (authorized )?(human )?approval/i],
  [
    "insufficient_data",
    /^Blocked: .*no .*records|has no purchase order|no physical count records/i,
  ],
  ["dependency_not_satisfied", /prerequisite|dependency|depends on/i],
];
export function diagnose(error) {
  if (!error) return null;
  const match = DIAGNOSES.find(([, pattern]) => pattern.test(error));
  return match
    ? { cause: match[0], confirmed: true, observed: error }
    : { cause: "unresolved", confirmed: false, observed: error };
}

/** One stage's worker, from the routed attempt and the runtime task it actually dispatched. */
function worker(attempt, runtime) {
  if (!attempt) return null;
  const task = attempt.taskId ? runtime?.db?.getTask?.(attempt.taskId) : null;
  const seat = attempt.seatId ? runtime?.db?.getSeat?.(attempt.seatId) : null;
  const decision = attempt.executionDecision;
  const executed = !!task && ["running", "returning", "completed"].includes(task.status);
  return {
    role: attempt.role,
    configured: seat
      ? { seatId: seat.seatId, label: seat.label, agentId: seat.binding?.agentId ?? null }
      : null,
    selected: decision
      ? {
          optionId: decision.optionId,
          runtime: decision.runtime,
          model: decision.model ?? null,
          reason: decision.reason?.[0] ?? null,
          rejected: (decision.rejected ?? []).map((item) => ({
            optionId: item.optionId,
            missing: item.missing,
          })),
        }
      : null,
    dispatched: task
      ? {
          taskId: task.taskId,
          agentId: task.agentId ?? null,
          sessionKey: task.sessionKey ?? null,
          seatId: task.seatId ?? null,
          status: task.status,
          createdAt: task.createdAt ?? null,
          completedAt: task.completedAt ?? null,
          retryCount: task.retryCount ?? 0,
        }
      : null,
    // Only a runtime task that reached running or later counts as having executed.
    executed: executed
      ? { agentId: task.agentId, sessionKey: task.sessionKey, runId: task.runId ?? null }
      : null,
  };
}

/** Whether stage workers are one agent, one agent in several sessions, or distinct agents. */
export function independence(workers) {
  const known = workers.filter((w) => w?.dispatched?.agentId);
  if (known.length < 2)
    return {
      kind: "unknown",
      warning: "Fewer than two dispatched stages; independence is not established.",
    };
  const agents = new Set(known.map((w) => w.dispatched.agentId));
  const sessions = new Set(known.map((w) => `${w.dispatched.agentId}|${w.dispatched.sessionKey}`));
  if (agents.size === 1 && sessions.size === 1)
    return {
      kind: "same_agent_same_session",
      warning: "All stages ran as one agent in one session; the review is not independent.",
    };
  if (agents.size === 1)
    return {
      kind: "same_agent_different_sessions",
      warning: `All stages ran on backend agent ${[...agents][0]} in separate sessions. Separate sessions are separate contexts, not independent agents.`,
    };
  return { kind: "distinct_agents", warning: null };
}

const stage = (id, title, purpose, status, extra = {}) => ({
  id,
  title,
  purpose,
  status,
  ...extra,
});

/** @param {any} record composer record  @param {{runtime?: any, messages?: any[]}} context */
export function deriveLifecycle(record, { runtime = null, messages = [] } = {}) {
  const attempts = record.attempts ?? [];
  const attempt = (name) => attempts.filter((a) => a.stage === name).at(-1);
  const analystAttempts = attempts.filter((a) => a.stage === "analyst");
  const usesData = (record.route?.dataSources ?? []).length > 0;
  const research = record.route?.domain === "research";
  const evidence = record.evidence ?? [];
  const failedQuery = (record.timeline ?? []).findLast((e) => e.event === "query_failed");
  const unresolved = record.status === "unresolved";
  const verified = record.status === "completed" && record.report?.verified === true;
  const revisions = record.revisionHistory ?? [];
  const delivered = messages.find(
    (message) =>
      typeof message.id === "string" &&
      message.id.includes("_report") &&
      String(message.content ?? "").includes(record.id),
  );
  // A stage that was active when the task stopped is the one that failed or was blocked.
  const stoppedAt =
    unresolved && (record.timeline ?? []).findLast((e) => ORDER.includes(e.event))?.event;
  const statusOf = (key, done) =>
    done
      ? "done"
      : record.status === key
        ? "active"
        : stoppedAt === key && unresolved
          ? "stopped"
          : "not_started";

  const stages = [
    stage("received", "Received", "Alice accepted the request", "done", {
      startedAt: at(record, "accepted") ?? record.createdAt ?? null,
    }),
    stage(
      "planning",
      "Planning",
      "Planner defines the approach and checks the request",
      statusOf(
        "planning",
        reached(record, "collecting") || (record.planner && !AWAITING.has(record.status)),
      ),
      {
        startedAt: at(record, "planning"),
        finishedAt: at(record, "collecting"),
        worker: worker(attempt("planner"), runtime),
      },
    ),
    stage(
      "ready",
      "Ready to execute",
      "Plan accepted and required data source selected",
      reached(record, "collecting") ? "done" : "not_started",
      {
        startedAt: at(record, "collecting"),
      },
    ),
    stage(
      "executing",
      research ? "Researching" : "Executing",
      usesData
        ? research
          ? "Server web search and source retrieval"
          : "Approved data service reads the requested records"
        : "No data source required for this request",
      !usesData
        ? "not_applicable"
        : failedQuery
          ? "failed"
          : at(record, "query_result")
            ? "done"
            : at(record, "query_submitted")
              ? "active"
              : "not_started",
      {
        startedAt: at(record, "query_submitted"),
        finishedAt: lastAt(record, "query_result") ?? failedQuery?.at ?? null,
        executor: usesData ? "Agent Town data service (server)" : null,
        error: failedQuery?.detail ?? null,
      },
    ),
    stage(
      "evidence",
      "Evidence collected",
      "Source records persisted with evidence IDs",
      !usesData
        ? "not_applicable"
        : evidence.length
          ? "done"
          : at(record, "query_result")
            ? "empty"
            : "not_started",
      { count: evidence.length, finishedAt: at(record, "query_result") },
    ),
    stage(
      "analyzing",
      "Analyzing",
      "Analyst synthesizes the evidence",
      statusOf("analyzing", reached(record, "reviewing")),
      {
        startedAt: at(record, "analyzing"),
        finishedAt: at(record, "reviewing"),
        attempts: analystAttempts.length,
        worker: worker(attempt("analyst"), runtime),
      },
    ),
    stage(
      "reviewing",
      "Reviewing",
      "Critic checks the output against the evidence",
      statusOf("reviewing", record.status === "completed" || !!record.critic),
      {
        startedAt: at(record, "reviewing"),
        finishedAt: record.critic
          ? (lastAt(record, "completed") ?? lastAt(record, "unresolved"))
          : null,
        verdict: record.critic?.decision ?? null,
        reason: record.critic?.reason ?? null,
        worker: worker(attempt("critic"), runtime),
      },
    ),
    stage(
      "revision",
      "Revision required",
      "Critic sent the work back for correction",
      revisions.length
        ? analystAttempts.length > revisions.length
          ? "done"
          : "active"
        : "not_needed",
      {
        rounds: revisions.length,
        reasons: revisions.map((revision) => revision.critic?.reason ?? null),
      },
    ),
    stage(
      "delivering",
      "Delivering",
      "Alice posts the result in the office chat",
      delivered ? "done" : record.report ? "not_recorded" : "not_started",
      {
        finishedAt: delivered?.timestamp ?? null,
      },
    ),
  ];

  const diagnosis = unresolved ? diagnose(record.error) : null;
  const overall = AWAITING.has(record.status)
    ? "awaiting_input"
    : record.status === "conversation"
      ? "completed"
      : verified
        ? "completed"
        : record.status === "completed"
          ? "partially_completed"
          : unresolved
            ? diagnosis?.confirmed
              ? "blocked"
              : evidence.length || record.analysis
                ? "partially_completed"
                : "failed"
            : record.status === "ready"
              ? "queued"
              : "running";
  const mandatory = stages.filter((s) => !["not_applicable", "not_needed"].includes(s.status));
  const done = mandatory.filter((s) => s.status === "done").length;
  const criteria = (record.route?.successCriteria ?? []).map((description) => ({
    description,
    status: verified
      ? "passed"
      : record.status === "completed"
        ? "not_verified"
        : unresolved
          ? "not_met"
          : "pending",
  }));
  const workers = [attempt("planner"), attempt("analyst"), attempt("critic")]
    .map((a) => worker(a, runtime))
    .filter(Boolean);
  return {
    taskId: record.id,
    overall,
    composerStatus: record.status,
    progress: { done, total: mandatory.length },
    stages,
    criteria,
    independence: independence(workers),
    // Posting a reply is not the same as the work succeeding.
    delivery: {
      messageDelivered: !!delivered,
      deliveredAt: delivered?.timestamp ?? null,
      workVerified: verified,
    },
    diagnosis,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}
