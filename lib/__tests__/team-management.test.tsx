// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SeatManagerModal from "@/components/hud/SeatManagerModal";
import type { SeatState } from "@/types/game";
const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@/lib/store", () => ({
  runtimeRequest: vi.fn(),
  useStudio: () => ({
    updateSeatConfig: update,
    state: { tasks: [], capabilities: { "agents.list": { available: true } } },
  }),
}));
vi.mock("@/components/hud/seat-manager/BackendManagement", () => ({ default: () => null }));
const seats: SeatState[] = [
  {
    seatId: "a",
    label: "Alice",
    roleTitle: "Engineer",
    status: "empty",
    assigned: true,
    seatType: "worker",
  },
  {
    seatId: "b",
    label: "Bob",
    roleTitle: "Designer",
    status: "empty",
    assigned: true,
    seatType: "worker",
  },
];
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ agents: [] }) })),
  );
  update.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps drafts isolated when switching people and saves only the selected profile", async () => {
  render(<SeatManagerModal open seats={seats} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Alice draft" } });
  fireEvent.click(screen.getByRole("button", { name: /Seat 2/ }));
  expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Bob");
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Bob draft" } });
  fireEvent.click(screen.getByRole("button", { name: /Seat 1/ }));
  expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Alice draft");
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith(
    "a",
    expect.objectContaining({ label: "Alice draft", roleTitle: "Engineer" }),
  );
  await waitFor(() => expect(screen.getByText("Alice draft saved.")).toBeTruthy());
});
it("confirms discarding drafts and preserves them when cancelled", () => {
  const close = vi.fn();
  render(<SeatManagerModal open seats={seats} onClose={close} />);
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Draft" } });
  fireEvent.click(screen.getByLabelText("Close seat manager"));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Draft");
  fireEvent.click(screen.getByLabelText("Close seat manager"));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(close).toHaveBeenCalledTimes(1);
});
it("requires confirmation for unassignment and blocks changes to running seats", () => {
  const view = render(<SeatManagerModal open seats={seats} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Unassign" }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Unassign seat" }));
  expect(update).toHaveBeenCalledWith("a", expect.objectContaining({ assigned: false }));
  view.rerender(
    <SeatManagerModal
      open
      seats={[{ ...seats[0], status: "running" }, seats[1]]}
      onClose={vi.fn()}
    />,
  );
  expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Unassign" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
it("restores focus after closing and traps keyboard focus at the dialog edges", async () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const view = render(<SeatManagerModal open seats={seats} onClose={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true),
  );
  const first = screen.getByLabelText("Close seat manager");
  first.focus();
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).not.toBe(first);
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("keeps an edited profile when the authoritative server rejects its revision", async () => {
  update.mockRejectedValueOnce(new Error("Binding revision changed. Refresh and retry."));
  render(<SeatManagerModal open seats={seats} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Unsaved colleague" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await screen.findByText("Binding revision changed. Refresh and retry.");
  expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Unsaved colleague");
  expect(screen.queryByText("Unsaved colleague saved.")).toBeNull();
});
