// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioProvider, useStudio } from "../store";
import { gameEvents } from "../events";
import { WorkRedirectNotice } from "../../components/ui/WorkRedirectNotice";

// A data request typed into a seat creates no seat task; the user is shown the Work report.
function AssignBox() {
  const { state, assignTask } = useStudio();
  const [result, setResult] = React.useState("");
  return (
    <div>
      <button
        onClick={async () =>
          setResult(String(await assignTask("Summarize five records from NY_TAXI zones", "seat-4")))
        }
      >
        Assign
      </button>
      <span>result: {result}</span>
      <span>available seats: {state.seats.filter((seat) => seat.binding?.available).length}</span>
      <span>tasks: {state.tasks.length}</span>
      <span>error: {state.runtimeError ?? "none"}</span>
      <WorkRedirectNotice redirect={state.workRedirect} />
    </div>
  );
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("shows the Work report link and records no seat task for a redirected data request", async () => {
  const seat = {
    seatId: "seat-4",
    label: "Orion",
    roleTitle: "OpenClaw Researcher",
    seatType: "agent",
    assigned: true,
    runtime: "openclaw",
    binding: {
      seatId: "seat-4",
      agentId: "town-researcher",
      sessionKey: "agent:town-researcher:main",
      revision: 1,
      available: true,
    },
  };
  const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.endsWith("/state")
        ? {
            cursor: 0,
            seats: [seat],
            tasks: [],
            sessions: [],
            connection: "connected",
            capabilities: {},
          }
        : url.endsWith("/tasks") && init?.method === "POST"
          ? {
              redirected: {
                composerTaskId: "cmp_1",
                status: "ready",
                reason: "This request needs data the seat agent cannot read.",
              },
            }
          : url.includes("/history")
            ? { messages: [], limited: false }
            : {};
      return { ok: true, json: async () => body };
    }),
  );
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  render(
    <StudioProvider>
      <AssignBox />
    </StudioProvider>,
  );
  act(() =>
    gameEvents.emit("seats-discovered", [
      { seatId: "seat-4", x: 100, y: 100, index: 4, facing: "down" },
    ]),
  );
  await screen.findByText("available seats: 1");
  fireEvent.click(screen.getByText("Assign"));
  const link = await screen.findByRole("link", { name: "Open the Work report" });
  expect(link.getAttribute("href")).toBe("/work/cmp_1");
  expect(screen.getByText("Sent to the verified work pipeline")).toBeTruthy();
  expect(screen.getByText("result: undefined")).toBeTruthy();
  expect(screen.getByText("tasks: 0")).toBeTruthy();
  expect(screen.getByText("error: none")).toBeTruthy();
  expect(posted.find((call) => call.url.endsWith("/tasks"))?.body).toMatchObject({
    seatId: "seat-4",
    message: "Summarize five records from NY_TAXI zones",
  });
});
