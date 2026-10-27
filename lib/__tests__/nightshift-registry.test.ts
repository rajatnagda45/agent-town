import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NightshiftGateway } from "../server/nightshift-gateway.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { SpecialistJournal } from "../server/specialist-journal.mjs";
import { SpecialistRegistry } from "../server/specialist-registry.mjs";
import { createNightshiftEnforcement } from "../server/nightshift-enforcement.mjs";
import { loadSpecialistConfig } from "../server/specialist-config.mjs";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function eventually(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

it("dispatches only granted read-only Nightshift roles through the durable queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-nightshift-registry-"));
  const db = new TaskDatabase(join(directory, "tasks.sqlite"));
  let reply: string | Error = '{"reason":"check stock"}';
  const gateway = new NightshiftGateway({
    baseUrl: "http://127.0.0.1:8088/v1",
    apiKey: "mock-token",
    fetchImpl: async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
      if (reply instanceof Error) throw reply;
      return json({ choices: [{ message: { content: reply } }] });
    },
  });
  const runtime = new TaskRuntime({ db, gateway, gatewayId: "nightshift-gateway" });
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
  expect(
    loadSpecialistConfig({ AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify(grants) }).grants,
  ).toEqual(grants);
  const journal = new SpecialistJournal(db, runtime.gatewayId);
  const registry = new SpecialistRegistry({
    runtime,
    journal,
    grants,
    enforcement: createNightshiftEnforcement(runtime),
  });
  cleanup.push(() => {
    registry.close();
    runtime.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const planner = registry.assign({ task: { role: "nightshift-planner" } });
  const analyst = registry.assign({ task: { role: "nightshift-analyst" } });
  const critic = registry.assign({ task: { role: "nightshift-critic" } });
  expect(
    new Set([planner.assignment?.seatId, analyst.assignment?.seatId, critic.assignment?.seatId])
      .size,
  ).toBe(3);
  expect(planner.manifest?.provider).toBe("meterless-nightshift");
  expect(registry.assign({ task: { role: "planner" } }).status).toBe("no_eligible_agent");
  await expect(
    registry.provision({ requestId: "no-nightshift-create", manifestId: "nightshift-planner" }),
  ).rejects.toThrow(/does not support/);
  const request = {
    requestId: "plan-dispatch",
    selection: planner,
    task: { taskId: "plan-task", message: "Plan one read-only stock check", retryCount: 0 },
  };
  const dispatched = registry.dispatchOrchestration(request);
  expect(dispatched.status).toBe("accepted");
  expect(dispatched).toMatchObject({
    manifestId: "nightshift-planner",
    templateVersion: "1.0.0",
    selectionReason: "reviewed_grant",
    requester: { kind: "user" },
    task: { taskId: "plan-task", retryCount: 0 },
    permissions: { dataAccess: "none", sensitiveWrites: "denied" },
  });
  expect(registry.dispatchOrchestration(request).id).toBe(dispatched.id);
  await eventually(() => db.getTask("plan-task")?.status === "completed");
  expect(db.getTask("plan-task")?.sessionKey).toBe(grants[0].sessionKey);
  expect(gateway.runAudit("plan-task")?.outcome).toBe("completed");

  const forbidden = { ...planner.manifest, tools: ["inventory.adjust"] };
  expect(
    createNightshiftEnforcement(runtime).authorizeSync({
      manifest: forbidden,
      assignment: planner.assignment,
      task: request.task,
    }),
  ).toBe(false);
  const wrong = { ...planner, assignment: { ...planner.assignment, bindingRevision: 999 } };
  expect(() =>
    registry.dispatchOrchestration({
      requestId: "bad-binding",
      selection: wrong,
      task: { taskId: "bad-task", message: "Plan" },
    }),
  ).toThrow(/changed/);
  expect(db.getTask("bad-task")).toBeNull();
  registry.enforcement = null;
  expect(() =>
    registry.dispatchOrchestration({
      requestId: "missing-enforcement",
      selection: critic,
      task: { taskId: "no-policy-task", message: "Review" },
    }),
  ).toThrow(/not enforced/);
  expect(db.getTask("no-policy-task")).toBeNull();
  registry.enforcement = createNightshiftEnforcement(runtime);
  reply = "x".repeat(40000);
  const bounded = registry.dispatchOrchestration({
    requestId: "bounded-response",
    selection: critic,
    task: { taskId: "bounded-task", message: "Check a source reference" },
  });
  expect(bounded.status).toBe("accepted");
  await eventually(() => db.getTask("bounded-task")?.status === "failed");
  expect(gateway.runAudit("bounded-task")).toMatchObject({
    outcome: "failed",
    errorCode: "resource_limit",
  });
  expect(
    registry.dispatchOrchestration({
      requestId: "bounded-response",
      selection: critic,
      task: { taskId: "bounded-task", message: "Check a source reference" },
    }).id,
  ).toBe(bounded.id);
  reply = new Error("mock transport lost after send");
  const uncertain = registry.dispatchOrchestration({
    requestId: "uncertain-response",
    selection: analyst,
    task: { taskId: "uncertain-task", message: "Analyze a source reference" },
  });
  await eventually(() => db.getTask("uncertain-task")?.status === "outcome_unknown");
  expect(gateway.runAudit("uncertain-task")?.outcome).toBe("outcome_unknown");
  expect(
    registry.dispatchOrchestration({
      requestId: "uncertain-response",
      selection: analyst,
      task: { taskId: "uncertain-task", message: "Analyze a source reference" },
    }).id,
  ).toBe(uncertain.id);
  expect(db.listTasks(20, 0).filter((task) => task.taskId === "uncertain-task")).toHaveLength(1);
});
