import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { NightshiftGateway } from "../server/nightshift-gateway.mjs";
import { createNightshiftEnforcement } from "../server/nightshift-enforcement.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { TaskComposer } from "../server/task-composer.mjs";
import { OfficeGroupChat, OFFICE_GROUP_SESSION } from "../server/office-group-chat.mjs";
import { runtimeStorage } from "../server/runtime-storage.mjs";
import { nightshiftOption, openclawOption } from "../server/execution-options.mjs";
import { inventoryEligibility } from "../server/inventory-office-api.mjs";
import { InventoryReasoningLoop } from "../server/inventory-reasoning-loop.mjs";

// Fake HTTP provider and a disconnected secondary runtime: wiring evidence, not live acceptance.
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
const criteria = {
  scenarioId: "incomplete",
  sku: "SKU-17",
  locationId: "BIN-A",
  ledgerQuantity: 12,
  physicalQuantity: 9,
  maxUnexplainedUnits: 0,
};

async function routedOffice(db = new TaskDatabase(":memory:")) {
  const gateway = new NightshiftGateway({
    baseUrl: "http://127.0.0.1:8088/v1",
    apiKey: "mock-token",
    fetchImpl: async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
      return json({ model: "meterless/auto", choices: [{ message: { content: "{}" } }] });
    },
  });
  const runtime: Data = new TaskRuntime({ db, gateway, gatewayId: "nightshift-primary" });
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
  const enforcement = createNightshiftEnforcement(runtime);
  // A configured OpenClaw runtime that is offline must be rejected with a recorded reason.
  const offline = {
    runtime: {
      db: runtimeStorage(db, "openclaw-tools"),
      gatewayId: "openclaw-tools",
      agentsReady: false,
      agents: [],
      gateway: { status: "disconnected", provider: "openclaw" },
    },
    grants: [],
    selectTask: () => ({
      status: "no_eligible_agent",
      reason: "OpenClaw gateway is disconnected.",
    }),
    close: () => {},
  };
  const operations = new OfficeOperations(runtime, {
    specialists: {
      grants,
      enforcement,
      executionOptions: (registry: Data) => [
        nightshiftOption(registry, enforcement),
        openclawOption({ id: "openclaw-tools", registry: offline }),
      ],
    },
    dataReader: { read: async () => ({ evidence: [] }) },
  });
  cleanup.push(() => operations.close());
  runtime.operations = operations;
  return { db, runtime, operations };
}

function expectRoutedToNightshift(decision: Data) {
  expect(decision).toMatchObject({
    optionId: "nightshift",
    runtime: "nightshift",
    modelProvider: "unknown",
    model: "meterless/auto",
    authorization: "verified_for_task",
  });
  expect(decision.reason[0]).toContain("only eligible option");
  expect(decision.rejected).toEqual([
    { optionId: "openclaw-tools", missing: ["OpenClaw gateway is disconnected."] },
  ]);
}

it("routes composer stages through the shared router and persists the decision across restart", async () => {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const { runtime, operations } = await routedOffice(db);
  expect(operations.routed).toBe(true);
  const composer = new TaskComposer(runtime, { env: {} as NodeJS.ProcessEnv, autoStart: false });
  runtime.composer = composer;
  const record = db.saveRecord(
    "composer.task",
    "compose_routed",
    {
      gatewayId: runtime.gatewayId,
      input: { goal: "Summarize the supplied text", submissionId: "routed" },
      route: { successCriteria: ["Accurate summary"] },
      status: "ready",
      attempts: [],
      attempt: 0,
      createdAt: new Date().toISOString(),
    },
    0,
  );
  const staged = composer.stageTask({ ...record, id: "compose_routed" }, "planner", "Plan it.");
  expect(staged.attempts[0].role).toBe("nightshift-planner");
  expectRoutedToNightshift(staged.attempts[0].executionDecision);
  // A fresh composer over the same durable store sees the same persisted routing.
  const reread = new TaskComposer(runtime, { env: {} as NodeJS.ProcessEnv, autoStart: false }).get(
    "compose_routed",
  );
  expect(reread.attempts[0].executionDecision).toEqual(staged.attempts[0].executionDecision);
});

it("routes inventory reasoning stages within the router-chosen runtime family", async () => {
  const { operations, runtime } = await routedOffice();
  const plan = new InventoryReasoningLoop(operations).start({
    incidentId: "routed-inventory",
    goal: "Explain the inventory shortage",
    criteria,
  });
  for (const child of plan.children) {
    expect(child.requirements.requiredRuntime).toBe("nightshift");
    expectRoutedToNightshift(child.executionDecision);
  }
  const eligibility = inventoryEligibility(runtime);
  expect(eligibility).toMatchObject({ routed: true, provider: "nightshift", ready: true });
  expect(eligibility.roles.map((role: Data) => role.executionDecision.runtime)).toEqual([
    "nightshift",
    "nightshift",
    "nightshift",
  ]);
});

it("explains a blocked group-chat specialist request with every rejected option and persists it", async () => {
  const { runtime, db } = await routedOffice();
  const chat = new OfficeGroupChat(runtime);
  cleanup.push(() => chat.close());
  chat.send({
    turnId: "pump1",
    message: "assign a specialist to research the pump manual for P-100",
  });
  const until = Date.now() + 2000;
  let posted: Data | undefined;
  while (!posted && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    posted = db
      .messages(OFFICE_GROUP_SESSION)
      .find((message: Data) => message.id === "group_bridge_pump1_specialist");
  }
  expect(posted?.content).toContain("Blocked:");
  expect(posted?.content).toContain("openclaw-tools: OpenClaw gateway is disconnected.");
  expect(posted?.content).toContain("nightshift:");
  const request = db.records("office.specialistRequest")[0];
  expect(request.executionDecision).toBeNull();
  expect(request.blockedReason).toContain("openclaw-tools: OpenClaw gateway is disconnected.");
});

it("leaves ordinary conversational group turns seat-bound and unrouted", async () => {
  const { runtime, operations } = await routedOffice();
  let routed = 0;
  const routing = operations.routing as Data;
  const select = routing.selectTask.bind(routing);
  routing.selectTask = (input: Data) => {
    routed++;
    return select(input);
  };
  const chat = new OfficeGroupChat(runtime);
  cleanup.push(() => chat.close());
  try {
    chat.send({ turnId: "chat1", message: "What should we demo first?" });
  } catch {
    // Seat availability is a separate concern; routing must not be consulted either way.
  }
  expect(routed).toBe(0);
});
