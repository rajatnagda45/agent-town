import { expect, it } from "vitest";
import { deriveLifecycle, diagnose, independence } from "../server/task-lifecycle.mjs";

// Records shaped like persisted composer tasks; the runtime returns the dispatched tasks.
const T = (minute) => `2026-10-27T14:${String(minute).padStart(2, "0")}:00.000Z`;
const event = (name, minute, extra = {}) => ({
  at: T(minute),
  event: name,
  actor: "x",
  detail: name,
  ...extra,
});
const tasks = {
  "plan-1": {
    taskId: "plan-1",
    agentId: "main",
    sessionKey: "agent:main:planner",
    status: "completed",
    seatId: "plan",
  },
  "an-1": {
    taskId: "an-1",
    agentId: "main",
    sessionKey: "agent:main:analyst",
    status: "completed",
    seatId: "analyze",
  },
  "cr-1": {
    taskId: "cr-1",
    agentId: "main",
    sessionKey: "agent:main:critic",
    status: "running",
    seatId: "review",
    runId: "run-9",
  },
};
const runtime = {
  db: {
    getTask: (id) => tasks[id] ?? null,
    getSeat: (id) => ({ seatId: id, label: id, binding: { agentId: "main" } }),
  },
};
const attempt = (stage, taskId, role) => ({
  stage,
  taskId,
  role,
  seatId: tasks[taskId].seatId,
  executionDecision: {
    optionId: "nightshift",
    runtime: "nightshift",
    model: "gpt-4o-mini",
    reason: ["only eligible option"],
    rejected: [{ optionId: "openclaw", missing: ["No reviewed provider template"] }],
  },
});
const base = {
  id: "compose_demo",
  createdAt: T(0),
  updatedAt: T(9),
  route: {
    domain: "supplier_delivery",
    dataSources: ["SUPPLIER"],
    successCriteria: ["Reconcile PO-1042"],
  },
  attempts: [
    attempt("planner", "plan-1", "nightshift-planner"),
    attempt("analyst", "an-1", "nightshift-analyst"),
    attempt("critic", "cr-1", "nightshift-critic"),
  ],
  evidence: [{ evidenceId: "ev1" }, { evidenceId: "ev2" }],
  planner: { summary: "plan" },
  timeline: [
    event("accepted", 0),
    event("planning", 1),
    event("collecting", 2),
    event("query_submitted", 2),
    event("query_result", 3),
    event("analyzing", 4),
    event("reviewing", 6),
  ],
};
const statuses = (life) => Object.fromEntries(life.stages.map((s) => [s.id, s.status]));

it("derives each stage from persisted transitions while the critic is still reviewing", () => {
  const life = deriveLifecycle({ ...base, status: "reviewing" }, { runtime });
  expect(life.overall).toBe("running");
  expect(statuses(life)).toEqual({
    received: "done",
    planning: "done",
    ready: "done",
    executing: "done",
    evidence: "done",
    analyzing: "done",
    reviewing: "active",
    revision: "not_needed",
    delivering: "not_started",
  });
  // Progress counts only required stages that are actually done.
  expect(life.progress).toEqual({ done: 6, total: 8 });
  const critic = life.stages.find((s) => s.id === "reviewing").worker;
  expect(critic.selected.rejected[0]).toEqual({
    optionId: "openclaw",
    missing: ["No reviewed provider template"],
  });
  expect(critic.dispatched).toMatchObject({ agentId: "main", sessionKey: "agent:main:critic" });
  expect(critic.executed).toMatchObject({ agentId: "main", runId: "run-9" });
  expect(life.criteria).toEqual([{ description: "Reconcile PO-1042", status: "pending" }]);
});

it("warns when every stage ran on one backend agent, and never claims independence", () => {
  const life = deriveLifecycle({ ...base, status: "reviewing" }, { runtime });
  expect(life.independence.kind).toBe("same_agent_different_sessions");
  expect(life.independence.warning).toContain("not independent agents");
  const w = (agentId, sessionKey) => ({ dispatched: { agentId, sessionKey } });
  expect(independence([w("a", "s"), w("a", "s")]).kind).toBe("same_agent_same_session");
  expect(independence([w("a", "s1"), w("b", "s2")])).toEqual({
    kind: "distinct_agents",
    warning: null,
  });
  expect(independence([w("a", "s1")]).kind).toBe("unknown");
});

it("separates a delivered chat reply from verified work", () => {
  const report = {
    id: "group_bridge_t1_report",
    content: "Unverified / blocked · compose_demo",
    timestamp: T(8),
  };
  const blocked = deriveLifecycle(
    { ...base, status: "unresolved", error: "Zetaris POST query request timed out." },
    { runtime, messages: [report] },
  );
  expect(blocked.delivery).toEqual({
    messageDelivered: true,
    deliveredAt: T(8),
    workVerified: false,
  });
  expect(blocked.overall).toBe("blocked");
  expect(blocked.diagnosis).toMatchObject({ cause: "timeout", confirmed: true });
  expect(blocked.criteria[0].status).toBe("not_met");

  const done = deriveLifecycle(
    {
      ...base,
      status: "completed",
      critic: { decision: "ACCEPT", reason: "ok" },
      report: { verified: true },
      timeline: [...base.timeline, event("completed", 8)],
    },
    { runtime, messages: [{ ...report, content: "Verified report · compose_demo" }] },
  );
  expect(done.overall).toBe("completed");
  expect(done.progress).toEqual({ done: 8, total: 8 });
  expect(done.criteria[0].status).toBe("passed");
  // Completed but not verified is only partial.
  expect(
    deriveLifecycle({ ...base, status: "completed", report: { verified: false } }, { runtime })
      .overall,
  ).toBe("partially_completed");
});

it("reports blocked, failed and partial outcomes with known or unresolved causes", () => {
  expect(
    diagnose("Blocked: PO-9999 has no purchase order, receipt, shipment or supplier records"),
  ).toMatchObject({
    cause: "insufficient_data",
    confirmed: true,
  });
  expect(diagnose("This seat has no available backend agent binding.").cause).toBe(
    "missing_binding",
  );
  expect(diagnose("Web search credentials were rejected.").cause).toBe("authentication_failure");
  const odd = diagnose("Something unexpected happened");
  expect(odd).toEqual({
    cause: "unresolved",
    confirmed: false,
    observed: "Something unexpected happened",
  });
  const noWork = deriveLifecycle(
    {
      ...base,
      status: "unresolved",
      error: "Something unexpected happened",
      evidence: [],
      attempts: [],
      planner: undefined,
      timeline: [event("accepted", 0), event("planning", 1), event("unresolved", 2)],
    },
    { runtime },
  );
  expect(noWork.overall).toBe("failed");
  expect(statuses(noWork).planning).toBe("stopped");
  const partial = deriveLifecycle(
    { ...base, status: "unresolved", error: "Something unexpected happened" },
    { runtime },
  );
  expect(partial.overall).toBe("partially_completed");
});

it("shows a failed query and a real revision only when they were recorded", () => {
  const failed = deriveLifecycle(
    {
      ...base,
      status: "unresolved",
      error: "Zetaris POST query request failed (401: unauthorized).",
      evidence: [],
      timeline: [
        ...base.timeline.slice(0, 4),
        event("query_failed", 3, { detail: "LIVE Zetaris: unauthorized" }),
      ],
    },
    { runtime },
  );
  expect(statuses(failed).executing).toBe("failed");
  expect(failed.stages.find((s) => s.id === "executing").error).toContain("unauthorized");
  expect(failed.diagnosis.cause).toBe("authentication_failure");
  const revised = deriveLifecycle(
    {
      ...base,
      status: "reviewing",
      attempts: [...base.attempts, attempt("analyst", "an-1", "nightshift-analyst")],
      revisionHistory: [{ critic: { decision: "REVISE", reason: "Shipments show 15 in transit" } }],
    },
    { runtime },
  );
  expect(revised.stages.find((s) => s.id === "revision")).toMatchObject({
    status: "done",
    rounds: 1,
  });
  expect(revised.stages.find((s) => s.id === "analyzing").attempts).toBe(2);
  expect(statuses(deriveLifecycle({ ...base, status: "reviewing" }, { runtime })).revision).toBe(
    "not_needed",
  );
});

it("marks stages without data, input waits and unrecorded delivery honestly", () => {
  const draft = deriveLifecycle(
    {
      ...base,
      route: { dataSources: [], successCriteria: [] },
      evidence: [],
      status: "needs_clarification",
      timeline: [event("accepted", 0)],
    },
    { runtime },
  );
  expect(draft.overall).toBe("awaiting_input");
  expect(statuses(draft).executing).toBe("not_applicable");
  expect(statuses(draft).evidence).toBe("not_applicable");
  const saved = deriveLifecycle(
    { ...base, status: "completed", report: { verified: true } },
    { runtime },
  );
  expect(statuses(saved).delivering).toBe("not_recorded");
});
