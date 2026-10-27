import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOfficeIntent, parseInventoryRequest } from "../server/office-intent.mjs";
import { createTaskService } from "../server/runtime-api.mjs";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

type Composer = {
  get(id: string): {
    route: { domain: string };
    status: string;
    timeline: Array<{ event: string }>;
  };
};
const composerOf = (service: { runtime: object }) =>
  (service.runtime as unknown as { composer: Composer }).composer;

const request =
  "Explain the 3-unit shortage for SKU-17 at BIN-A using evidence. Do not modify inventory. Ledger 12, physical 9, max unexplained 0.";

it("extracts complete inventory criteria and asks only for missing fields", () => {
  const complete = classifyOfficeIntent(request);
  expect(complete.kind).toBe("inventory_shortage_investigation");
  if (!("submission" in complete) || !complete.submission)
    throw new Error("Missing inventory criteria");
  expect(complete.missing).toEqual([]);
  expect(complete.submission.criteria).toMatchObject({
    sku: "SKU-17",
    locationId: "BIN-A",
    ledgerQuantity: 12,
    physicalQuantity: 9,
    maxUnexplainedUnits: 0,
  });
  const incomplete = classifyOfficeIntent("Please investigate inventory shortage SKU-17 at BIN-A");
  if (!("missing" in incomplete)) throw new Error("Expected missing criteria");
  expect(incomplete.missing).toEqual([
    "ledger quantity",
    "physical quantity",
    "maximum unexplained units (0–100)",
    "read-only constraint (say ‘do not modify inventory’)",
  ]);
  expect(classifyOfficeIntent("Plan a team meeting").kind).toBe("ordinary");
});

it("runs a chat inventory request as one durable Work task, never a stalled legacy incident", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-intent-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const options = {
    gatewayUrl: "ws://unused/",
    provider: "nightshift",
    nightshiftFetch: async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/models") ? { data: [{ id: "fixture/model" }] } : { choices: [] },
        ),
      ),
    env: {
      AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
      NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1",
      NIGHTSHIFT_API_KEY: "fixture-token",
      NIGHTSHIFT_MODEL: "fixture/model",
    },
  };
  let service = await createTaskService(options);
  cleanups.push(() => service.close());
  await service.start();
  await service.runtime.refresh();
  service.groupChat.send({ turnId: "inventory1", message: request });
  const started = service.groupChat
    .messages()
    .find((item: { id: string }) => item.id === "group_bridge_inventory1_started");
  expect(started?.content).toMatch(/^Inventory investigation started · compose_/);
  expect(started?.content).toContain("/work/");
  expect(
    service.groupChat
      .messages()
      .some((item: { id: string }) => item.id.startsWith("group_reply_grp_")),
  ).toBe(false);
  // The legacy manual-step investigation is never started from chat.
  expect(service.runtime.db.record("office.groupIncident", "inventory1")).toBeNull();
  const link = service.runtime.db.record("office.groupComposer", "inventory1");
  const task = composerOf(service).get(link.taskId);
  expect(task.route.domain).toBe("inventory");
  // Creating the task is not completion; the timeline records only what happened.
  expect(task.status).not.toBe("completed");
  expect(task.timeline[0]).toMatchObject({ event: "accepted" });
  service.groupChat.send({ turnId: "inventory1", message: request });
  expect(
    service.runtime.db
      .records("composer.task")
      .filter((item: { input: { goal: string } }) => item.input.goal === request),
  ).toHaveLength(1);
  service.groupChat.send({
    turnId: "inventory2",
    message: "Investigate inventory shortage SKU-17 at BIN-A",
  });
  expect(
    service.groupChat
      .messages()
      .find((item: { id: string }) => item.id === "group_bridge_inventory2_missing")?.content,
  ).toContain("ledger quantity");
  expect(service.runtime.db.record("office.groupComposer", "inventory2")).toBeNull();
  service.close();
  service = await createTaskService(options);
  await service.start();
  await service.runtime.refresh();
  // The link, the task and its timeline survive a restart; the start note is not repeated.
  expect(service.runtime.db.record("office.groupComposer", "inventory1")?.taskId).toBe(link.taskId);
  expect(composerOf(service).get(link.taskId).timeline[0].event).toBe("accepted");
  expect(
    service.groupChat
      .messages()
      .filter((item: { id: string }) => item.id === "group_bridge_inventory1_started"),
  ).toHaveLength(1);
});

it("keeps the requested SKU and location exactly as written, and parses plain wording", () => {
  const labelled =
    "Investigate the discrepancy.\nSKU: TEST-SKU-001\nLocation: Test Warehouse A\nLedger quantity: 12 units\nPhysical quantity: 9 units\nMaximum unexplained units: 3\nRead-only constraint: Do not modify inventory.";
  expect(parseInventoryRequest(labelled)).toMatchObject({
    sku: "TEST-SKU-001",
    locationId: "Test Warehouse A",
    ledger: "12",
    physical: "9",
    max: "3",
    readOnly: true,
  });
  // Never the "SKU-001" inside "TEST-SKU-001", and no scenario is invented.
  expect(parseInventoryRequest(labelled).scenarioId).toBeUndefined();
  const intent = classifyOfficeIntent(labelled);
  if (!("submission" in intent) || !intent.submission) throw new Error("Expected criteria");
  expect(intent.submission.criteria).toMatchObject({
    sku: "TEST-SKU-001",
    locationId: "Test Warehouse A",
  });
  // Natural phrasing: the numbers already given are not asked for again.
  const plain = classifyOfficeIntent(
    "Investigate this inventory discrepancy. The inventory ledger reports 12 units, but the physical count is 9 units.",
  );
  if (!("missing" in plain)) throw new Error("Expected an inventory intent");
  expect(plain.missing).not.toContain("ledger quantity");
  expect(plain.missing).not.toContain("physical quantity");
  expect(parseInventoryRequest("Explain the SKU shortage at BIN-A").sku).toBeUndefined();
});
