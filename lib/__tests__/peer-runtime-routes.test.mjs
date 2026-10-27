import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { runtimeStorage } from "../server/runtime-storage.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";

// Seat-, session- and task-scoped endpoints must reach the runtime that holds the binding;
// before this, a peer (OpenClaw) seat failed with "no available backend agent binding".
const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

async function office() {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const gateway = {
    status: "connected",
    subscribe: () => () => {},
    capabilities: () => ({}),
    stop: () => {},
  };
  const primary = new TaskRuntime({
    db,
    gateway: { ...gateway, provider: "nightshift" },
    gatewayId: "ns",
  });
  const peer = new TaskRuntime({
    db: runtimeStorage(db, "oc"),
    gateway: { ...gateway, provider: "openclaw" },
    gatewayId: "oc",
  });
  cleanup.push(
    () => peer.close(),
    () => primary.close(),
  );
  primary.peers = [peer];
  db.saveSeat({
    seatId: "seat-0",
    label: "Alice",
    seatType: "worker",
    assigned: true,
    binding: { seatId: "seat-0", agentId: "main", sessionKey: "agent:main:main", revision: 1 },
  });
  peer.db.saveSeat({
    seatId: "seat-4",
    label: "Orion",
    seatType: "agent",
    assigned: true,
    binding: {
      seatId: "seat-4",
      agentId: "town-researcher",
      sessionKey: "agent:town-researcher:main",
      revision: 1,
    },
  });
  const calls = [];
  for (const [name, runtime] of [
    ["primary", primary],
    ["peer", peer],
  ]) {
    runtime.submit = vi.fn((input) => (calls.push([name, "submit"]), { taskId: input.taskId }));
    runtime.newSession = vi.fn((seatId) => (calls.push([name, "session"]), { seatId }));
    runtime.cancel = vi.fn(async (id) => (calls.push([name, "cancel"]), { taskId: id }));
    runtime.history = vi.fn(async (key) => (calls.push([name, "history"]), { key, messages: [] }));
    runtime.applyRole = vi.fn(async (seatId) => (calls.push([name, "role"]), { seatId }));
  }
  primary.composer = {
    create: vi.fn((input) => ({ id: `cmp_${input.submissionId}`, status: "ready" })),
  };
  const handler = createRuntimeHandler(primary);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { db, primary, peer, calls, call };
}

it("sends seat, session, task and history operations to the runtime that owns them", async () => {
  const { db, primary, peer, calls, call } = await office();
  // Task submission and session creation follow the seat.
  await call("POST", "/api/runtime/tasks", {
    taskId: "t-peer",
    seatId: "seat-4",
    message: "hello",
  });
  await call("POST", "/api/runtime/tasks", {
    taskId: "t-main",
    seatId: "seat-0",
    message: "hello",
  });
  await call("POST", "/api/runtime/sessions", { seatId: "seat-4" });
  await call("POST", "/api/runtime/sessions", { seatId: "seat-0" });
  // Seat role changes follow the seat.
  await call("POST", "/api/runtime/seats/seat-4/role", { revision: 1 });
  await call("POST", "/api/runtime/seats/seat-0/role", { revision: 1 });
  // History follows the session's bound agent; the shared "main" agent stays on the primary.
  await call("GET", "/api/runtime/history?sessionKey=agent:town-researcher:main");
  await call("GET", "/api/runtime/history?sessionKey=agent:main:main");
  // Cancellation and task detail follow the task's recorded gateway.
  const tasks = {
    "peer-task": { taskId: "peer-task", gatewayId: "oc", sessionKey: "agent:town-researcher:main" },
    "main-task": { taskId: "main-task", gatewayId: "ns", sessionKey: "agent:main:main" },
  };
  db.getTask = (id) => tasks[id] ?? null;
  db.taskEvents = () => [];
  peer.db.messages = vi.fn(() => [{ id: "m1", taskId: "peer-task", content: "from OpenClaw" }]);
  const primaryMessages = vi.spyOn(db, "messages").mockReturnValue([]);
  await call("POST", "/api/runtime/tasks/peer-task/cancel", {});
  await call("POST", "/api/runtime/tasks/main-task/cancel", {});
  const detail = await call("GET", "/api/runtime/tasks/peer-task");
  expect(detail.body.messages).toEqual([
    { id: "m1", taskId: "peer-task", content: "from OpenClaw" },
  ]);
  expect(primaryMessages).not.toHaveBeenCalled();

  expect(calls).toEqual([
    ["peer", "submit"],
    ["primary", "submit"],
    ["peer", "session"],
    ["primary", "session"],
    ["peer", "role"],
    ["primary", "role"],
    ["peer", "history"],
    ["primary", "history"],
    ["peer", "cancel"],
    ["primary", "cancel"],
  ]);
  expect(primary.sessionOwner("agent:unknown:main")).toBe(primary);
});

it("redirects a data request typed into a seat to the verified pipeline without a seat task", async () => {
  const { primary, peer, calls, call } = await office();
  const goal = "Summarize five records from NY_TAXI zones";
  const redirected = await call("POST", "/api/runtime/tasks", {
    taskId: "assign-1",
    seatId: "seat-4",
    message: goal,
  });
  expect(redirected.status).toBe(202);
  expect(redirected.body).toEqual({
    redirected: {
      composerTaskId: "cmp_assign-1",
      status: "ready",
      reason: expect.stringContaining("verified work pipeline"),
    },
  });
  expect(redirected.body.task).toBeUndefined();
  expect(primary.composer.create).toHaveBeenCalledWith({ submissionId: "assign-1", goal });
  // Inventory work goes to the pipeline as well; ordinary requests still reach the seat.
  await call("POST", "/api/runtime/tasks", {
    taskId: "assign-2",
    seatId: "seat-0",
    message: "Investigate why the sales inventory is inconsistent and prepare a report.",
  });
  expect(primary.composer.create).toHaveBeenCalledTimes(2);
  await call("POST", "/api/runtime/tasks", { taskId: "assign-3", seatId: "seat-4", message: "hi" });
  expect(calls).toEqual([["peer", "submit"]]);
  expect(primary.submit).not.toHaveBeenCalled();
  expect(peer.submit).toHaveBeenCalledTimes(1);
});
