// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import OperationsPanel from "@/components/hud/OperationsPanel";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../store", () => ({
  runtimeRequest: request,
  useStudio: () => ({
    state: {
      seats: [
        {
          seatId: "lead",
          label: "Office Lead",
          roleTitle: "Team Lead",
          assigned: true,
          binding: { agentId: "main" },
        },
      ],
      tasks: [
        {
          taskId: "task-1",
          seatId: "lead",
          actorName: "Office Lead",
          message: "Investigate low pressure",
          status: "queued",
          createdAt: "2026-10-25T00:00:00Z",
        },
      ],
      reviews: [
        {
          id: "review-1",
          kind: "approval",
          status: "pending",
          agentId: "main",
          payload: { presentation: { title: "Adjust inventory" } },
        },
      ],
    },
  }),
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  constructor() {
    FakeEventSource.instances.push(this);
  }
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  close() {}
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
  sessionStorage.clear();
});

it("opens group-chat investigation links and restores the selected inventory workspace", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  request.mockResolvedValue({
    investigations: [],
    tasks: [],
    evidence: [],
    events: [],
    plans: [],
    operationTasks: [],
    verification: [],
  });
  const view = render(<OperationsPanel />);
  const details = view.container.querySelector(".legacy-inventory") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("agent-town:open-investigation", { detail: "inventory_group_case" }),
    );
  });
  expect(details.open).toBe(true);
  view.unmount();
  sessionStorage.setItem("agent-town:inventory:selected", "inventory_group_case");
  const restored = render(<OperationsPanel />);
  expect((restored.container.querySelector(".legacy-inventory") as HTMLDetailsElement).open).toBe(
    true,
  );
});

it("refetches the bounded view when the event stream reconnects", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const snapshot = (source: string) => ({
    cursor: 1,
    generatedAt: new Date().toISOString(),
    plans: [],
    operationTasks: [],
    verification: [],
    events: [],
    evidence: [
      {
        evidenceId: "e-1",
        taskId: "task-1",
        source,
        retrievedAt: new Date().toISOString(),
        revision: 1,
      },
    ],
  });
  let overviewReads = 0;
  request.mockImplementation(async (path: string) =>
    path === "investigations"
      ? { investigations: [] }
      : path === "composer"
        ? { tasks: [] }
        : snapshot(overviewReads++ === 0 ? "synthetic:first" : "synthetic:recovered"),
  );
  render(<OperationsPanel />);
  expect(await screen.findByText("synthetic:first")).toBeTruthy();
  FakeEventSource.instances[0].onerror?.();
  expect(await screen.findByText("Activity stream reconnecting")).toBeTruthy();
  FakeEventSource.instances[0].onopen?.();
  expect(await screen.findByText("synthetic:recovered")).toBeTruthy();
});

it("shows office work, approvals, evidence activity and an unresolved outcome", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  request.mockResolvedValue({
    cursor: 4,
    generatedAt: "2026-10-25T00:03:00Z",
    plans: [],
    operationTasks: [{ taskId: "task-1", role: "Data Steward", retryCount: 2, status: "queued" }],
    evidence: [
      {
        evidenceId: "e-1",
        taskId: "task-1",
        source: "pump log",
        retrievedAt: "2026-10-25T00:01:00Z",
        freshUntil: "2026-10-26T00:00:00Z",
        revision: 1,
      },
    ],
    verification: [
      {
        verificationId: "v-1",
        taskId: "task-1",
        verdict: "unresolved",
        reason: "Readings conflict",
        checkedAt: "2026-10-25T00:02:00Z",
        evidenceIds: ["e-1"],
      },
    ],
    events: [{ seq: 4, kind: "operation.verification", taskId: "task-1", id: "v-1" }],
  });
  render(<OperationsPanel />);
  expect(screen.getByText("Team Lead:")).toBeTruthy();
  expect(screen.getByText("Task task-1")).toBeTruthy();
  expect(screen.getByText("Review review-1")).toBeTruthy();
  expect(await screen.findByText("pump log")).toBeTruthy();
  expect(screen.getByText("Outcome recorded", { exact: false })).toBeTruthy();
  expect(screen.queryByText("Investigate low pressure")).toBeNull();
  expect(screen.queryByText("Readings conflict", { exact: false })).toBeNull();
  expect(screen.getByText("Data Steward: 2 retries")).toBeTruthy();
  expect(screen.getByText("#4 Verification recorded")).toBeTruthy();
});
