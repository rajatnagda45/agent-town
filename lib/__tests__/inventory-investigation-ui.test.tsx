// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import OperationsPanel from "@/components/hud/OperationsPanel";
import InventoryInvestigationPanel from "@/components/hud/InventoryInvestigationPanel";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../store", () => ({
  runtimeRequest: request,
  useStudio: () => ({ state: { seats: [], tasks: [], reviews: [] } }),
}));

class Stream {
  static active: Stream | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    Stream.active = this;
  }
  close() {
    Stream.active = null;
  }
}

const evidence = [
  {
    evidenceId: "proof-1",
    taskId: "analyst-task",
    source: "synthetic:inventory_cycle_counts",
    sourceTimestamp: "2026-10-26T00:00:00Z",
    freshUntil: "2026-10-27T00:00:00Z",
  },
];
const investigation = (report: unknown = null) => ({
  incidentId: "inventory-1",
  goal: "Explain the SKU-17 shortage",
  criteria: {
    scenarioId: "incomplete",
    sku: "SKU-17",
    locationId: "BIN-A",
    ledgerQuantity: 12,
    physicalQuantity: 9,
    maxUnexplainedUnits: 0,
  },
  acceptanceCriteria: [{ criterionId: "count", description: "Explain all three missing units." }],
  status: report ? "awaiting_verification" : "running",
  revisionOf: null,
  revisedIncidentId: null,
  tasks: [
    {
      nodeId: "planner",
      taskId: "planner-task",
      role: "planner",
      dependencies: [],
      status: "completed",
      selectionReason: "reviewed_grant",
      specialist: "planner",
      retryCount: 0,
    },
    {
      nodeId: "analyst",
      taskId: "analyst-task",
      role: "data-steward-researcher",
      dependencies: ["planner"],
      status: report ? "completed" : "running",
      selectionReason: "reviewed_grant",
      specialist: "data-steward-researcher",
      retryCount: 0,
    },
    {
      nodeId: "critic",
      taskId: "critic-task",
      role: "critic",
      dependencies: ["analyst"],
      status: report ? "completed" : "waiting",
      selectionReason: null,
      specialist: null,
      retryCount: 0,
    },
  ],
  evidence: report ? evidence : [],
  synthetic: !!report,
  hypothesis: report ? "Damaged stock explains the shortage." : null,
  critique: report ? { hypothesisSupported: true, missingEvidence: [] } : null,
  report,
});

afterEach(() => {
  cleanup();
  request.mockReset();
  vi.unstubAllGlobals();
  Stream.active = null;
  sessionStorage.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps the submission response ID selectable when an earlier list request finishes late", async () => {
  const oldList = deferred<{ investigations: [] }>();
  request.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "investigations")
      return body ? { investigation: investigation() } : oldList.promise;
    if (path === "investigations/inventory-1") return { investigation: investigation() };
    throw new Error(path);
  });
  render(<InventoryInvestigationPanel />);
  for (const [label, value] of [
    ["Goal", "Explain shortage"],
    ["Evidence scenario", "complete"],
    ["SKU", "SKU-17"],
    ["Location", "BIN-A"],
    ["Ledger units", "12"],
    ["Physical units", "9"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));
  await screen.findByText("Explain all three missing units.");
  await act(async () => oldList.resolve({ investigations: [] }));
  expect((screen.getByLabelText("Open investigation") as HTMLSelectElement).value).toBe(
    "inventory-1",
  );
});

it("refreshes Planner completion from SSE even when the overview is unavailable", async () => {
  vi.stubGlobal("EventSource", Stream);
  let current = investigation();
  request.mockImplementation(async (path: string) => {
    if (path === "office-overview") throw new Error("Overview unavailable");
    if (path === "investigations")
      return { investigations: [{ incidentId: current.incidentId, goal: current.goal }] };
    if (path === "investigations/inventory-1") return { investigation: current };
    throw new Error(path);
  });
  render(<OperationsPanel />);
  await screen.findByText("Explain all three missing units.");
  current = {
    ...current,
    tasks: current.tasks.map((task) =>
      task.nodeId === "planner" ? { ...task, status: "waiting_planner_validation" } : task,
    ),
  };
  act(() =>
    Stream.active?.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ kind: "orchestration" }) }),
    ),
  );
  expect(await screen.findByRole("button", { name: "Validate Planner output" })).toBeTruthy();
});

it("does not let an older detail response undo a completed action", async () => {
  const initial = {
    ...investigation(),
    tasks: investigation().tasks.map((task) => ({ ...task, status: "waiting_planner_validation" })),
  };
  const stale = deferred<{ investigation: typeof initial }>();
  let reads = 0;
  request.mockImplementation(async (path: string) => {
    if (path === "investigations")
      return { investigations: [{ incidentId: initial.incidentId, goal: initial.goal }] };
    if (path === "investigations/inventory-1")
      return ++reads === 2 ? stale.promise : { investigation: initial };
    if (path.endsWith("/accept-plan"))
      return {
        investigation: {
          ...initial,
          tasks: initial.tasks.map((task) => ({ ...task, status: "running" })),
        },
      };
    throw new Error(path);
  });
  const view = render(<InventoryInvestigationPanel refreshToken={0} />);
  await screen.findByRole("button", { name: "Validate Planner output" });
  view.rerender(<InventoryInvestigationPanel refreshToken={1} />);
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Validate Planner output" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Validate Planner output" })).toBeNull(),
  );
  await act(async () => stale.resolve({ investigation: initial }));
  expect(screen.queryByRole("button", { name: "Validate Planner output" })).toBeNull();
});

it("ignores out-of-order detail responses and recovers the selected case after remount", async () => {
  const first = investigation();
  const second = {
    ...first,
    incidentId: "inventory-2",
    acceptanceCriteria: [{ criterionId: "second", description: "Second case criteria" }],
  };
  const stale = deferred<{ investigation: typeof first }>();
  let reads = 0;
  request.mockImplementation(async (path: string) => {
    if (path === "investigations") return { investigations: [first, second] };
    if (path === "investigations/inventory-1")
      return ++reads === 2 ? stale.promise : { investigation: first };
    if (path === "investigations/inventory-2") return { investigation: second };
    throw new Error(path);
  });
  const view = render(<InventoryInvestigationPanel refreshToken={0} />);
  await screen.findByText("Explain all three missing units.");
  view.rerender(<InventoryInvestigationPanel refreshToken={1} />);
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.change(screen.getByLabelText("Open investigation"), {
    target: { value: "inventory-2" },
  });
  await screen.findByText("Second case criteria");
  await act(async () => stale.resolve({ investigation: first }));
  expect(screen.queryByText("Explain all three missing units.")).toBeNull();
  view.unmount();
  render(<InventoryInvestigationPanel />);
  expect(await screen.findByText("Second case criteria")).toBeTruthy();
});

it("shows a user-started investigation and only displays the final backend verdict after reconnect", async () => {
  vi.stubGlobal("EventSource", Stream);
  let current = investigation();
  let started = false;
  let cursor = 1;
  request.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "office-overview")
      return {
        cursor: cursor++,
        generatedAt: new Date().toISOString(),
        plans: [],
        operationTasks: [],
        verification: [],
        evidence: [],
        events: [],
      };
    if (path === "investigations" && body) {
      started = true;
      return { investigation: current };
    }
    if (path === "investigations")
      return {
        investigations: started
          ? [{ incidentId: current.incidentId, goal: current.goal, verdict: null }]
          : [],
      };
    if (path === "investigations/inventory-1") return { investigation: current };
    if (path.endsWith("/evidence/proof-1"))
      return {
        evidence: {
          ...evidence[0],
          recordId: "COUNT-17",
          retrievedAt: "2026-10-26T00:01:00Z",
          content: { system_qty: 12, counted_qty: 9 },
        },
      };
    throw new Error(`Unexpected route: ${path}`);
  });
  render(<OperationsPanel />);
  fireEvent.change(screen.getByLabelText("Goal"), {
    target: { value: "Explain the SKU-17 shortage" },
  });
  fireEvent.change(screen.getByLabelText("Evidence scenario"), { target: { value: "incomplete" } });
  fireEvent.change(screen.getByLabelText("SKU"), { target: { value: "SKU-17" } });
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "BIN-A" } });
  fireEvent.change(screen.getByLabelText("Ledger units"), { target: { value: "12" } });
  fireEvent.change(screen.getByLabelText("Physical units"), { target: { value: "9" } });
  fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));
  expect(await screen.findByText("Explain all three missing units.")).toBeTruthy();
  expect(screen.queryByText("Final report", { exact: false })).toBeNull();
  expect(request).toHaveBeenCalledWith(
    "investigations",
    expect.objectContaining({
      goal: "Explain the SKU-17 shortage",
      criteria: expect.objectContaining({ ledgerQuantity: 12, physicalQuantity: 9 }),
    }),
  );

  current = investigation({
    verdict: "pass",
    checkedAt: "2026-10-26T00:05:00Z",
    verificationId: "verified-1",
    evidenceIds: ["proof-1"],
    hypothesis: "Damaged stock explains the shortage.",
    reconciliation: { discrepancy: 3, explained: 3, unexplained: 0 },
    issues: [],
    missingEvidence: [],
  });
  Stream.active?.onerror?.();
  Stream.active?.onopen?.();
  expect(await screen.findByText("Final report · pass")).toBeTruthy();
  expect(screen.getByText("Verdict: pass")).toBeTruthy();
  expect(screen.getByText("SYNTHETIC DATA")).toBeTruthy();
  expect(screen.getByText(/Discrepancy 3/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "proof-1" })[0]);
  await waitFor(() => expect(screen.getByText("Record COUNT-17", { exact: false })).toBeTruthy());
});

it("shows Critic rejection and opens only the revision returned by the backend", async () => {
  vi.stubGlobal("EventSource", Stream);
  const rejected = {
    ...investigation({
      verdict: "revise",
      checkedAt: "2026-10-26T00:05:00Z",
      verificationId: "rejected-1",
      evidenceIds: ["proof-1"],
      hypothesis: "Damage may explain part of the shortage.",
      reconciliation: { discrepancy: 3, explained: 2, unexplained: 1 },
      issues: [],
      missingEvidence: ["One unit needs source-backed explanation."],
    }),
    critique: { hypothesisSupported: false, missingEvidence: ["One unit remains unverified."] },
  };
  const revised = {
    ...investigation(),
    incidentId: "inventory-2",
    revisionOf: "inventory-1",
    goal: "Resolve the missing unit",
  };
  request.mockImplementation(async (path: string) => {
    if (path === "office-overview")
      return {
        cursor: 1,
        generatedAt: new Date().toISOString(),
        plans: [],
        operationTasks: [],
        verification: [],
        evidence: [],
        events: [],
      };
    if (path === "investigations")
      return {
        investigations: [{ incidentId: "inventory-1", goal: rejected.goal, verdict: "revise" }],
      };
    if (path === "investigations/inventory-1") return { investigation: rejected };
    if (path === "investigations/inventory-1/revise") return { investigation: revised };
    if (path === "investigations/inventory-2") return { investigation: revised };
    throw new Error(`Unexpected route: ${path}`);
  });
  render(<OperationsPanel />);
  expect(await screen.findByText("Critic rejected the hypothesis.")).toBeTruthy();
  expect(screen.getByText("One unit needs source-backed explanation.")).toBeTruthy();
  fireEvent.change(await screen.findByLabelText("Revision evidence scenario"), {
    target: { value: "complete" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start one revision" }));
  expect((await screen.findAllByText("Resolve the missing unit")).length).toBeGreaterThan(0);
  expect(request).toHaveBeenCalledWith("investigations/inventory-1/revise", {
    scenarioId: "complete",
  });
});

it("exposes each persisted Planner, evidence, Analyst, Critic, and revision action in order", async () => {
  const steps: string[] = [];
  let current = {
    ...investigation(),
    revisionOf: null as string | null,
    tasks: [
      ...investigation().tasks.map((task) =>
        task.nodeId === "planner" ? { ...task, status: "waiting_planner_validation" } : task,
      ),
      { ...investigation().tasks[1], nodeId: "reader", status: "waiting" },
    ],
    readsCollected: false,
    evidenceConfirmed: false,
    analystValidated: false,
  };
  request.mockImplementation(async (path: string, body?: unknown) => {
    if (path === "investigations")
      return {
        investigations: [{ incidentId: current.incidentId, goal: current.goal, verdict: null }],
      };
    if (path === `investigations/${current.incidentId}`) return { investigation: current };
    if (path === `investigations/${current.incidentId}/accept-plan`) {
      steps.push("accept-plan");
      current = {
        ...current,
        tasks: current.tasks.map((task) =>
          task.nodeId === "reader" ? { ...task, status: "completed" } : task,
        ),
      };
    } else if (path === `investigations/${current.incidentId}/collect-evidence`) {
      steps.push("collect-evidence");
      current = { ...current, readsCollected: true, synthetic: true, evidence };
    } else if (path === `investigations/${current.incidentId}/confirm-evidence`) {
      steps.push("confirm-evidence");
      current = {
        ...current,
        evidenceConfirmed: true,
        tasks: current.tasks.map((task) =>
          task.nodeId === "analyst" ? { ...task, status: "completed" } : task,
        ),
      };
    } else if (path === `investigations/${current.incidentId}/accept-analyst`) {
      steps.push("accept-analyst");
      current = { ...current, analystValidated: true, status: "awaiting_verification" };
    } else if (path === `investigations/${current.incidentId}/finish`) {
      steps.push("finish");
      current = {
        ...current,
        report: {
          verdict: "revise",
          checkedAt: new Date().toISOString(),
          verificationId: "review-1",
          evidenceIds: ["proof-1"],
          hypothesis: "Two units explained",
          reconciliation: {
            discrepancy: 3,
            explained: 2,
            unexplained: 1,
          },
          issues: [],
          missingEvidence: ["One unit missing"],
        },
      };
    } else if (path === `investigations/${current.incidentId}/revise`) {
      steps.push("revise");
      current = {
        ...current,
        incidentId: "inventory-2",
        revisionOf: "inventory-1",
        report: null,
        readsCollected: false,
        evidenceConfirmed: false,
        analystValidated: false,
        evidence: [],
        synthetic: false,
      };
    } else throw new Error(`Unexpected route: ${path} ${String(body)}`);
    return { investigation: current };
  });
  render(<InventoryInvestigationPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Validate Planner output" }));
  fireEvent.click(await screen.findByRole("button", { name: "Collect inventory evidence" }));
  expect(await screen.findByText("SYNTHETIC DATA")).toBeTruthy();
  fireEvent.click(
    await screen.findByRole("button", { name: "Check evidence and dispatch Analyst" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Validate Analyst result" }));
  fireEvent.click(await screen.findByRole("button", { name: "Check evidence and record verdict" }));
  fireEvent.change(await screen.findByLabelText("Revision evidence scenario"), {
    target: { value: "complete" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Start one revision" }));
  expect(steps).toEqual([
    "accept-plan",
    "collect-evidence",
    "confirm-evidence",
    "accept-analyst",
    "finish",
    "revise",
  ]);
  await waitFor(() =>
    expect((screen.getByLabelText("Open investigation") as HTMLSelectElement).value).toBe(
      "inventory-2",
    ),
  );
});
