import { afterEach, describe, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { NightshiftGateway } from "../server/nightshift-gateway.mjs";
import { createNightshiftEnforcement } from "../server/nightshift-enforcement.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { OfficeGroupChat, OFFICE_GROUP_SESSION } from "../server/office-group-chat.mjs";
import { TeamLead, validateDecomposition } from "../server/team-lead.mjs";

// Fake HTTP model behind the real Nightshift gateway: wiring evidence, not live acceptance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const json = (value: unknown) => new Response(JSON.stringify(value));
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

const split = {
  tasks: [
    {
      id: "readings",
      title: "Tank readings",
      assignment: "Summarize the tank refill time change from the supplied pump log.",
      capability: "analysis",
      dependsOn: [],
    },
    {
      id: "limits",
      title: "Operating limits",
      assignment: "Compare the refill change with the pump manual operating limits and flag risks.",
      capability: "analysis",
      dependsOn: ["readings"],
    },
  ],
};

function deliverable(message: string, content: string, extra: Data = {}) {
  const fingerprint = /"goalFingerprint":"([a-f0-9]{64})"/.exec(message)?.[1];
  const deliverableId = /"deliverableId":"([^"]+)"/.exec(message)?.[1];
  return JSON.stringify({
    goalFingerprint: fingerprint,
    deliverableId,
    status: "completed",
    content,
    evidenceIds: [],
    uncertainty: [],
    ...extra,
  });
}

async function office(
  plans: unknown[],
  verdict = "ACCEPT",
  echoFirst = false,
  leadOptions: Data = {},
) {
  let echoed = false;
  let reviewIndex = 0;
  const prompts: Array<{ role: string; message: string; turns: number }> = [];
  let planIndex = 0;
  const { failOnce, ...teamOptions } = leadOptions;
  let failed = false;
  const gateway = new NightshiftGateway({
    baseUrl: "http://127.0.0.1:8088/v1",
    apiKey: "mock-token",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content);
      const message = String(body.messages.at(-1).content);
      const role = /the (planner|analyst|critic) in/.exec(system)?.[1] ?? "unknown";
      prompts.push({ role, message, turns: body.messages.length });
      // A definite provider rejection the first time a matching assignment runs.
      if (failOnce && message.includes(failOnce) && !failed) {
        failed = true;
        return new Response("request rejected", { status: 400 });
      }
      let content: string;
      if (message.startsWith("Team Lead planner"))
        content = JSON.stringify(plans[Math.min(planIndex++, plans.length - 1)]);
      else if (message.startsWith("Synthesis"))
        content = deliverable(
          message,
          "Refill doubled to 70 minutes, above the 45-minute manual limit.",
        );
      else if (message.startsWith("Revision of"))
        content = deliverable(
          message,
          "Refill doubled to 70 minutes; manual limit 45 minutes (cited).",
        );
      else if (message.startsWith("Independent review")) {
        const verdicts = verdict.split(",");
        const current = verdicts[Math.min(reviewIndex++, verdicts.length - 1)];
        content = deliverable(message, current === "ACCEPT" ? "Supported." : "Unsupported limit.", {
          verdict: current,
        });
      } else if (message.includes("tank refill time") && echoFirst && !echoed) {
        // The live failure: the model echoed its assignment instead of answering.
        echoed = true;
        content = message.split("Canonical assignment")[1] ?? message;
      } else if (message.includes("tank refill time"))
        content = deliverable(message, "Refill time rose from 35 to 70 minutes after the service.");
      else content = deliverable(message, "The manual allows at most 45 minutes at 3 bar inlet.");
      return json({ model: "meterless/auto", choices: [{ message: { content } }] });
    },
  });
  const db = new TaskDatabase(":memory:");
  const runtime: Data = new TaskRuntime({ db, gateway, gatewayId: "nightshift-team" });
  cleanup.push(() => db.close());
  cleanup.push(() => runtime.close());
  await gateway.start();
  await runtime.refresh();
  for (const seatId of ["plan", "analyze", "review"])
    runtime.saveSeat({ seatId, label: seatId, seatType: "worker", assigned: true, revision: 0 });
  const grants = ["planner", "analyst", "critic"].map((role, index) => ({
    manifestId: `nightshift-${role}`,
    seatId: ["plan", "analyze", "review"][index],
    sessionKey: `agent:main:nightshift-${role}-context0${index + 1}`,
  }));
  const operations = new OfficeOperations(runtime, {
    specialists: { grants, enforcement: createNightshiftEnforcement(runtime) },
  });
  cleanup.push(() => operations.close());
  runtime.operations = operations;
  const events: Array<{ stage: string; text: string }> = [];
  const lead = new TeamLead(runtime, {
    ...teamOptions,
    autoStart: false,
    onEvent: (_run: Data, stage: string, text: string) => events.push({ stage, text }),
  });
  cleanup.push(() => lead.close());
  const drive = async (
    id: string,
    until: (run: Data) => boolean = (run) =>
      ["completed", "unresolved", "stalled"].includes(run.status),
  ) => {
    const end = Date.now() + 8000;
    let run = lead.get(id);
    while (!until(run) && Date.now() < end) {
      await pause();
      run = lead.advance(id);
    }
    return run;
  };
  return { db, runtime, operations, lead, prompts, events, drive };
}

describe("Team Lead work distribution adapted from hermes-agent", () => {
  it("rejects splits that repeat work, cycle, reuse ids or name unknown capabilities", () => {
    const base = split.tasks[0];
    const check = (tasks: unknown[]) => validateDecomposition({ tasks }).issues.join(" ");
    expect(check([base, { ...base, id: "copy" }])).toContain("repeat each other");
    expect(
      check([
        { ...base, dependsOn: ["b"] },
        { ...split.tasks[1], id: "b", dependsOn: ["readings"] },
      ]),
    ).toContain("cycle");
    expect(check([{ ...base, id: "synthesis" }])).toContain("reserved");
    expect(check([{ ...base, capability: "deploy" }])).toContain("capability must be one of");
    expect(check([{ ...base, dependsOn: ["ghost"] }])).toContain('unknown task "ghost"');
    expect(check(Array.from({ length: 6 }, (_, i) => ({ ...base, id: `t${i}` })))).toContain(
      "1–5 tasks",
    );
    expect(validateDecomposition(split).issues).toEqual([]);
  });

  it("splits a goal, hands each result to its dependents, synthesizes, and passes review", async () => {
    const t = await office([split]);
    const started = t.lead.start({ requestId: "pump-1", goal: "Explain the slow tank refill" });
    expect(started.status).toBe("planning");
    expect(t.lead.start({ requestId: "pump-1", goal: "Explain the slow tank refill" }).id).toBe(
      started.id,
    );
    const run = await t.drive(started.id);
    expect(run).toMatchObject({ status: "completed" });
    expect(run.answer).toContain("45-minute manual limit");
    expect(run.assignments.map((item: Data) => item.role)).toEqual([
      "nightshift-analyst",
      "nightshift-analyst",
    ]);
    // Each teammate is told only its own assignment and what the others cover.
    const limits = t.prompts.find((p) => p.message.includes("manual operating limits"))!;
    expect(limits.message).toContain('Other teammates handle: ["Tank readings"]');
    // The dependent teammate receives the dependency's validated handoff, fenced as agent output.
    expect(limits.message).toContain('untrusted_source source="agent:readings"');
    expect(limits.message).toContain("35 to 70 minutes");
    const synthesis = t.prompts.find((p) => p.message.startsWith("Synthesis"))!;
    expect(synthesis.message).toContain("agent:readings");
    expect(synthesis.message).toContain("agent:limits");
    const board = t.lead.view(started.id).team;
    expect(board.members.map((m: Data) => [m.nodeId, m.phase])).toEqual([
      ["readings", "completed"],
      ["limits", "completed"],
      ["synthesis", "completed"],
      ["review", "completed"],
    ]);
    expect(t.events.map((e) => e.stage)).toEqual(["team-assigned", "team-done"]);
    // The planner seat ran three role tasks; none replayed the seat's earlier drafts.
    expect(t.prompts.filter((p) => p.role === "planner").length).toBeGreaterThanOrEqual(2);
    expect(t.prompts.every((p) => p.turns === 2)).toBe(true);
  });

  it("corrects an invalid split once using only the server's issues", async () => {
    const duplicate = { tasks: [split.tasks[0], { ...split.tasks[0], id: "again" }] };
    const t = await office([duplicate, split]);
    const run = await t.drive(t.lead.start({ requestId: "repair", goal: "Explain the refill" }).id);
    expect(run.status).toBe("completed");
    const planners = t.prompts.filter((p) => p.message.startsWith("Team Lead planner"));
    expect(planners).toHaveLength(2);
    expect(planners[1].message).toContain("repeat each other");
  });

  it("does not report success when the independent review rejects the answer", async () => {
    const t = await office([split], "REVISE");
    const run = await t.drive(t.lead.start({ requestId: "reject", goal: "Explain the refill" }).id);
    expect(run.status).toBe("unresolved");
    expect(run.reason).toContain("Review did not accept");
    // Exactly two bounded revisions ran before the verdict stood.
    expect(run.revisionRound).toBe(2);
    expect(run.reviewHistory).toHaveLength(2);
    expect(t.prompts.filter((p) => p.message.startsWith("Revision of"))).toHaveLength(2);
    expect(t.prompts.filter((p) => p.message.startsWith("Independent review"))).toHaveLength(3);
  });

  it("transfers failed work to another attempt and keeps a ledger until it completes", async () => {
    const t = await office([split], "ACCEPT", false, { failOnce: "manual operating limits" });
    const run = await t.drive(
      t.lead.start({ requestId: "transfer", goal: "Explain the refill" }).id,
    );
    expect(run.status).toBe("completed");
    expect(run.transfers).toEqual([
      expect.objectContaining({ nodeId: "limits", fromRole: "nightshift-analyst" }),
    ]);
    expect(run.workIncidentId).toBe(`${run.id}_transfer1`);
    expect(run.ledger.map((entry: Data) => entry.event)).toEqual([
      "assigned",
      "transferred",
      "completed",
    ]);
    // The finished "readings" result is carried to the moved task, not redone.
    const moved = t.prompts.filter((p) => p.message.includes("manual operating limits"));
    expect(moved.at(-1)!.message).toContain("carried over by the office lead");
    expect(t.prompts.filter((p) => p.message.includes("tank refill time change"))).toHaveLength(1);
    expect(t.events.some((event) => event.stage === "team-transfer-1")).toBe(true);
  });

  it("delivers Lead guidance to pending work, records missed guidance, and stops without killing", async () => {
    const t = await office([split]);
    const id = t.lead.start({ requestId: "steer", goal: "Explain the refill" }).id;
    const working = await t.drive(id, (run) => run.status === "working");
    const orchestration = t.operations.orchestration;
    expect(
      orchestration.steer({
        incidentId: working.workIncidentId,
        nodeId: "limits",
        message: "Quote the manual page.",
      }),
    ).toMatchObject({ status: "queued" });
    // Stop the review before it can run; nothing in flight is cancelled.
    expect(
      orchestration.stop({
        incidentId: working.workIncidentId,
        nodeId: "review",
        reason: "operator",
      }),
    ).toMatchObject({ status: "stopped" });
    const run = await t.drive(id);
    expect(t.prompts.find((p) => p.message.includes("manual operating limits"))!.message).toContain(
      'Guidance from the Team Lead: ["Quote the manual page."]',
    );
    expect(t.prompts.some((p) => p.message.startsWith("Independent review"))).toBe(false);
    expect(run.status).toBe("unresolved");
    expect(run.reason).toContain("Stopped by the Team Lead: operator");
    // Guidance for work that already ran is recorded as missed, never silently dropped.
    expect(
      orchestration.steer({
        incidentId: working.workIncidentId,
        nodeId: "readings",
        message: "Too late",
      }),
    ).toMatchObject({ status: "missed", phase: "completed" });
    expect(orchestration.team(working.workIncidentId).members[0].missedSteers).toBe(1);
  });

  it("starts from group chat and posts the Lead's progress back into the conversation", async () => {
    const t = await office([split]);
    const chat = new OfficeGroupChat(t.runtime);
    cleanup.push(() => chat.close());
    t.runtime.teamLead = t.lead;
    t.lead.onEvent = (run: Data, stage: string, text: string) => {
      if (run.groupTurnId) chat.post({ groupTurnId: run.groupTurnId }, stage, text);
    };
    chat.send({ turnId: "team1", message: "assign the team to explain the slow tank refill" });
    const end = Date.now() + 2000;
    while (!t.lead.all().length && Date.now() < end) await pause();
    await t.drive(t.lead.all()[0].id);
    const posts = t.db
      .messages(OFFICE_GROUP_SESSION)
      .filter((m: Data) => m.groupTurnId === "team1" && m.role === "assistant")
      .map((m: Data) => m.content);
    expect(posts[0]).toContain("Team Lead is splitting the work");
    expect(posts.some((text: string) => text.startsWith("Team Lead assigned 2 tasks"))).toBe(true);
    expect(posts.some((text: string) => text.startsWith("Team result (review: ACCEPT)"))).toBe(
      true,
    );
  });

  it("repairs a teammate that echoed its assignment, once, then completes", async () => {
    const t = await office([split], "ACCEPT", true);
    const run = await t.drive(t.lead.start({ requestId: "echo", goal: "Explain the refill" }).id);
    expect(run.status).toBe("completed");
    const readings = t.prompts.filter((p) => p.message.includes("tank refill time"));
    expect(readings).toHaveLength(2);
    expect(readings[1].message).toContain("Repair request");
    expect(readings[1].message).toContain("Return ONLY one JSON object");
  });

  it("explains a run held by an outcome-unknown task and marks it stalled without retrying", async () => {
    let now = Date.parse("2026-10-27T00:00:00Z");
    const t = await office([split], "ACCEPT", false, { now: () => now, stallMs: 60_000 });
    // A leftover attempt whose outcome is unknown keeps the shared agent busy by design.
    t.db.insertTask({
      taskId: "orphan-unknown",
      gatewayId: "nightshift-team",
      agentId: "main",
      seatId: "analyze",
      sessionKey: "agent:main:nightshift-analyst-context02",
      status: "outcome_unknown",
      createdAt: "2026-10-26T23:00:00Z",
    });
    const id = t.lead.start({ requestId: "held", goal: "Explain the refill" }).id;
    t.lead.advance(id);
    const plan = t.operations.orchestration.get(t.lead.get(id).planIncidentId);
    expect(plan.children[0].waitReason).toContain(
      "unknown outcome that needs operator review (orphan-unknown)",
    );
    expect(t.prompts.filter((p) => p.message.startsWith("Team Lead planner"))).toHaveLength(0);
    now += 61_000;
    const run = t.lead.advance(id);
    expect(run.status).toBe("stalled");
    expect(run.reason).toContain("orphan-unknown");
    expect(t.db.getTask("orphan-unknown").status).toBe("outcome_unknown");
  });

  it("revises once with the reviewer's reasons and completes when the second review accepts", async () => {
    const t = await office([split], "REVISE,ACCEPT");
    const run = await t.drive(t.lead.start({ requestId: "revise", goal: "Explain the refill" }).id);
    expect(run.status).toBe("completed");
    expect(run.reason).toContain("revised answer");
    expect(run.answer).toContain("(cited)");
    const revision = t.prompts.find((p) => p.message.startsWith("Revision of"))!;
    expect(revision.message).toContain('untrusted_source source="agent:review"');
    expect(revision.message).toContain("Unsupported limit.");
    expect(t.events.map((e) => e.stage)).toEqual(["team-assigned", "team-revise-1", "team-done"]);
  });

  it("uses the second revision round and completes when the third review accepts", async () => {
    const t = await office([split], "REVISE,REVISE,ACCEPT");
    const run = await t.drive(
      t.lead.start({ requestId: "revise-2", goal: "Explain the refill" }).id,
    );
    expect(run.status).toBe("completed");
    expect(run.revisionRound).toBe(2);
    expect(t.events.map((e) => e.stage)).toEqual([
      "team-assigned",
      "team-revise-1",
      "team-revise-2",
      "team-done",
    ]);
    expect(t.events[2].text).toContain("revision 2 of 2");
  });
});
