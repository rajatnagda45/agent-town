import React from "react";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OfficeOperations } from "../server/office-operations.mjs";
import { createDataReader } from "../server/data-source.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { officeOverview } from "../server/office-observability.mjs";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

const { request, stateRef } = vi.hoisted(() => ({
  request: vi.fn(),
  stateRef: {
    current: { seats: [] as unknown[], tasks: [] as unknown[], reviews: [] as unknown[] },
  },
}));
vi.mock("../store", () => ({
  runtimeRequest: request,
  useStudio: () => ({ state: stateRef.current }),
}));

class BrowserEvents {
  static active: BrowserEvents | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    BrowserEvents.active = this;
  }
  close() {
    BrowserEvents.active = null;
  }
  emit() {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ kind: "orchestration" }) }),
    );
  }
}
class Gateway {
  provider = "openclaw";
  audit = new ContractAudit(fixture);
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  listeners = new Set<(kind: string, data: unknown) => void>();
  subscribe(fn: (kind: string, data: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  capabilities() {
    return this.audit.capabilities(this.hello, true);
  }
  stop() {
    this.status = "disconnected";
  }
  request(method: string) {
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "bob" }, { id: "carol" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(() => {
  BrowserEvents.active?.close();
  stateRef.current = { seats: [], tasks: [], reviews: [] };
  request.mockReset();
  vi.unstubAllGlobals();
});

it("updates the office panel from registry dispatch through evidence and a revised outcome", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("MutationObserver", dom.window.MutationObserver);
  const { cleanup, render, screen } = await import("@testing-library/react");
  const { default: OperationsPanel } = await import("@/components/hud/OperationsPanel");
  vi.stubGlobal("EventSource", BrowserEvents);
  const db = new TaskDatabase(":memory:");
  const runtime = new TaskRuntime({ db, gateway: new Gateway(), gatewayId: "gateway-1" });
  let operations: OfficeOperations | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const close = () =>
    (cleanupPromise ??= (async () => {
      cleanup();
      await tick();
      dom.window.close();
      operations?.close();
      runtime.close();
      db.close();
    })());
  try {
    await runtime.refresh();
    for (const [seatId, agentId] of [
      ["data", "bob"],
      ["critic", "carol"],
    ])
      runtime.saveSeat({
        seatId,
        label: seatId,
        seatType: "agent",
        assigned: true,
        agentConfig: { agentId },
        revision: 0,
      });
    const now = new Date();
    const reader = createDataReader({
      mode: "synthetic",
      templates: {
        pump: {
          id: "pump",
          source: "pump_log",
          sql: "SELECT id, observed_at, pressure FROM pump_log",
          parameters: {},
          recordIdField: "id",
          timestampField: "observed_at",
          fields: ["pressure"],
          maxAgeMs: 600000,
        },
      },
      synthetic: createSyntheticDataSource({
        pump: {
          parameters: {},
          rows: [{ id: "log-1", observed_at: now.toISOString(), pressure: 185 }],
        },
      }),
    });
    operations = new OfficeOperations(runtime, {
      dataReader: reader,
      specialists: {
        grants: [
          { manifestId: "data-steward-researcher", seatId: "data" },
          { manifestId: "critic", seatId: "critic" },
        ],
        enforcement: { authorizeSync: () => true },
      },
    });
    Object.assign(runtime, { operations });
    request.mockImplementation(async () => officeOverview(runtime));
    const plan = operations.create({
      incident: {
        incidentId: "panel-incident",
        goal: "Explain low pressure",
        constraints: [],
        taskType: "investigation",
        acceptanceCriteria: [{ criterionId: "cause", description: "Check pressure evidence" }],
        createdAt: now.toISOString(),
      },
      tasks: [
        { taskId: "read", role: "data-steward-researcher", message: "Read pump log" },
        {
          taskId: "verify",
          role: "critic",
          message: "Verify pump log",
          dependencies: ["read"],
          requiredEvidenceFrom: ["read"],
        },
      ],
    });
    const dataTask = plan.children[0].operation.taskId;
    expect(operations.journal.list("dispatch")).toHaveLength(1);
    stateRef.current = { seats: db.seats(), tasks: [db.getTask(dataTask)], reviews: [] };
    render(<OperationsPanel />);
    expect((await screen.findAllByText("panel-incident")).length).toBeGreaterThan(0);

    db.updateTask(dataTask, { status: "completed", result: "Log read" });
    await tick();
    const read = await operations.readEvidence({
      incidentId: "panel-incident",
      taskId: dataTask,
      templateId: "pump",
      parameters: {},
    });
    const criticTask = operations.reconcile("panel-incident").children[1].operation.taskId;
    expect(operations.journal.list("dispatch")).toHaveLength(2);
    db.updateTask(criticTask, { status: "completed", result: "Evidence conflicts" });
    await tick();
    operations.reconcile("panel-incident");
    stateRef.current = {
      seats: db.seats(),
      tasks: [db.getTask(dataTask), db.getTask(criticTask)],
      reviews: [],
    };
    BrowserEvents.active?.emit();
    expect(
      (await screen.findAllByText("awaiting verification", { exact: false })).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("synthetic:pump_log")).toBeTruthy();
    expect(officeOverview(runtime).verification).toHaveLength(0);

    const result = operations.recordVerification({
      verification: {
        verificationId: "critic-revise",
        incidentId: "panel-incident",
        taskId: criticTask,
        verdict: "revise",
        evidenceIds: read.evidence.map((item: { evidenceId: string }) => item.evidenceId),
        reason: "Need another reading",
        checkedAt: new Date().toISOString(),
      },
      lesson: { content: "Unverified claim", applicability: "pump pressure" },
    });
    expect(result.lesson).toBeNull();
    BrowserEvents.active?.emit();
    expect((await screen.findAllByText("revise")).length).toBeGreaterThan(0);
    expect(officeOverview(runtime).verification).toHaveLength(1);
    expect(JSON.stringify(officeOverview(runtime))).not.toContain("Need another reading");
  } finally {
    await close();
  }
  // Passes alone; parallel worker startup and integrated UI work can exceed 10 seconds.
}, 20000);
