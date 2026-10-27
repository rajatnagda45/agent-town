import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { runtimeStorage } from "../server/runtime-storage.mjs";
import { SpecialistJournal } from "../server/specialist-journal.mjs";
import { SpecialistRegistry } from "../server/specialist-registry.mjs";
import { ExecutionRouter } from "../server/execution-router.mjs";
import { bindGrantSeats, createTaskService } from "../server/runtime-api.mjs";
import {
  createExecutionOptions,
  loadExecutionConfig,
  nightshiftOption,
  openclawOption,
} from "../server/execution-options.mjs";

const cleanup = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps single-provider behaviour when no execution options are configured", () => {
  expect(loadExecutionConfig({})).toEqual({ options: [], preference: [] });
  const execution = createExecutionOptions({
    config: { options: [], preference: [] },
    primaryProvider: "nightshift",
  });
  expect(execution.factory({})).toEqual([]);
});

it("rejects inline credentials and unreviewed option fields", () => {
  const row = { id: "tools", provider: "openclaw", gatewayUrl: "ws://127.0.0.1:18789" };
  expect(
    loadExecutionConfig({ AGENT_TOWN_EXECUTION_OPTIONS: JSON.stringify([row]) }).options,
  ).toHaveLength(1);
  for (const bad of [
    { ...row, token: "secret" },
    { ...row, provider: "other" },
  ])
    expect(() =>
      loadExecutionConfig({ AGENT_TOWN_EXECUTION_OPTIONS: JSON.stringify([bad]) }),
    ).toThrow(/Invalid/);
  expect(() => loadExecutionConfig({ AGENT_TOWN_EXECUTION_PREFERENCE: '["Bad Value"]' })).toThrow();
});

it("reports Nightshift as a runtime with an unverified upstream provider and per-task enforcement", () => {
  const calls = [];
  const runtime = {
    gatewayId: "ns",
    gateway: { status: "connected", verifiedAt: 1000, model: "meterless/auto" },
  };
  const option = nightshiftOption(
    { runtime },
    { authorizeSync: (input) => (calls.push(input), input.task?.message === "ok") },
  );
  expect(option.snapshot({ sessionKey: "s" }, { capabilities: ["decompose_task"] })).toMatchObject({
    modelProvider: "unknown",
    model: "meterless/auto",
    tools: [],
    capabilities: ["decompose_task"],
    checkedAt: 1000,
    permissions: { dataAccess: "none", sensitiveWrites: "denied" },
  });
  expect(option.authorize({ task: { message: "ok" } })).toBe(true);
  expect(option.authorize({ task: { message: "other" } })).toBe(false);
  expect(nightshiftOption({ runtime }, undefined).authorize({ task: { message: "ok" } })).toBe(
    false,
  );
});

function openclaw(respond) {
  const runtime = {
    gatewayId: "oc",
    agentsReady: true,
    agents: [{ agentId: "main", model: "openai/gpt-5-mini" }],
    gateway: { status: "connected", request: async (method, params) => respond(method, params) },
  };
  return openclawOption({
    id: "tools",
    registry: { runtime, grants: [] },
    toolMap: { "tavily.search": ["web_search"], "zetaris.read": ["zetaris_query"] },
    now: () => 5000,
  });
}

it("maps only installed tools.effective fields and leaves unverifiable evidence absent", async () => {
  const option = openclaw(() => ({
    agentId: "main",
    profile: "full",
    groups: [{ id: "core", tools: [{ id: "web_search", source: "core" }, { id: "read" }] }],
  }));
  const assignment = { sessionKey: "agent:main:main", agentId: "main" };
  expect(
    option.snapshot(assignment, { capabilities: ["research_external_sources"] }).checkedAt,
  ).toBe(null);
  await flush();
  const snapshot = option.snapshot(assignment, { capabilities: ["research_external_sources"] });
  expect(snapshot).toMatchObject({
    checkedAt: 5000,
    modelProvider: "openai",
    model: "openai/gpt-5-mini",
    tools: ["tavily.search"],
    capabilities: ["research_external_sources"],
  });
  // `read` is outside the (absent) reviewed tool list, so no permission or authorization holds.
  expect(snapshot.permissions).toBeUndefined();
  expect(snapshot.outputSchemas).toBeUndefined();
  expect(
    option.authorize({
      manifest: { provider: "openclaw", tools: ["tavily.search"], permissions: {}, limits: {} },
      assignment,
      task: { message: "x" },
    }),
  ).toBe(false);
});

it("authorizes OpenClaw only while effective tools stay inside the reviewed manifest", async () => {
  let tools = ["web_search", "browser", "sessions_send"];
  let clock = 1000;
  const runtime = {
    gatewayId: "oc",
    agentsReady: true,
    agents: [{ agentId: "town-researcher", model: "openai/gpt-5.4-mini" }],
    gateway: {
      status: "connected",
      capabilities: () => ({ "chat.abort": { available: true } }),
      request: async () => ({
        agentId: "town-researcher",
        groups: [{ id: "core", tools: tools.map((id) => ({ id })) }],
      }),
    },
  };
  const option = openclawOption({ id: "oc", registry: { runtime, grants: [] }, now: () => clock });
  const manifest = {
    provider: "openclaw",
    tools: ["openclaw.web_search", "openclaw.web_fetch", "openclaw.browser", "agent.message"],
    permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
    limits: { maxRetries: 1 },
  };
  const assignment = {
    sessionKey: "agent:town-researcher:main",
    agentId: "town-researcher",
    gatewayId: "oc",
  };
  const authorize = () => option.authorize({ manifest, assignment, task: { message: "research" } });
  option.snapshot(assignment, manifest);
  await flush();
  expect(option.snapshot(assignment, manifest).permissions).toEqual(manifest.permissions);
  expect(authorize()).toBe(true);
  expect(
    option.authorize({
      manifest: { ...manifest, permissions: { sensitiveWrites: "approval_required" } },
      assignment,
      task: { message: "x" },
    }),
  ).toBe(false);

  clock += 31000; // Stale discovery is not evidence.
  expect(authorize()).toBe(false);

  tools = [...tools, "exec"]; // One unreviewed tool removes eligibility.
  await option.refresh();
  expect(authorize()).toBe(false);
  expect(option.snapshot(assignment, manifest).permissions).toBeUndefined();
});

it("recognises OpenClaw browser, web and session tools only when tools.effective reports them", async () => {
  const runtime = {
    gatewayId: "oc",
    agentsReady: true,
    agents: [{ agentId: "main", model: "openai/gpt-5-mini" }],
    gateway: {
      status: "connected",
      request: async () => ({
        agentId: "main",
        groups: [
          { id: "web", tools: [{ id: "web_search" }, { id: "web_fetch" }] },
          { id: "ui", tools: [{ id: "browser" }] },
          { id: "sessions", tools: [{ id: "sessions_send" }, { id: "session_status" }] },
        ],
      }),
    },
  };
  const option = openclawOption({ id: "primary", registry: { runtime, grants: [] }, now: () => 1 });
  const assignment = { sessionKey: "agent:main:main", agentId: "main" };
  option.snapshot(assignment);
  await flush();
  expect(option.snapshot(assignment).tools.sort()).toEqual([
    "agent.message",
    "openclaw.browser",
    "openclaw.sessions.status",
    "openclaw.web_fetch",
    "openclaw.web_search",
  ]);
});

it("treats a discovery timeout as missing evidence, which the router reports as a block", async () => {
  const option = openclaw(() =>
    Promise.reject(new Error("Gateway request timed out; outcome unknown")),
  );
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const assignment = {
    gatewayId: "oc",
    sessionKey: "agent:main:main",
    agentId: "main",
    seatId: "Researcher",
    bindingRevision: 1,
  };
  option.registry.runtime.db = db;
  option.registry.selectTask = () => ({
    status: "assigned",
    manifest: { id: "data-steward-researcher", capabilities: ["research_external_sources"] },
    assignment,
  });
  const router = new ExecutionRouter(option.registry, [option], { now: () => 5000 });
  option.snapshot(assignment);
  await flush();
  const result = router.selectTask({
    requirements: {
      capabilities: ["research_external_sources"],
      tools: ["tavily.search"],
      permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
    },
    task: { message: "Find the pump manual" },
  });
  expect(result.status).toBe("no_eligible_agent");
  for (const missing of [
    "current capability discovery",
    "tool tavily.search",
    "effective permissions",
    "enforced tool and time budgets",
  ])
    expect(result.reason).toContain(missing);
  // The block says why discovery failed instead of only that evidence is missing.
  expect(result.reason).toContain("last attempt failed: Gateway request timed out");
});

it("builds secondary runtimes over isolated storage and closes only the registries it owns", () => {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const gateway = {
    status: "disconnected",
    provider: "openclaw",
    subscribe: () => () => {},
    capabilities: () => ({}),
    stop: () => {},
  };
  const runtime = new TaskRuntime({ db: runtimeStorage(db, "oc"), gateway, gatewayId: "oc" });
  cleanup.push(() => runtime.close());
  const primaryRuntime = new TaskRuntime({
    db,
    gateway: { ...gateway, provider: "nightshift" },
    gatewayId: "ns",
  });
  cleanup.push(() => primaryRuntime.close());
  const primary = new SpecialistRegistry({
    runtime: primaryRuntime,
    journal: new SpecialistJournal(db, "ns"),
  });
  cleanup.push(() => primary.close());
  const execution = createExecutionOptions({
    config: { options: [{ id: "tools", grants: [] }], preference: ["openclaw"] },
    primaryProvider: "nightshift",
    secondaries: [{ row: { id: "tools", grants: [] }, runtime }],
  });
  const options = execution.factory(primary);
  expect(options.map((option) => option.id)).toEqual(["nightshift", "tools"]);
  expect(options[1].registry.runtime.db.sharedDatabase).toBe(db);
  expect(() => new ExecutionRouter(primary, options)).not.toThrow();
  let closed = 0;
  const closePrimary = primary.close.bind(primary);
  options[1].registry.close = () => closed++;
  primary.close = () => {
    throw new Error("primary registry belongs to OfficeOperations");
  };
  execution.close();
  primary.close = closePrimary;
  expect(closed).toBe(1);
});

it("activates task-level routing in the production service only when options are configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-routing-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ id: "meterless/auto" }] }), { status: 200 });
  const make = async (extra, name) => {
    const service = await createTaskService({
      gatewayUrl: "ws://unused/",
      provider: "nightshift",
      nightshiftFetch: fetchImpl,
      env: {
        AGENT_TOWN_DB_PATH: join(directory, `${name}.sqlite`),
        NIGHTSHIFT_API_KEY: "fixture-token",
        // Skip scanning the host npm cache; an unlocated protocol simply disables its methods.
        OPENCLAW_PROTOCOL_MODULE: join(directory, "missing-protocol.js"),
        ...extra,
      },
    });
    cleanup.push(() => service.close());
    return service;
  };
  expect((await make({}, "single")).operations.routed).toBe(false);
  const routed = await make(
    {
      AGENT_TOWN_EXECUTION_OPTIONS: JSON.stringify([
        { id: "tools", provider: "openclaw", gatewayUrl: "ws://127.0.0.1:9/" },
      ]),
      AGENT_TOWN_EXECUTION_PREFERENCE: '["nightshift"]',
    },
    "routed",
  );
  expect(routed.operations.routed).toBe(true);
  expect(routed.operations.routing.options.map((option) => option.id)).toEqual([
    "nightshift",
    "tools",
  ]);
  expect(routed.operations.routing.preference).toEqual(["nightshift"]);
});

it("shows a peer runtime's reviewed seats in the office roster, voice and group chat", () => {
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
  cleanup.push(() => primary.close());
  const peer = new TaskRuntime({
    db: runtimeStorage(db, "oc"),
    gateway: { ...gateway, provider: "openclaw" },
    gatewayId: "oc",
  });
  cleanup.push(() => peer.close());
  primary.peers = [peer];
  peer.agents = [{ agentId: "town-researcher" }];
  peer.agentsReady = true;
  const events = [];
  db.subscribe((event) => events.push(event));

  bindGrantSeats(
    peer,
    [
      {
        manifestId: "data-steward-researcher",
        seatId: "seat-4",
        sessionKey: "agent:town-researcher:main",
      },
      { manifestId: "critic", seatId: "seat-5", sessionKey: "agent:town-critic:main" },
    ],
    primary,
  );
  // Only the discovered agent is bound, with a reviewed name and a live seat event.
  expect(primary.rosterSeats()).toEqual([
    expect.objectContaining({
      seatId: "seat-4",
      label: "Orion",
      roleTitle: "OpenClaw Researcher",
      runtime: "openclaw",
      binding: expect.objectContaining({ agentId: "town-researcher", available: true }),
    }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({ kind: "seat", data: expect.objectContaining({ seatId: "seat-4" }) }),
  );
  expect(primary.seatOwner("seat-4")).toBe(peer);
  expect(primary.voice.peer({ seatId: "seat-4" })).toBe(peer.voice);
  expect(primary.voice.peer({ seatId: "seat-0" })).toBe(null);
  expect(() =>
    primary.saveSeat({ seatId: "seat-4", label: "Alice", seatType: "worker", assigned: false }),
  ).toThrow(/held by another runtime/);
});
