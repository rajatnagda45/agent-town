// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TerminalModal from "@/components/panel/TerminalModal";
import { gameEvents } from "@/lib/events";
const mock = vi.hoisted(() => ({ assign: vi.fn(), available: true }));
vi.mock("@/lib/store", () => ({
  useStudio: () => ({
    state: {
      connection: "connected",
      seats: [],
      capabilities: { "chat.send": { available: mock.available, reason: "Protocol missing" } },
    },
    assignTask: mock.assign,
    prepareSessionForSeat: vi.fn(),
  }),
}));
beforeEach(() => {
  vi.stubGlobal("React", React);
  mock.assign.mockReset();
  mock.available = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("retains a failed task and ignores duplicate submission while pending", async () => {
  let resolve!: (v: undefined) => void;
  mock.assign.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<TerminalModal />);
  act(() => gameEvents.emit("open-terminal"));
  fireEvent.change(screen.getByLabelText("Task description"), {
    target: { value: "Investigate stock" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Assign" }));
  fireEvent.keyDown(screen.getByLabelText("Task description"), { key: "Enter" });
  expect(mock.assign).toHaveBeenCalledTimes(1);
  await act(async () => resolve(undefined));
  expect((screen.getByLabelText("Task description") as HTMLTextAreaElement).value).toBe(
    "Investigate stock",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
});
it("allows drafting but prevents unsupported execution with expandable diagnostics", () => {
  mock.available = false;
  render(<TerminalModal />);
  act(() => gameEvents.emit("open-terminal"));
  fireEvent.change(screen.getByLabelText("Task description"), { target: { value: "Draft task" } });
  fireEvent.click(screen.getByRole("button", { name: "Assign" }));
  expect(mock.assign).not.toHaveBeenCalled();
  expect(screen.getByText("Runtime setup required")).toBeTruthy();
  expect(screen.getByText("Diagnostic details")).toBeTruthy();
});
