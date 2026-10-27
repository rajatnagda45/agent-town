import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { runtimeStorage } from "../server/runtime-storage.mjs";
import { ExecutionRouter } from "../server/execution-router.mjs";
import {
  contentSimilarity,
  goalFingerprint,
  inferDeliverable,
  reviewSignals,
  validateDeliverables,
  validateWorkerResult,
  weakensContract,
} from "../server/deliverable-validation.mjs";

const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const incident = {
  incidentId: "agenda",
  goal: "Plan a 30-minute pump review",
  constraints: ["30 minutes"],
  acceptanceCriteria: [{ criterionId: "time", description: "Exactly 30 minutes" }],
};
const deliverable = { id: "agenda", description: "Meeting agenda", kind: "agenda", minutes: 30 };
const output = (minutes = 20) => ({
  goalFingerprint: goalFingerprint(incident),
  deliverableId: "agenda",
  status: "completed",
  content: "Review pump readings and agree the next measurement.",
  uncertainty: [],
  evidenceIds: [],
  agenda: [
    { title: "Readings", minutes: 10 },
    { title: "Next measurement", minutes },
  ],
});
const check = (value) =>
  validateWorkerResult({ incident, deliverable, result: JSON.stringify(value) });

it("rejects a 35-minute agenda claiming a 30-minute outcome, accepting the corrected arithmetic", () => {
  expect(check(output(25))).toMatchObject({
    pass: false,
    issues: ["Agenda totals 35 minutes; required 30."],
  });
  expect(check(output())).toMatchObject({ pass: true });
  expect(check({ ...output(), agenda: [{ title: "Invalid", minutes: -1 }] }).pass).toBe(false);
});

it("requires the canonical requirements, assigned deliverable, uncertainty and persisted citations", () => {
  for (const patch of [
    { goalFingerprint: goalFingerprint({ ...incident, goal: "Build an AI tutor" }) },
    { deliverableId: "other-worker" },
    { uncertainty: undefined },
    { evidenceIds: ["invented"] },
    { status: "unresolved" },
  ])
    expect(check({ ...output(), ...patch }).pass).toBe(false);
});

it("allows duplicate deliverables only with an explicit independent contribution reason", () => {
  expect(() => validateDeliverables([{ deliverable }, { deliverable }])).toThrow(/Duplicate/);
  expect(() =>
    validateDeliverables([
      { deliverable },
      { deliverable: { ...deliverable, duplicateReason: "Independent arithmetic review" } },
    ]),
  ).not.toThrow();
});

it("rejects generated research citations, expired evidence and evidence from a different incident", () => {
  const spec = { ...deliverable, kind: "research" };
  const source = {
    evidenceId: "source-1",
    incidentId: incident.incidentId,
    source: "manual",
    recordId: "page-4",
    sourceTimestamp: new Date().toISOString(),
  };
  const validate = (evidence) =>
    validateWorkerResult({
      incident,
      deliverable: spec,
      result: JSON.stringify({ ...output(), evidenceIds: [source.evidenceId] }),
      evidence,
    });
  expect(validate([source]).pass).toBe(true);
  expect(validate([]).pass).toBe(false);
  expect(validate([{ ...source, incidentId: "other" }]).pass).toBe(false);
  expect(validate([{ ...source, freshUntil: "2000-01-01" }]).pass).toBe(false);
});

it("infers exact, maximum, minimum and segmented durations and asks when totals conflict", () => {
  const infer = (goal) => inferDeliverable(goal);
  expect(infer("Create a 30-minute Agent Town demo agenda").deliverable).toMatchObject({
    minutes: 30,
    mode: "exact",
  });
  expect(infer("Half-hour workshop agenda").deliverable).toMatchObject({ minutes: 30 });
  expect(infer("Plan a demo under 30 minutes").deliverable.mode).toBe("max");
  expect(infer("A demo of at least 20 minutes").deliverable.mode).toBe("min");
  expect(infer("30-minute demo with a 5-minute Q&A").deliverable.requiredSegments).toEqual([
    { label: "Q&A", minutes: 5 },
  ]);
  expect(infer("A 30 minute talk or a 45 minute talk").clarification).toContain(
    "30 minutes and 45",
  );
  expect(infer("20-minute demo with a 25-minute Q&A").clarification).toContain("more than");
  expect(infer("Summarize the supplied manual")).toEqual({
    deliverable: null,
    clarification: null,
  });
});

it("applies maximum and segment contracts, and detects a caller loosening the stated limit", () => {
  const max = { ...deliverable, mode: "max" };
  const total = (minutes) =>
    validateWorkerResult({ incident, deliverable: max, result: JSON.stringify(output(minutes)) });
  expect(total(15).pass).toBe(true);
  expect(total(25).issues).toContain("Agenda totals 35 minutes; maximum 30.");
  const segmented = { ...deliverable, requiredSegments: [{ label: "Q&A", minutes: 5 }] };
  expect(
    validateWorkerResult({ incident, deliverable: segmented, result: JSON.stringify(output()) })
      .issues,
  ).toContain("Agenda needs a 5-minute Q&A section.");
  const inferred = { kind: "agenda", minutes: 30, mode: "max" };
  expect(weakensContract({ kind: "agenda", minutes: 25 }, inferred)).toBe(false);
  expect(weakensContract({ kind: "agenda", minutes: 35, mode: "max" }, inferred)).toBe(true);
  expect(weakensContract({ kind: "report" }, inferred)).toBe(true);
});

it("reports topic and similarity as signals that a keyword-stuffed answer can still satisfy", () => {
  const signals = reviewSignals({
    goal: "Create a 30-minute Agent Town demo agenda",
    content: "Agent Town is an AI tutor with personalized curricula.",
  });
  expect(signals.missingTopicTerms).toEqual([]);
  expect(signals.note).toContain("neither prove nor disprove");
  expect(contentSimilarity("a b c d e", "a b c d e")).toBe(1);
  expect(contentSimilarity("pump refill doubled after service", "manual limits at three bar")).toBe(
    0,
  );
});

function routing({ preference = [] } = {}) {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const make = (id, provider, modelProvider, tools, primary = false) => {
    const runtime = {
      db: primary ? db : runtimeStorage(db, id),
      gatewayId: id,
      agentsReady: true,
      gateway: { status: "connected", provider },
    };
    const assignment = {
      gatewayId: id,
      sessionKey: `agent:${id}:main`,
      agentId: id,
      seatId: id,
      bindingRevision: 1,
    };
    const registry = {
      runtime,
      selectTask: () => ({ status: "assigned", manifest: { id: "research" }, assignment }),
      assign: () => ({ status: "assigned", assignment }),
      dispatchOrchestration: () => {
        throw new Error("Selection must never dispatch");
      },
    };
    const discovered = {
      gatewayId: id,
      sessionKey: assignment.sessionKey,
      authenticated: true,
      checkedAt: 1000,
      modelProvider,
      model: modelProvider ? `${modelProvider}/model-a` : undefined,
      tools,
      capabilities: ["research"],
      permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
      outputSchemas: ["research_v1"],
    };
    const option = { id, registry, discovered, snapshot: () => discovered, authorized: true };
    option.authorize = ({ task }) => option.authorized && typeof task?.message === "string";
    return option;
  };
  // Nightshift is a gateway; its upstream model provider is unknown until verified.
  const nightshift = make("sponsor", "nightshift", undefined, [], true);
  const openclaw = make("tools", "openclaw", "openai", ["web_search"]);
  const options = [nightshift, openclaw];
  const router = new ExecutionRouter(nightshift.registry, options, { now: () => 1000, preference });
  const requirements = {
    capabilities: ["research"],
    tools: ["web_search"],
    permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
    outputSchema: "research_v1",
  };
  const task = { taskId: "t1", message: "Find the pump manual", retryCount: 0 };
  return { db, router, requirements, nightshift, openclaw, task };
}

it("selects the only eligible runtime without a fallback flag and explains rejected options", () => {
  const { router, requirements, task } = routing();
  const selected = router.selectTask({ requirements, task });
  expect(selected).toMatchObject({
    status: "assigned",
    executionDecision: {
      optionId: "tools",
      runtime: "openclaw",
      modelProvider: "openai",
      model: "openai/model-a",
      preferenceMatched: null,
      authorization: "verified_for_task",
    },
  });
  expect(selected.executionDecision.reason[0]).toContain("only eligible option");
  expect(selected.executionDecision.rejected).toEqual([
    { optionId: "sponsor", missing: ["tool web_search"] },
  ]);
});

it("keeps runtime and upstream model identity separate", () => {
  const { router, requirements, task, nightshift } = routing();
  nightshift.discovered.tools = ["web_search"];
  const required = { ...requirements, requiredRuntime: "nightshift" };
  expect(router.selectTask({ requirements: required, task }).executionDecision).toMatchObject({
    runtime: "nightshift",
    modelProvider: "unknown",
    model: null,
  });
  expect(
    router.selectTask({ requirements: { ...required, requiredModelProvider: "openai" }, task })
      .reason,
  ).toContain("verified model provider identity");
});

it("never relaxes explicit runtime, model or legacy fallback restrictions", () => {
  const { router, requirements, task, nightshift } = routing();
  const select = (patch) =>
    router.selectTask({ requirements: { ...requirements, ...patch }, task });
  expect(select({ requiredRuntime: "nightshift" }).status).toBe("no_eligible_agent");
  expect(select({ allowedRuntimes: ["nightshift"] }).reason).toContain(
    "not allowed by task policy",
  );
  expect(select({ preferredRuntime: "nightshift", allowFallback: false }).reason).toContain(
    "restricts execution to its preferred provider",
  );
  expect(() => select({ allowFallback: false })).toThrow(/no target/);
  nightshift.discovered.tools = ["web_search"];
  expect(
    select({ preferredRuntime: "openclaw", allowFallback: false }).executionDecision,
  ).toMatchObject({ runtime: "openclaw", preferenceMatched: true });
});

it("ranks eligible options by task hint, then configured preference, with no built-in default", () => {
  const { router, requirements, task, nightshift } = routing();
  nightshift.discovered.tools = ["web_search"];
  // Without any preference, ties break on option ID only.
  expect(router.selectTask({ requirements, task }).executionDecision.optionId).toBe("sponsor");
  const configured = routing({ preference: ["openclaw"] });
  configured.nightshift.discovered.tools = ["web_search"];
  const decision = configured.router.selectTask({ requirements, task }).executionDecision;
  expect(decision.runtime).toBe("openclaw");
  expect(decision.reason.join(" ")).toContain("configured preference position 1");
  expect(
    configured.router.selectTask({
      requirements: { ...requirements, preferredRuntime: "nightshift" },
      task,
    }).executionDecision,
  ).toMatchObject({ runtime: "nightshift", preferenceMatched: true });
});

it("requires per-task enforcement evidence rather than an adapter's presence", () => {
  const { router, requirements, task, openclaw } = routing();
  expect(router.selectTask({ requirements }).reason).toContain("enforced tool and time budgets");
  openclaw.authorized = false;
  expect(router.selectTask({ requirements, task }).reason).toContain(
    "enforced tool and time budgets",
  );
  openclaw.authorized = true;
  delete openclaw.authorize;
  expect(router.selectTask({ requirements, task }).status).toBe("no_eligible_agent");
  expect(router.selectTask({ requirements, preflight: true }).executionDecision).toMatchObject({
    authorization: "deferred_to_dispatch",
  });
});

it("does not mistake a healthy model or a manifest for actual tool permission", () => {
  const { router, requirements, openclaw, task } = routing();
  openclaw.discovered.tools = [];
  expect(router.selectTask({ requirements, task }).reason).toContain("tool web_search");
  openclaw.discovered.tools = ["web_search"];
  openclaw.discovered.checkedAt = -30001;
  expect(router.selectTask({ requirements, task }).reason).toContain(
    "current capability discovery",
  );
});

it("labels measured completion as execution completion, never answer quality", () => {
  const { router, requirements, task, db } = routing();
  for (let i = 0; i < 5; i++)
    db.insertTask({
      taskId: `done-${i}`,
      gatewayId: "tools",
      sessionKey: "agent:tools:main",
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
    });
  const decision = router.selectTask({ requirements, task }).executionDecision;
  expect(decision.metrics).toMatchObject({ samples: 5, completionRate: 1 });
  expect(decision.reason.join(" ")).toContain("completion, not answer quality");
});

it("pins an existing assignment rather than routing an unavailable or uncertain attempt elsewhere", () => {
  const { router, requirements, openclaw, nightshift, task } = routing();
  const selected = router.selectTask({ requirements, task });
  openclaw.registry.runtime.gateway.status = "disconnected";
  nightshift.discovered.tools = ["web_search"];
  expect(router.selectTask({ requirements, task, pinned: selected.assignment }).status).toBe(
    "no_eligible_agent",
  );
});

it("isolates native session/message IDs and replayed events across adapter recreation", () => {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const a = runtimeStorage(db, "a");
  const b = runtimeStorage(db, "b");
  a.saveSeat({ seatId: "Alice", binding: { agentId: "main" } });
  a.saveMessage({ id: "same", sessionKey: "agent:main:main", content: "a" });
  b.saveMessage({ id: "same", sessionKey: "agent:main:main", content: "b" });
  expect(db.getSeat("Alice")).toBeNull();
  expect(b.getSeat("Alice")).toBeNull();
  expect(runtimeStorage(db, "a").getMessage("same").content).toBe("a");
  expect(b.messages("agent:main:main")[0].content).toBe("b");
  const cursor = db.cursor();
  a.publish(a.emit("management", { agents: [] }));
  expect(db.replay(cursor).map((event) => event.kind)).toEqual(["execution.a.management"]);
});

it("opens a circuit after consecutive failures, routes around it, then recloses after cooldown", () => {
  const { db, requirements, task, nightshift } = routing();
  nightshift.discovered.tools = ["web_search"];
  const fail = (i, at) =>
    db.insertTask({
      taskId: `fail-${i}`,
      gatewayId: "tools",
      sessionKey: "agent:tools:main",
      status: "failed",
      createdAt: at,
      completedAt: at,
    });
  fail(1, "1970-01-01T00:00:00.100Z");
  fail(2, "1970-01-01T00:00:00.200Z");
  fail(3, "1970-01-01T00:00:00.300Z");
  let now = 1000;
  const options = [nightshift, routing().openclaw];
  // Rebuild the OpenClaw option over the same database so it sees the failures.
  options[1].registry.runtime.db = runtimeStorage(db, "tools");
  options[1].registry.runtime.gatewayId = "tools";
  const router = new ExecutionRouter(nightshift.registry, options, {
    now: () => now,
    preference: ["openclaw"],
    cooldownMs: 5000,
  });
  const open = router.selectTask({ requirements, task });
  expect(open.executionDecision.runtime).toBe("nightshift");
  expect(open.executionDecision.rejected[0].missing[0]).toContain(
    "circuit open after 3 consecutive failures",
  );
  // Once the cooldown has elapsed the option is eligible again.
  now = 6000;
  expect(router.selectTask({ requirements, task }).executionDecision.runtime).toBe("openclaw");
});
