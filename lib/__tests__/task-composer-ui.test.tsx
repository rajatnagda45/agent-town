// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import TaskComposer from "@/components/hud/TaskComposer";
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../store", () => ({ runtimeRequest: request }));
afterEach(() => {
  cleanup();
  request.mockReset();
  sessionStorage.clear();
});
const task = {
  id: "compose-one",
  status: "approval_required",
  input: { goal: "Change inventory by three units" },
  route: {
    workflow: "inventory-investigation",
    dataSources: ["inventory"],
    risk: "approval_required",
    confidence: 0.96,
    successCriteria: ["Verify inventory"],
    clarification: null,
  },
  evidence: [],
  attempts: [],
  checks: [],
  actions: [{ kind: "mutation", status: "proposed", executed: false }],
  verdict: null,
};
it("uses one goal, optional context, and displays a mutation as an unexecuted proposal", async () => {
  request.mockImplementation(async (path: string, body?: unknown) =>
    path === "composer" && body ? { task } : { tasks: [] },
  );
  render(<TaskComposer />);
  fireEvent.change(screen.getByLabelText("Team goal"), { target: { value: task.input.goal } });
  fireEvent.click(screen.getByText("Start task"));
  await screen.findByText("Record explicit approval");
  expect(screen.getByText(/not executed/)).toBeTruthy();
  expect(request.mock.calls.find(([path, body]) => path === "composer" && body)?.[1]).toMatchObject(
    { goal: task.input.goal, successCriteria: [], constraints: [], attachments: [] },
  );
  expect(sessionStorage.getItem("agent-town:composer:selected")).toBe(task.id);
});
it("restores selection after reload and sends explicit correction instead of a workflow selector", async () => {
  sessionStorage.setItem("agent-town:composer:selected", task.id);
  request.mockImplementation(async (_path: string, body?: { goal?: string }) =>
    body ? { task: { ...task, input: { goal: body.goal } } } : { tasks: [task] },
  );
  render(<TaskComposer />);
  await screen.findByText("Correct interpretation");
  fireEvent.click(screen.getByText("Correct interpretation"));
  fireEvent.change(screen.getByLabelText("Clarification or corrected goal"), {
    target: { value: "Investigate inventory without changing stock" },
  });
  fireEvent.click(screen.getByText("Use corrected goal"));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("composer/compose-one/correct", {
      goal: "Investigate inventory without changing stock",
    }),
  );
  expect(screen.queryByLabelText("Workflow")).toBeNull();
});
it("shows the checked contract and each stage's routing decision without sending them", async () => {
  sessionStorage.setItem("agent-town:composer:selected", task.id);
  const routed = {
    ...task,
    status: "analyzing",
    input: { goal: "Create a 30-minute Agent Town demo agenda" },
    contract: {
      source: "inferred",
      deliverable: { kind: "agenda", minutes: 30, mode: "exact" },
    },
    attempts: [
      {
        taskId: "t1",
        role: "nightshift-planner",
        stage: "planner",
        seatId: "plan",
        executionDecision: {
          runtime: "nightshift",
          modelProvider: "unknown",
          model: "meterless/auto",
          reason: ["only eligible option for the required capabilities, tools and permissions"],
          rejected: [{ optionId: "openclaw-tools", missing: ["authenticated healthy runtime"] }],
        },
      },
    ],
  };
  request.mockImplementation(async () => ({ tasks: [routed] }));
  render(<TaskComposer />);
  expect((await screen.findByLabelText("Deliverable contract")).textContent).toContain(
    "agenda · exactly 30 min (from your request)",
  );
  expect(screen.getByText(/nightshift · model provider unknown/)).toBeTruthy();
  expect(screen.getByText(/openclaw-tools \(authenticated healthy runtime\)/)).toBeTruthy();
});
it("searches past tasks and links each result to its Work Report", async () => {
  request.mockImplementation(async (path: string) =>
    path.startsWith("search?q=")
      ? {
          results: [
            {
              taskId: "compose_pump",
              goal: "Find the CR 10 pump manual",
              status: "completed",
              snippet: "[pump] manual",
              link: "/work/compose_pump",
            },
          ],
        }
      : { tasks: [] },
  );
  render(<TaskComposer />);
  fireEvent.change(screen.getByLabelText("Search past tasks"), { target: { value: "pump" } });
  fireEvent.click(screen.getByText("Search"));
  const link = await screen.findByRole("link", { name: "Find the CR 10 pump manual" });
  expect(link.getAttribute("href")).toBe("/work/compose_pump");
  expect(request).toHaveBeenCalledWith("search?q=pump");
});

it("recovers history on runtime refresh without clearing a submission error", async () => {
  request.mockRejectedValueOnce(new Error("History offline"));
  const { rerender } = render(<TaskComposer refreshToken={0} />);
  await screen.findByText(/History offline/);
  request.mockResolvedValue({ tasks: [] });
  rerender(<TaskComposer refreshToken={1} />);
  await waitFor(() => expect(screen.queryByText(/History offline/)).toBeNull());
  request.mockRejectedValueOnce(new Error("Submission rejected"));
  fireEvent.change(screen.getByLabelText("Team goal"), { target: { value: "Prepare a report" } });
  fireEvent.click(screen.getByText("Start task"));
  await screen.findByText("Submission rejected");
  request.mockResolvedValue({ tasks: [] });
  rerender(<TaskComposer refreshToken={2} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  expect(screen.getByText("Submission rejected")).toBeTruthy();
  expect((screen.getByLabelText("Team goal") as HTMLTextAreaElement).value).toBe(
    "Prepare a report",
  );
});

it("locks draft inputs during submission and reuses the same identity on retry", async () => {
  let reject: (error: Error) => void = () => {};
  request.mockImplementation((_path: string, body?: unknown) =>
    body
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve({ tasks: [] }),
  );
  render(<TaskComposer />);
  const goal = screen.getByLabelText("Team goal") as HTMLTextAreaElement;
  fireEvent.change(goal, { target: { value: "Prepare a report" } });
  fireEvent.click(screen.getByText("Start task"));
  expect(goal.closest("fieldset")?.disabled).toBe(true);
  const first = request.mock.calls.find(([, body]) => body)?.[1];
  reject(new Error("Response lost"));
  await screen.findByText("Response lost");
  request.mockResolvedValue({ task });
  fireEvent.click(screen.getByText("Start task"));
  await screen.findByText("Record explicit approval");
  expect(
    request.mock.calls.filter(([, body]) => body).map(([, body]) => body.submissionId),
  ).toEqual([first.submissionId, first.submissionId]);
});

it("downloads the selected persisted record without executing or approving anything", async () => {
  sessionStorage.setItem("agent-town:composer:selected", task.id);
  request.mockResolvedValue({ tasks: [task] });
  render(<TaskComposer />);
  const link = await screen.findByRole("link", { name: "Download investigation record" });
  const exported = JSON.parse(decodeURIComponent(link.getAttribute("href")!.split(",")[1]));
  expect(exported).toMatchObject({ taskId: task.id, status: "approval_required", report: null });
  expect(exported.actions[0].executed).toBe(false);
  expect(link.getAttribute("download")).toBe("agent-town-compose-one.json");
  expect(request).toHaveBeenCalledTimes(1);
});
