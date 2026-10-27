// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TeamBoardView, type TeamRun } from "@/components/work/TeamBoard";

afterEach(cleanup);
const run: TeamRun = {
  id: "team_1",
  goal: "Explain the slow tank refill",
  status: "working",
  assignments: [
    { id: "readings", title: "Tank readings", role: "nightshift-analyst", dependsOn: [] },
    {
      id: "limits",
      title: "Operating limits",
      role: "nightshift-analyst",
      dependsOn: ["readings"],
    },
  ],
  team: {
    status: "running",
    members: [
      {
        nodeId: "readings",
        role: "nightshift-analyst",
        seatId: "analyze",
        phase: "completed",
        attempts: 1,
        dependsOn: [],
        handoffChars: 62,
        steers: 0,
        missedSteers: 1,
        stopped: false,
        uncertainty: null,
      },
      {
        nodeId: "limits",
        role: "nightshift-analyst",
        seatId: "analyze",
        phase: "waiting",
        attempts: 0,
        dependsOn: ["readings"],
        handoffChars: 0,
        steers: 0,
        missedSteers: 0,
        stopped: false,
        uncertainty: null,
      },
    ],
  },
};

it("shows assignments, handoffs and dependencies, and steers or stops only pending work", () => {
  const onSteer = vi.fn();
  const onStop = vi.fn();
  render(<TeamBoardView run={run} onSteer={onSteer} onStop={onStop} />);
  expect(screen.getByText(/handed on 62 chars/)).toBeTruthy();
  expect(screen.getByText(/1 guidance arrived too late/)).toBeTruthy();
  expect(screen.getByText(/after Tank readings/)).toBeTruthy();
  expect(screen.queryByLabelText("Guidance for readings")).toBeNull();
  fireEvent.change(screen.getByLabelText("Guidance for limits"), {
    target: { value: "Quote page 12" },
  });
  fireEvent.click(screen.getByText("Steer"));
  expect(onSteer).toHaveBeenCalledWith("limits", "Quote page 12");
  fireEvent.click(screen.getByText("Stop"));
  expect(onStop).toHaveBeenCalledWith("limits");
});
