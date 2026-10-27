// Mocked runtime integration: no live OpenClaw gateway is contacted here.
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { SpecialistJournal } from "../server/specialist-journal.mjs";
import { SPECIALIST_CATALOGUE, validateCatalogue } from "../server/specialist-catalogue.mjs";
import { SpecialistRegistry } from "../server/specialist-registry.mjs";

const dirs: string[] = [];
const registries: SpecialistRegistry[] = [];
const databases: TaskDatabase[] = [];
afterEach(() => {
  registries.splice(0).forEach((registry) => registry.close());
  databases.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function fixture(options: { agents?: Array<[string, string, string]>; filename?: string } = {}) {
  const filename =
    options.filename ??
    (() => {
      const dir = mkdtempSync(join(tmpdir(), "agent-town-specialist-"));
      dirs.push(dir);
      return join(dir, "tasks.sqlite");
    })();
  const db = new TaskDatabase(filename);
  databases.push(db);
  const grants: Array<{ manifestId: string; seatId: string }> = [];
  const agents = options.agents ?? [
    ["planner", "Dave", "agent-dave"],
    ["data-steward-researcher", "Alice", "agent-alice"],
    ["executor", "Bob", "agent-bob"],
    ["critic", "Carol", "agent-carol"],
  ];
  for (const [manifestId, label, agentId] of agents) {
    const seatId = `seat-${manifestId}`;
    db.saveSeat({
      seatId,
      label,
      seatType: "agent",
      assigned: true,
      binding: { seatId, agentId, sessionKey: `agent:${agentId}:main`, revision: 1 },
    });
    grants.push({ manifestId, seatId });
  }
  // Mock surface intentionally mirrors the JavaScript TaskRuntime without exposing its internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runtime: any = {
    db,
    agentsReady: true,
    gatewayId: "gateway-1",
    agents: agents.map(([, , agentId]) => ({ agentId })),
    gateway: {
      provider: "openclaw",
      audit: { validators: new Map([["AgentsCreateResultSchema", true]]) },
      request: vi.fn(async () => ({ sessions: [] })),
    },
    require: vi.fn(),
    resolve: vi.fn((seatId, sessionKey) => {
      const seat = db.getSeat(seatId);
      if (!seat?.assigned || (sessionKey && sessionKey !== seat.binding.sessionKey))
        throw Object.assign(new Error("Invalid binding"), { status: 409 });
      return {
        seat,
        agentId: seat.binding.agentId,
        sessionKey: sessionKey ?? seat.binding.sessionKey,
      };
    }),
    submit: vi.fn((input) => {
      const old = db.getTask(input.taskId);
      if (old) return old;
      const { seat, agentId, sessionKey } = runtime.resolve(input.seatId, input.sessionKey);
      if (seat.binding.revision !== input.bindingRevision)
        throw Object.assign(new Error("Binding changed"), { status: 409 });
      return db.insertTask({
        taskId: input.taskId,
        message: input.message,
        status: "queued",
        seatId: seat.seatId,
        agentId,
        sessionKey,
        gatewayId: runtime.gatewayId,
        bindingRevision: seat.binding.revision,
        createdAt: "2026-10-26T00:00:00.000Z",
      });
    }),
    cancel: vi.fn(async (id) => db.updateTask(id, { status: "outcome_unknown" })),
    saveSeat: vi.fn((input) => {
      const seat = {
        ...input,
        binding: {
          seatId: input.seatId,
          agentId: input.agentConfig.agentId,
          sessionKey: `agent:${input.agentConfig.agentId}:main`,
          revision: 1,
        },
      };
      db.saveSeat(seat);
      return seat;
    }),
    management: { mutate: vi.fn(async () => ({ status: "confirmed", agentId: "agent-new" })) },
  };
  const journal = new SpecialistJournal(db, runtime.gatewayId);
  const make = (extra = {}) => {
    const registry = new SpecialistRegistry({
      runtime,
      journal,
      grants,
      profiles: {
        critic: { seatId: "seat-new", name: "New Critic", workspace: "approved-workspace" },
      },
      enforcement: { authorize: vi.fn(async () => true) },
      ...extra,
    });
    registries.push(registry);
    return registry;
  };
  return { db, runtime, journal, grants, make, filename };
}

it("validates reviewed manifests and rejects credentials, duplicate IDs, and unreviewed communication", () => {
  expect(validateCatalogue(SPECIALIST_CATALOGUE)).toHaveLength(8);
  const bad = structuredClone(SPECIALIST_CATALOGUE);
  Object.assign(bad[0].manifest, { apiKey: "secret" });
  expect(() => validateCatalogue(bad)).toThrow();
  const duplicate = structuredClone(SPECIALIST_CATALOGUE);
  duplicate[1].manifest.id = duplicate[0].manifest.id;
  expect(() => validateCatalogue(duplicate)).toThrow();
  const pairing = structuredClone(SPECIALIST_CATALOGUE);
  pairing[0].mayMessage = ["external-agent"];
  expect(() => validateCatalogue(pairing)).toThrow();
});

it("matches capabilities and exact permissions deterministically, with explicit no eligible result", () => {
  const { make, db } = fixture();
  const registry = make();
  const want = {
    capabilities: ["read_operational_records"],
    tools: ["zetaris.read"],
    permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
  };
  expect(registry.match(want)).toMatchObject({
    status: "assigned",
    assignment: { agentId: "agent-alice" },
  });
  expect(registry.match({ ...want, capabilities: ["invent_capability"] }).status).toBe(
    "no_eligible_agent",
  );
  expect(
    registry.match({
      ...want,
      permissions: { dataAccess: "scoped_write", sensitiveWrites: "approval_required" },
    }).status,
  ).toBe("no_eligible_agent");
  expect(registry.match({ ...want, maxToolCalls: 99 }).status).toBe("no_eligible_agent");
  db.saveSeat({ ...db.getSeat("seat-data-steward-researcher"), label: "Dave" });
  expect(registry.assign({ task: { role: "data-steward-researcher" } })).toMatchObject({
    assignment: { agentId: "agent-alice" },
  });
});

it("reuses a verified specialist and attaches only reviewed task instructions", async () => {
  const { make, runtime, db } = fixture({
    agents: [["maintenance-specialist", "Maintenance", "agent-maint"]],
  });
  const registry = make({ enforcement: { authorizeSync: () => true } });
  const requirements = {
    capabilities: ["review_maintenance_history", "interpret_equipment_manual"],
    tools: [],
    permissions: { dataAccess: "none", sensitiveWrites: "denied" },
    skillIds: ["equipment-manual-review"],
  };
  const selection = registry.selectTask({ requirements });
  expect(selection).toMatchObject({
    status: "assigned",
    selectionReason: "reuse_verified_binding",
  });
  expect(runtime.management.mutate).not.toHaveBeenCalled();
  const result = await registry.dispatchOrchestration({
    requestId: "review-manual",
    selection,
    task: {
      taskId: "manual-task",
      message: "Inspect the supplied manual",
      skillIds: requirements.skillIds,
    },
  });
  expect(result.status).toBe("accepted");
  expect(db.getTask("manual-task").message).toContain("equipment-manual-review@1.0.0");
  expect(() => registry.taskSkills(selection.manifest, ["unreviewed-skill"])).toThrow();
  expect(
    registry.selectTask({ requirements: { ...requirements, tools: ["equipment.control"] } }).status,
  ).toBe("no_eligible_agent");
  expect(registry.selectTask({ requirements: { ...requirements, maxToolCalls: 1 } }).status).toBe(
    "no_eligible_agent",
  );
});

it("refuses to create an agent when its reviewed seat is occupied", async () => {
  const { make, runtime, db } = fixture({ agents: [] });
  db.saveSeat({
    seatId: "seat-occupied",
    label: "Busy",
    assigned: true,
    binding: { agentId: "another", sessionKey: "agent:another:main", revision: 1 },
  });
  const registry = make({
    profiles: {
      "maintenance-specialist": {
        seatId: "seat-occupied",
        name: "Maintenance",
        workspace: "approved",
      },
    },
  });
  await expect(
    registry.provision({ requestId: "occupied", manifestId: "maintenance-specialist" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(runtime.management.mutate).not.toHaveBeenCalled();
});

it("rejects changed bindings, disallowed enforcement, excessive retries, and concurrency", async () => {
  const { make, db } = fixture();
  const registry = make();
  const selection = registry.assign({ task: { role: "planner" } });
  db.saveSeat({
    ...db.getSeat("seat-planner"),
    binding: {
      ...db.getSeat("seat-planner").binding,
      revision: 2,
    },
  });
  await expect(
    registry.dispatch({
      requestId: "changed",
      selection,
      task: { taskId: "changed-task", message: "Plan" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  const current = registry.assign({ task: { role: "planner" } });
  await expect(
    registry.dispatch({
      requestId: "retry",
      selection: current,
      task: { taskId: "retry-task", message: "Plan", retryCount: 2 },
    }),
  ).rejects.toMatchObject({ status: 403 });
  const blocked = make({ enforcement: { authorize: async () => false } });
  await expect(
    blocked.dispatch({
      requestId: "blocked",
      selection: current,
      task: { taskId: "blocked-task", message: "Plan" },
    }),
  ).rejects.toMatchObject({ status: 403 });
  for (let i = 0; i < 2; i++)
    db.insertTask({
      taskId: `busy-${i}`,
      message: "Busy",
      status: "running",
      seatId: current.assignment!.seatId,
      agentId: current.assignment!.agentId,
      sessionKey: current.assignment!.sessionKey,
      gatewayId: current.assignment!.gatewayId,
      bindingRevision: current.assignment!.bindingRevision,
      createdAt: new Date().toISOString(),
    });
  await expect(
    registry.dispatch({
      requestId: "concurrent",
      selection: current,
      task: { taskId: "concurrent-task", message: "Plan" },
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("rechecks binding after asynchronous enforcement and before queue submission", async () => {
  const { make, db, runtime } = fixture();
  const registry = make({
    enforcement: {
      authorize: async () => {
        const seat = db.getSeat("seat-planner");
        db.saveSeat({ ...seat, binding: { ...seat.binding, revision: 2 } });
        return true;
      },
    },
  });
  const selection = registry.assign({ task: { role: "planner" } });
  await expect(
    registry.dispatch({
      requestId: "late-binding",
      selection,
      task: { taskId: "late-binding-task", message: "Plan" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(runtime.submit).not.toHaveBeenCalled();
});

it("uses durable dispatch IDs and leaves timeout or disconnected sends unresolved after restart", async () => {
  let now = Date.parse("2026-10-26T00:00:00.000Z");
  const { make, runtime, journal, db } = fixture();
  const registry = make({ now: () => now });
  const selection = registry.assign({ task: { role: "planner" } });
  const input = { requestId: "same", selection, task: { taskId: "task-1", message: "Plan" } };
  expect((await registry.dispatch(input)).status).toBe("accepted");
  expect((await registry.dispatch(input)).status).toBe("accepted");
  expect(runtime.submit).toHaveBeenCalledTimes(1);
  await expect(
    registry.dispatch({ ...input, task: { taskId: "task-2", message: "Different" } }),
  ).rejects.toMatchObject({ status: 409 });
  now += 301000;
  expect((await registry.reconcileDispatch("lane-d-same")).status).toBe("outcome_unknown");
  expect(runtime.cancel).toHaveBeenCalledWith("task-1");
  registry.close();
  registries.splice(registries.indexOf(registry), 1);
  const restarted = make({ now: () => now });
  expect((await restarted.dispatch(input)).status).toBe("outcome_unknown");
  expect(runtime.submit).toHaveBeenCalledTimes(1);
  journal.put("dispatch", "lane-d-disconnected", { taskId: "absent", status: "sending" });
  restarted.close();
  registries.splice(registries.indexOf(restarted), 1);
  make({ now: () => now });
  expect(journal.get("dispatch", "lane-d-disconnected").status).toBe("outcome_unknown");
  expect(db.getTask("absent")).toBeNull();
});

it("never repeats uncertain provisioning and binds only a confirmed discovered agent", async () => {
  const { make, runtime, journal } = fixture({ agents: [["planner", "Dave", "agent-dave"]] });
  const registry = make();
  runtime.management.mutate.mockResolvedValueOnce({ status: "outcome_unknown" });
  const first = await registry.provision({ requestId: "provision-1", manifestId: "critic" });
  expect(first.status).toBe("outcome_unknown");
  expect(
    (await registry.provision({ requestId: "provision-1", manifestId: "critic" })).status,
  ).toBe("outcome_unknown");
  expect(runtime.management.mutate).toHaveBeenCalledTimes(1);
  await expect(
    registry.provision({ requestId: "provision-2", manifestId: "critic" }),
  ).rejects.toMatchObject({ status: 409 });
  journal.put("provision", first.id, { ...first, status: "rejected" });
  const pending = await registry.provision({ requestId: "provision-2", manifestId: "critic" });
  expect(pending.status).toBe("binding_pending");
  expect(pending).toMatchObject({
    templateVersion: "1.0.0",
    selectionReason: "provision_required",
    requester: { kind: "user" },
    permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
  });
  expect(runtime.saveSeat).not.toHaveBeenCalled();
  runtime.agents.push({ agentId: "agent-new" });
  expect(registry.finishBinding(pending).status).toBe("bound");
  const reused = registry.assign({ task: { role: "critic" } });
  expect(reused).toMatchObject({
    selectionReason: "confirmed_provision",
    assignment: { agentId: "agent-new" },
  });
  const dispatched = await registry.dispatch({
    requestId: "critic-after-provision",
    selection: reused,
    task: { taskId: "critic-bounded-task", message: "Review a cited record", retryCount: 0 },
  });
  expect(dispatched).toMatchObject({
    status: "accepted",
    templateVersion: "1.0.0",
    selectionReason: "confirmed_provision",
    permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
  });
  expect(runtime.db.getTask("critic-bounded-task")?.agentId).toBe("agent-new");
  await expect(
    registry.provision({ requestId: "provision-3", manifestId: "critic" }),
  ).rejects.toThrow(/available for reuse/);
});

it("replays an older uncertain dispatch hash without resending after requester metadata is added", () => {
  const { make, runtime, journal } = fixture();
  const registry = make();
  const selection = registry.assign({ task: { role: "critic" } });
  const oldSelection = { ...selection } as { selectionReason?: string };
  delete oldSelection.selectionReason;
  const task = { taskId: "legacy-uncertain", message: "Review", retryCount: 0 };
  const oldHash = createHash("sha256")
    .update(JSON.stringify({ selection: oldSelection, task }))
    .digest("hex");
  journal.put("dispatch", "lane-d-legacy-request", {
    requestHash: oldHash,
    taskId: task.taskId,
    status: "outcome_unknown",
  });
  expect(
    registry.dispatchOrchestration({
      requestId: "legacy-request",
      selection,
      task: { ...task, requester: { kind: "user" } },
    }).status,
  ).toBe("outcome_unknown");
  expect(runtime.submit).not.toHaveBeenCalled();
});

it("records mocked Dave-to-Alice and Bob-to-Carol messages with distinct identities and real responses", async () => {
  const { make, db } = fixture();
  const registry = make({
    evidence: {
      get: (id: string) =>
        id === "record-1" ? { evidenceId: id, incidentId: "incident-1" } : null,
    },
  });
  for (const [role, parentTaskId] of [
    ["planner", "parent-dave"],
    ["executor", "parent-bob"],
  ]) {
    const selection = registry.assign({ task: { role } });
    db.insertTask({
      taskId: parentTaskId,
      message: "Investigate",
      status: "running",
      ...selection.assignment,
      createdAt: new Date().toISOString(),
    });
  }
  const pairs = [
    {
      correlationId: "dave-alice",
      incidentId: "incident-1",
      fromManifestId: "planner",
      toManifestId: "data-steward-researcher",
      parentTaskId: "parent-dave",
      childTaskId: "child-alice",
      message: "Check inventory evidence",
      evidenceIds: ["record-1"],
    },
    {
      correlationId: "bob-carol",
      incidentId: "incident-2",
      fromManifestId: "executor",
      toManifestId: "critic",
      parentTaskId: "parent-bob",
      childTaskId: "child-carol",
      message: "Review execution evidence",
      evidenceIds: [],
    },
  ];
  for (const input of pairs) {
    const sent = await registry.send(input);
    expect(sent.status).toBe("awaiting_response");
    expect(sent.from.agentId).not.toBe(sent.to.agentId);
    expect(sent.sendResult.status).toBe("accepted");
    expect(sent.parentTaskId).toBe(input.parentTaskId);
    expect(sent.childTaskId).toBe(input.childTaskId);
    expect(sent.evidenceIds).toEqual(input.evidenceIds ?? []);
    expect((await registry.send(input)).revision).toBe(sent.revision);
    db.updateTask(input.childTaskId, {
      status: "completed",
      result: `Reply to ${input.message}`,
      completedAt: new Date().toISOString(),
      runId: `run-${input.correlationId}`,
    });
    const response = registry.reconcileMessage(input.correlationId);
    expect(response.status).toBe("responded");
    expect(response.response).toBe(`Reply to ${input.message}`);
    expect(response.respondedAt).toBeTruthy();
  }
});

it("denies unreviewed sender tasks and keeps missing replies unresolved", async () => {
  const { make, db } = fixture();
  const registry = make();
  const input = {
    correlationId: "missing",
    incidentId: "incident-3",
    fromManifestId: "planner",
    toManifestId: "critic",
    parentTaskId: "wrong-parent",
    childTaskId: "child-missing",
    message: "Review",
  };
  await expect(registry.send(input)).rejects.toMatchObject({ status: 409 });
  await expect(
    registry.send({ ...input, evidenceIds: ["missing-evidence"] }),
  ).rejects.toMatchObject({ status: 409 });
  const from = registry.assign({ task: { role: "planner" } });
  db.insertTask({
    taskId: input.parentTaskId,
    message: "Plan",
    status: "running",
    ...from.assignment,
    createdAt: new Date().toISOString(),
  });
  expect((await registry.send(input)).status).toBe("awaiting_response");
  db.updateTask(input.childTaskId, { status: "completed", result: "" });
  expect(registry.reconcileMessage(input.correlationId).status).toBe("unresolved");
});

it("checks isolated worker sessions against sessions.list instead of trusting seat labels", async () => {
  const { make, db, runtime } = fixture({ agents: [["planner", "Dave", "agent-dave"]] });
  db.saveSeat({
    seatId: "worker-research",
    label: "Alice",
    seatType: "worker",
    assigned: true,
    binding: {
      seatId: "worker-research",
      agentId: "agent-dave",
      sessionKey: "agent:agent-dave:isolated",
      revision: 1,
    },
  });
  const registry = make({
    grants: [
      { manifestId: "planner", seatId: "seat-planner" },
      {
        manifestId: "data-steward-researcher",
        seatId: "worker-research",
        sessionKey: "agent:agent-dave:isolated",
      },
    ],
  });
  expect(registry.assign({ task: { role: "data-steward-researcher" } }).status).toBe(
    "no_eligible_agent",
  );
  runtime.gateway.request.mockResolvedValueOnce({
    sessions: [{ key: "agent:agent-dave:isolated", agentId: "agent-dave" }],
  });
  await registry.refreshSessions();
  expect(registry.assign({ task: { role: "data-steward-researcher" } })).toMatchObject({
    assignment: { sessionKey: "agent:agent-dave:isolated" },
  });
  expect(registry.assign({ task: { role: "planner" } }).assignment!.agentId).toBe(
    registry.assign({ task: { role: "data-steward-researcher" } }).assignment!.agentId,
  );
});

it("recovers an uncertain provision and queued dispatch from a reopened SQLite journal", async () => {
  const first = fixture({ agents: [["planner", "Dave", "agent-dave"]] });
  const registry = first.make();
  const selection = registry.assign({ task: { role: "planner" } });
  const input = {
    requestId: "restart-task",
    selection,
    task: { taskId: "restart-child", message: "Plan" },
  };
  await registry.dispatch(input);
  first.journal.put("provision", "lane-d-restart-provision", {
    manifestId: "critic",
    seatId: "seat-new",
    status: "sending",
  });
  registry.close();
  registries.splice(registries.indexOf(registry), 1);
  first.db.close();
  databases.splice(databases.indexOf(first.db), 1);
  const second = fixture({ filename: first.filename, agents: [["planner", "Dave", "agent-dave"]] });
  const recovered = second.make();
  expect(second.journal.get("provision", "lane-d-restart-provision").status).toBe(
    "outcome_unknown",
  );
  expect((await recovered.dispatch(input)).status).toBe("accepted");
  expect(second.runtime.submit).not.toHaveBeenCalled();
  expect(second.db.getTask("restart-child").agentId).toBe("agent-dave");
});
