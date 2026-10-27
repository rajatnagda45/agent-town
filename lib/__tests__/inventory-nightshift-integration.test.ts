import { expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { NightshiftGateway } from "../server/nightshift-gateway.mjs";
import { createNightshiftEnforcement } from "../server/nightshift-enforcement.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { createInventoryReader } from "../server/inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "../server/inventory-synthetic.mjs";
import { InventoryReasoningLoop } from "../server/inventory-reasoning-loop.mjs";
import type { OrchestrationPlan } from "../server/orchestration.mjs";

// Fake HTTP provider and synthetic warehouse rows: this is not live Nightshift/Zetaris verification.
const json = (value: unknown) => new Response(JSON.stringify(value));
const criteria = {
  scenarioId: "incomplete",
  sku: "SKU-17",
  locationId: "BIN-A",
  ledgerQuantity: 12,
  physicalQuantity: 9,
  maxUnexplainedUnits: 0,
};
async function eventually(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

function suppliedEvidence(message: string) {
  const marker = "Current authorized evidence (cite only these IDs): ";
  const encoded = message
    .split(marker)[1]
    ?.split("\nServer count-cutoff reconciliation")[0]
    .split("\nValidated prior reasoning:")[0];
  return JSON.parse(encoded ?? "[]") as Array<{
    evidenceId: string;
    source: string;
    content: string;
  }>;
}

it("runs incomplete evidence, Critic revision, and corrected result through merged Lane B/C/D mocks", async () => {
  let round: 1 | 2 = 1;
  const prompts: Array<{ role: string; message: string }> = [];
  const gateway = new NightshiftGateway({
    baseUrl: "http://127.0.0.1:8088/v1",
    apiKey: "mock-token",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
      const body = JSON.parse(String(init?.body));
      const system = String(body.messages[0].content);
      const message = String(body.messages.at(-1).content);
      const role = /the (planner|analyst|critic) in/.exec(system)?.[1] ?? "unknown";
      prompts.push({ role, message });
      let content: string;
      if (role === "planner") {
        const goal = JSON.parse(
          message
            .split("The reviewed task graph and criteria are ")[1]
            ?.split(". Return exactly")[0] ?? "{}",
        ).goal;
        content = JSON.stringify({
          goal,
          acceptanceCriteria: ["inventory-count", "inventory-reconciliation"],
          tasks: [
            { taskId: "reader", role: "nightshift-analyst", dependencies: ["planner"] },
            { taskId: "analyst", role: "nightshift-analyst", dependencies: ["reader"] },
            { taskId: "critic", role: "nightshift-critic", dependencies: ["reader", "analyst"] },
          ],
        });
      } else if (message.includes("Prepare the server-scoped inventory evidence read")) {
        content = '{"prepared":true}';
      } else if (role === "analyst") {
        const evidence = suppliedEvidence(message);
        const explained = evidence.reduce((sum, item) => {
          const row = JSON.parse(item.content);
          if (item.source.endsWith("inventory_transfers")) return sum + row.quantity;
          if (item.source.endsWith("inventory_receipts"))
            return sum + row.expected_quantity - row.received_quantity;
          return sum;
        }, 0);
        const explanationEvidenceIds = evidence
          .filter((item) => {
            const row = JSON.parse(item.content);
            return (
              item.source.endsWith("inventory_transfers") ||
              item.source.endsWith("inventory_receipts") ||
              (item.source.endsWith("inventory_ledger_movements") &&
                row.movement_type === "posted_receipt" &&
                explained === 3)
            );
          })
          .map((item) => item.evidenceId);
        content = JSON.stringify({
          hypothesis: "The count shortage is explained by the cited inventory records.",
          explanationEvidenceIds,
          claimedExplainedUnits: explained,
          missingEvidence: [],
        });
      } else {
        const prior = JSON.parse(message.split("\nValidated prior reasoning: ")[1]);
        const analysis = JSON.parse(prior.result);
        content = JSON.stringify({
          hypothesisSupported: analysis.claimedExplainedUnits === 3,
          missingEvidence:
            analysis.claimedExplainedUnits === 3 ? [] : ["One unit lacks source evidence."],
          conflictingEvidenceIds: [],
        });
      }
      return json({ model: "meterless/auto", choices: [{ message: { content } }] });
    },
  });
  const db = new TaskDatabase(":memory:");
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "nightshift-inventory" });
  let operations: OfficeOperations | undefined;
  try {
    await gateway.start();
    await runtime.refresh();
    for (const seatId of ["plan", "analyze", "review"])
      runtime.saveSeat({ seatId, label: seatId, seatType: "worker", assigned: true, revision: 0 });
    const grants = [
      {
        manifestId: "nightshift-planner",
        seatId: "plan",
        sessionKey: "agent:main:nightshift-planner-context01",
      },
      {
        manifestId: "nightshift-analyst",
        seatId: "analyze",
        sessionKey: "agent:main:nightshift-analyst-context02",
      },
      {
        manifestId: "nightshift-critic",
        seatId: "review",
        sessionKey: "agent:main:nightshift-critic-context03",
      },
    ];
    const readers = ["incomplete", "complete"].map((scenario) => {
      const rows = createSyntheticInventoryFixtures(scenario, {
        sku: criteria.sku,
        locationId: criteria.locationId,
        openingQuantity: 10,
        countedQuantity: 9,
      });
      return createInventoryReader({
        mode: "synthetic",
        synthetic: createSyntheticDataSource(rows),
      });
    });
    const dataReader = {
      read: (input: Parameters<(typeof readers)[0]["read"]>[0]) =>
        readers[input.scope.incidentId === "nightshift-second" ? 1 : 0].read(input),
    };
    operations = new OfficeOperations(runtime, {
      dataReader,
      specialists: { grants, enforcement: createNightshiftEnforcement(runtime) },
    });
    const loop = new InventoryReasoningLoop(operations);
    for (const incidentId of ["nightshift-first", "nightshift-second"]) {
      const plan: OrchestrationPlan =
        round === 1
          ? loop.start({ incidentId, goal: "Explain the inventory shortage", criteria })
          : loop.revise("nightshift-first", incidentId, { scenarioId: "complete" });
      const plannerId = plan.children.find((child) => child.nodeId === "planner")!.operation.taskId;
      await eventually(() => db.getTask(plannerId)?.status === "completed");
      loop.acceptPlanner(incidentId);
      const readerId = operations.orchestration
        .get(incidentId)
        .children.find((child) => child.nodeId === "reader")!.operation.taskId;
      await eventually(() => db.getTask(readerId)?.status === "completed");
      await loop.collectEvidence(incidentId);
      expect(
        operations.orchestration
          .get(incidentId)
          .children.find((child) => child.nodeId === "analyst")?.attempts,
      ).toHaveLength(0);
      const attached = operations.orchestration
        .get(incidentId)
        .children.find((child) => child.nodeId === "reader")!.evidenceIds;
      loop.confirmEvidence(incidentId);
      const analystId = operations.orchestration
        .get(incidentId)
        .children.find((child) => child.nodeId === "analyst")!.operation.taskId;
      await eventually(() => db.getTask(analystId)?.status === "completed");
      for (const id of attached) expect(db.getTask(analystId)?.message).toContain(id);
      loop.acceptAnalyst(incidentId);
      const criticId = operations.orchestration
        .get(incidentId)
        .children.find((child) => child.nodeId === "critic")!.operation.taskId;
      await eventually(() => db.getTask(criticId)?.status === "completed");
      const result = loop.finish(incidentId);
      expect(result.review.reconciliation).toMatchObject({
        discrepancy: 3,
        explained: round === 1 ? 2 : 3,
      });
      expect(result.verification.verdict).toBe(round === 1 ? "revise" : "pass");
      expect(gateway.runAudit(criticId)?.outcome).toBe("completed");
      round = 2;
    }
    expect(prompts.filter((item) => item.role === "critic")).toHaveLength(2);
  } finally {
    operations?.close();
    runtime.close();
    db.close();
  }
});
