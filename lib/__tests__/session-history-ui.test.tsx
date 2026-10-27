// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { gameEvents } from "../events";
const fixture = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../store", () => ({
  useStudio: () => ({
    state: {
      seats: [{ seatId: "alice", label: "Alice" }],
      tasks: [],
      chatMessages: [],
      sessions: [{ key: "session-a", label: "Alice's session", createdAt: "2026-10-27" }],
    },
    getBoundSessionForSeat: () => "session-a",
    loadSessionChat: fixture.load,
  }),
}));
vi.mock("@/components/ui/useDialog", () => ({ useDialog: () => ({ current: null }) }));
import WorkerSessionHistoryModal from "@/components/panel/WorkerSessionHistoryModal";
afterEach(() => {
  cleanup();
  fixture.load.mockReset();
});
it("selects the first bound session and completes an empty history load once", async () => {
  fixture.load.mockResolvedValue([]);
  render(<WorkerSessionHistoryModal />);
  act(() => gameEvents.emit("open-session-history", "alice"));
  await screen.findByText("Alice's session");
  await waitFor(() => expect(fixture.load).toHaveBeenCalledWith("session-a"));
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
  expect(fixture.load).toHaveBeenCalledTimes(1);
});
it("shows an asynchronous history failure and retries explicitly", async () => {
  fixture.load.mockRejectedValueOnce(Error("offline")).mockResolvedValue([]);
  render(<WorkerSessionHistoryModal />);
  act(() => gameEvents.emit("open-session-history", "alice"));
  await screen.findByText("Could not load this conversation. Try again.");
  fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
  await waitFor(() =>
    expect(screen.queryByText("Could not load this conversation. Try again.")).toBeNull(),
  );
  expect(fixture.load).toHaveBeenCalledTimes(2);
});
