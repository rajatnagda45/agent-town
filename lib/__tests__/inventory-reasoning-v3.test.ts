import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { createInventoryReader } from "../server/inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "../server/inventory-synthetic.mjs";
import { InventoryReasoningLoop } from "../server/inventory-reasoning-loop.mjs";
import { assertReasoningContract } from "../reasoning-contracts.mjs";
import { investigationView } from "../server/inventory-office-api.mjs";

// Real durable orchestration and SQLite; mocked execution and explicitly synthetic rows.
class Gateway {
  provider = "openclaw";
  status = "connected";
  audit = new ContractAudit(fixture);
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  subscribe() {
    return () => {};
  }
  stop() {
    this.status = "disconnected";
  }
  capabilities() {
    return this.audit.capabilities(this.hello, true);
  }
  request(method: string) {
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: ["planner", "analyst", "critic"].map((id) => ({ id })),
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}
const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const criteria = {
  scenarioId: "complete",
  sku: "SKU-901",
  locationId: "DEPOT-Z",
  ledgerQuantity: 22,
  physicalQuantity: 19,
  maxUnexplainedUnits: 0,
};
async function setup(filename = ":memory:") {
  const db = new TaskDatabase(filename);
  const runtime = new TaskRuntime({ db, gateway: new Gateway(), gatewayId: "reasoning-v3" });
  await runtime.refresh();
  for (const role of ["planner", "analyst", "critic"])
    if (!db.getSeat(role))
      runtime.saveSeat({
        seatId: role,
        label: role,
        assigned: true,
        seatType: "agent",
        agentConfig: { agentId: role },
        revision: 0,
      });
  const sources = Object.fromEntries(
    ["complete", "incomplete", "conflicting", "stale", "missing", "post_count"].map((scenario) => [
      scenario,
      createSyntheticDataSource(
        createSyntheticInventoryFixtures(scenario, {
          sku: criteria.sku,
          locationId: criteria.locationId,
          openingQuantity: 20,
          countedQuantity: 19,
        }),
      ),
    ]),
  );
  const reader = createInventoryReader({
    mode: "synthetic",
    synthetic: {
      query(input: { templateId: string; parameters: { scenarioId: string } }) {
        return sources[input.parameters.scenarioId].query(input);
      },
    },
  });
  const operations = new OfficeOperations(runtime, {
    dataReader: reader,
    specialists: {
      grants: [
        { manifestId: "planner", seatId: "planner" },
        { manifestId: "data-steward-researcher", seatId: "analyst" },
        { manifestId: "critic", seatId: "critic" },
      ],
      enforcement: { authorizeSync: () => true },
    },
  });
  Object.assign(runtime, { operations });
  const loop = new InventoryReasoningLoop(operations);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      operations.close();
      runtime.close();
      db.close();
    }
  };
  cleanups.push(close);
  return { db, runtime, operations, loop, close };
}
type Context = Awaited<ReturnType<typeof setup>>;
const plan = (c: Context, id: string) => c.operations.orchestration.get(id);
const child = (c: Context, id: string, node: string) =>
  plan(c, id).children.find((t) => t.nodeId === node)!;
const start = (c: Context, id: string, scenarioId = "complete") =>
  c.loop.start({
    incidentId: id,
    goal: "Explain the inventory shortage using current evidence",
    criteria: { ...criteria, scenarioId },
    reasoningVersion: 3,
  });
async function result(c: Context, id: string, node: string, value: unknown) {
  c.db.updateTask(child(c, id, node).operation.taskId, {
    status: "completed",
    result: JSON.stringify(value),
  });
  await tick();
  c.operations.reconcile(id);
}
async function evidence(c: Context, id: string) {
  await result(c, id, "planner", {
    goal: plan(c, id).incident.goal,
    acceptanceCriteria: ["inventory-count", "inventory-reconciliation"],
    tasks: [
      { taskId: "reader", role: "data-steward-researcher", dependencies: ["planner"] },
      { taskId: "analyst", role: "data-steward-researcher", dependencies: ["reader"] },
      { taskId: "critic", role: "critic", dependencies: ["reader", "analyst"] },
    ],
  });
  c.loop.acceptPlanner(id);
  await result(c, id, "reader", { ready: true });
  await c.loop.collectEvidence(id);
}
function outputs(c: Context, id: string, decision: "ACCEPT" | "REVISE" | "UNCERTAIN" = "ACCEPT") {
  const bundle = c.loop.reasoning.validateBundle(plan(c, id));
  const missingEvidence =
    decision === "ACCEPT" ? [] : ["Seek source support for the remaining unit"];
  return {
    analysis: {
      bundleId: bundle.bundleId,
      primaryHypothesisId: "transfer-and-receipt",
      hypotheses: [
        {
          hypothesisId: "transfer-and-receipt",
          statement: "Applicable transfer and receipt records explain the supported shortage units",
          supportingEvidenceIds: bundle.checks.explanationEvidenceIds,
          contradictingEvidenceIds: [],
          missingEvidence,
          claimedExplainedUnits: bundle.checks.explained!,
        },
      ],
    },
    critic: {
      bundleId: bundle.bundleId,
      decision,
      hypothesisIds: ["transfer-and-receipt"],
      evidenceIds: bundle.checks.applicableEvidenceIds,
      reasoning: "Compared source timing, quantities and references",
      missingEvidence,
      nextTasks:
        decision === "REVISE"
          ? [
              {
                templateId: "inventory-receipts",
                parameters: bundle.scope,
                reason: "Find the missing receipt support",
              },
            ]
          : [],
    },
  };
}
async function complete(
  c: Context,
  id: string,
  decision: "ACCEPT" | "REVISE" | "UNCERTAIN" = "ACCEPT",
  mutate?: (v: ReturnType<typeof outputs>) => void,
) {
  await evidence(c, id);
  c.loop.confirmEvidence(id);
  expect(child(c, id, "analyst").attempts.length, JSON.stringify(child(c, id, "analyst"))).toBe(1);
  const out = outputs(c, id, decision);
  mutate?.(out);
  await result(c, id, "analyst", out.analysis);
  c.loop.acceptAnalyst(id);
  await result(c, id, "critic", out.critic);
  return c.loop.finish(id);
}

it("persists versioned proof, hypotheses, checks and a trusted pass; promotes one reusable lesson", async () => {
  const c = await setup();
  start(c, "clean");
  const done = await complete(c, "clean");
  expect(done.verification.verdict).toBe("pass");
  const view = investigationView(c.runtime, "clean").reasoning!;
  expect(view).toMatchObject({ schemaVersion: 1, stage: "verified", attempt: 1, maxAttempts: 2 });
  expect(view.bundle?.checks).toMatchObject({
    ledgerQuantity: 22,
    countQuantity: 19,
    explained: 3,
    unexplained: 0,
  });
  expect(view.bundle?.audits).toHaveLength(4);
  expect(view.analysis?.hypotheses).toHaveLength(1);
  const count = () => c.db.db.prepare("SELECT COUNT(*) AS n FROM hmem_memories").get()!.n;
  expect(count()).toBe(1);
  c.loop.finish("clean");
  expect(count()).toBe(1);
  start(c, "next");
  await evidence(c, "next");
  c.loop.confirmEvidence("next");
  expect(c.loop.reasoning.validateBundle(plan(c, "next")).memory).toHaveLength(1);
});

it.each(["complete", "incomplete"])(
  "preserves the original and bounds revision to two attempts (%s)",
  async (scenario) => {
    const c = await setup();
    start(c, "original", "incomplete");
    expect((await complete(c, "original", "REVISE")).verification.verdict).toBe("revise");
    c.loop.revise("original", "second", { scenarioId: scenario });
    c.loop.revise("original", "second", { scenarioId: scenario });
    expect(
      (await complete(c, "second", scenario === "complete" ? "ACCEPT" : "REVISE")).verification
        .verdict,
    ).toBe(scenario === "complete" ? "pass" : "unresolved");
    expect(c.loop.reasoning.view(plan(c, "second"))).toMatchObject({
      attempt: 2,
      remainingAttempts: 0,
      original: { stage: "revision_required" },
    });
    expect(() => c.loop.revise("second", "third")).toThrow();
    expect(() => c.loop.revise("original", "another")).toThrow();
  },
);

it("rejects incorrect model arithmetic independently of ACCEPT", async () => {
  const c = await setup();
  start(c, "arithmetic");
  const done = await complete(c, "arithmetic", "ACCEPT", (out) => {
    out.analysis.hypotheses[0].claimedExplainedUnits = 999;
  });
  expect(done.verification.verdict).toBe("unresolved");
  expect(done.review.issues.join(" ")).toContain("quantity");
  expect(() =>
    c.operations.verifier.record({
      verification: { ...done.verification, verificationId: "forged-pass", verdict: "pass" },
    }),
  ).toThrow();
});

it.each(["forged-bundle", "forged-evidence"])(
  "holds the Critic when Analyst references are %s",
  async (kind) => {
    const c = await setup();
    start(c, kind);
    await evidence(c, kind);
    c.loop.confirmEvidence(kind);
    const out = outputs(c, kind);
    if (kind === "forged-bundle") out.analysis.bundleId = "other-bundle";
    else out.analysis.hypotheses[0].supportingEvidenceIds.push("not-authorized");
    await result(c, kind, "analyst", out.analysis);
    expect(() => c.loop.acceptAnalyst(kind)).toThrow();
    expect(child(c, kind, "critic").attempts).toHaveLength(0);
  },
);

it.each(["stale", "missing"])("rejects %s evidence before dispatch", async (scenario) => {
  const c = await setup();
  start(c, scenario, scenario);
  await evidence(c, scenario);
  expect(() => c.loop.confirmEvidence(scenario)).toThrow();
  expect(child(c, scenario, "analyst").attempts).toHaveLength(0);
});

it("rejects unauthorized next tasks and schema extensions", async () => {
  const c = await setup();
  start(c, "unauthorized", "incomplete");
  const done = await complete(c, "unauthorized", "REVISE", (out) => {
    out.critic.nextTasks[0].parameters.sku = "OTHER-SKU";
  });
  expect(done.verification.verdict).toBe("unresolved");
  expect(done.review.issues.join(" ")).toContain("unauthorized");
  expect(() =>
    assertReasoningContract("critic", {
      ...outputs(c, "unauthorized").critic,
      command: "write stock",
    }),
  ).toThrow();
});

it("ends UNCERTAIN unresolved and preserves unknown execution without duplicate tasks", async () => {
  const c = await setup();
  start(c, "uncertain");
  expect((await complete(c, "uncertain", "UNCERTAIN")).verification.verdict).toBe("unresolved");
  start(c, "unknown");
  const id = child(c, "unknown", "planner").operation.taskId;
  c.db.updateTask(id, { status: "outcome_unknown" });
  await tick();
  for (let i = 0; i < 3; i++) c.operations.reconcile("unknown");
  expect(child(c, "unknown", "planner").attempts).toHaveLength(1);
  expect(child(c, "unknown", "reader").attempts).toHaveLength(0);
});

it("recovers persisted state and attempt budget after reopening SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-town-v3-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, "tasks.sqlite");
  const first = await setup(filename);
  start(first, "restart", "incomplete");
  await complete(first, "restart", "REVISE");
  const before = first.loop.reasoning.view(plan(first, "restart"));
  first.close();
  const recovered = await setup(filename);
  expect(recovered.loop.reasoning.view(plan(recovered, "restart"))).toEqual(before);
  recovered.loop.revise("restart", "restart-second", { scenarioId: "complete" });
  expect(() =>
    recovered.loop.revise("restart", "restart-third", { scenarioId: "complete" }),
  ).toThrow();
});

it("keeps conflicting records unresolved even when the Critic accepts", async () => {
  const c = await setup();
  start(c, "conflict", "conflicting");
  const done = await complete(c, "conflict");
  expect(done.verification.verdict).toBe("unresolved");
  expect(done.review.issues.join(" ")).toContain("exceeds");
});

it("records post-cutoff exclusions and rejects them as hypothesis support", async () => {
  const c = await setup();
  start(c, "cutoff", "post_count");
  await evidence(c, "cutoff");
  c.loop.confirmEvidence("cutoff");
  const bundle = c.loop.reasoning.validateBundle(plan(c, "cutoff"));
  expect(bundle.checks.excludedEvidence.length).toBeGreaterThan(0);
  const out = outputs(c, "cutoff", "REVISE");
  out.analysis.hypotheses[0].supportingEvidenceIds.push(
    bundle.checks.excludedEvidence[0].evidenceId,
  );
  await result(c, "cutoff", "analyst", out.analysis);
  expect(() => c.loop.acceptAnalyst("cutoff")).toThrow(/excluded/);
});

it("rejects changed evidence revisions and missing audits without dispatching again", async () => {
  const c = await setup();
  start(c, "revisions");
  await evidence(c, "revisions");
  c.loop.confirmEvidence("revisions");
  const bundle = c.loop.reasoning.validateBundle(plan(c, "revisions"));
  const stateBefore = c.loop.reasoning.state(plan(c, "revisions"));
  c.loop.confirmEvidence("revisions");
  expect(c.loop.reasoning.state(plan(c, "revisions"))).toEqual(stateBefore);
  expect(child(c, "revisions", "analyst").attempts).toHaveLength(1);
  const ref = bundle.evidence[0];
  const row = c.db.record("operation.evidence", ref.evidenceId)!;
  c.db.saveRecord("operation.evidence", ref.evidenceId, { value: row.value }, row.revision);
  expect(() => c.loop.reasoning.validateBundle(plan(c, "revisions"))).toThrow(/revision changed/);
  c.db.db
    .prepare("DELETE FROM runtime_records WHERE namespace=? AND id=?")
    .run("operation.dataRead", bundle.audits[0].auditRef);
  expect(() => c.loop.reasoning.validateBundle(plan(c, "revisions"))).toThrow(/audit/);
});

it.each(["mismatched", "stale", "superseded"])(
  "does not reuse %s memory as an applicable lesson",
  async (kind) => {
    const c = await setup();
    start(c, "memory-source");
    await complete(c, "memory-source");
    const stored = c.db.db.prepare("SELECT data FROM hmem_memories").get()!;
    const memory = JSON.parse(String(stored.data));
    if (kind === "mismatched") memory.applicability = "inventory-shortage:OTHER:OTHER";
    if (kind === "stale") memory.freshUntil = new Date(Date.now() - 1000).toISOString();
    if (kind === "superseded") memory.source.verificationRevision += 1;
    c.db.db
      .prepare("UPDATE hmem_memories SET data=? WHERE id=?")
      .run(JSON.stringify(memory), memory.id);
    start(c, "memory-target");
    await evidence(c, "memory-target");
    c.loop.confirmEvidence("memory-target");
    expect(c.loop.reasoning.validateBundle(plan(c, "memory-target")).memory).toEqual([]);
  },
);

it("rejects another incident's real bundle ID", async () => {
  const c = await setup();
  start(c, "scope-first");
  await evidence(c, "scope-first");
  c.loop.confirmEvidence("scope-first");
  start(c, "scope-second");
  await evidence(c, "scope-second");
  c.loop.confirmEvidence("scope-second");
  const out = outputs(c, "scope-first");
  out.analysis.bundleId = c.loop.reasoning.state(plan(c, "scope-second")).bundleId!;
  await result(c, "scope-first", "analyst", out.analysis);
  expect(() => c.loop.acceptAnalyst("scope-first")).toThrow(/forged bundle/);
});

it("keeps competing proposals distinct and exposes rejected alternative arithmetic", async () => {
  const c = await setup();
  start(c, "alternatives");
  const done = await complete(c, "alternatives", "ACCEPT", (out) => {
    out.analysis.hypotheses.push({
      ...out.analysis.hypotheses[0],
      hypothesisId: "unsupported-alternative",
      statement: "An alternative proposal needing additional records",
      supportingEvidenceIds: [],
      claimedExplainedUnits: 8,
      missingEvidence: ["No current source record supports this alternative"],
    });
  });
  expect(done.verification.verdict).toBe("pass");
  expect(c.loop.reasoning.view(plan(c, "alternatives"))?.hypothesisChecks).toMatchObject([
    {
      hypothesisId: "transfer-and-receipt",
      arithmeticMatches: true,
      explanationReferencesMatch: true,
    },
    {
      hypothesisId: "unsupported-alternative",
      arithmeticMatches: false,
      explanationReferencesMatch: false,
    },
  ]);
});

it("recovers a crash after trusted proof persistence without replacing its time or duplicating memory", async () => {
  const c = await setup();
  start(c, "verification-crash");
  const promotion = vi.spyOn(c.runtime.memory, "writeVerified").mockImplementationOnce(() => {
    throw new Error("Simulated crash after verification persisted");
  });
  await expect(complete(c, "verification-crash")).rejects.toThrow(/Simulated crash/);
  promotion.mockRestore();
  expect(plan(c, "verification-crash").verification).toBeUndefined();
  const stored = c.operations.records.list("verificationResult")[0].value;
  await c.operations.recover();
  expect(plan(c, "verification-crash").verification).toEqual(stored);
  const recovered = new InventoryReasoningLoop(c.operations);
  expect(recovered.finish("verification-crash").verification).toEqual(stored);
  recovered.finish("verification-crash");
  expect(c.db.db.prepare("SELECT COUNT(*) AS n FROM hmem_memories").get()!.n).toBe(1);
  expect(recovered.reasoning.view(plan(c, "verification-crash"))?.stage).toBe("verified");
});
