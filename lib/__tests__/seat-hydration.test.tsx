// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioProvider, useStudio } from "../store";
import { LS_SEAT_CONFIG } from "../constants";
import { gameEvents } from "../events";
function Roster() {
  const { state } = useStudio();
  return (
    <div>
      {state.seats.map((s) => (
        <span key={s.seatId}>
          {s.label}: {s.roleTitle}
        </span>
      ))}
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
it("preserves saved profiles while the initial roster is empty, then hydrates discovered seats from the server", async () => {
  const saved = [
    {
      seatId: "seat-0",
      assigned: true,
      seatType: "worker",
      label: "Saved colleague",
      roleTitle: "Reviewer",
    },
  ];
  localStorage.setItem(LS_SEAT_CONFIG, JSON.stringify(saved));
  const requests = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith("/state")
        ? {
            cursor: 0,
            seats: saved,
            tasks: [],
            sessions: [],
            connection: "disconnected",
            capabilities: {},
          }
        : url.includes("/history")
          ? { messages: [], limited: false }
          : {},
  }));
  vi.stubGlobal("fetch", requests);
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  render(
    <StudioProvider>
      <Roster />
    </StudioProvider>,
  );
  expect(JSON.parse(localStorage.getItem(LS_SEAT_CONFIG)!)).toEqual(saved);
  act(() =>
    gameEvents.emit("seats-discovered", [
      { seatId: "seat-0", x: 100, y: 100, index: 0, facing: "down" },
    ]),
  );
  await waitFor(() => expect(screen.getByText("Saved colleague: Reviewer")).toBeTruthy());
  expect(requests).toHaveBeenCalledWith(
    "/api/runtime/import",
    expect.objectContaining({
      body: expect.stringContaining('"label":"Saved colleague"'),
    }),
  );
  expect(JSON.parse(localStorage.getItem(LS_SEAT_CONFIG)!)[0].label).toBe("Saved colleague");
});
