// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import BackendManagement from "@/components/hud/seat-manager/BackendManagement";
import type { SeatState } from "@/types/game";

const seat = (seatId: string, label: string, agentId: string, assigned = true) =>
  ({
    seatId,
    label,
    roleTitle: "Worker",
    status: "empty",
    assigned,
    seatType: "worker",
    binding: { seatId, agentId, sessionKey: `agent:${agentId}:main`, revision: 1 },
  }) as unknown as SeatState;
let seats: SeatState[] = [];
vi.mock("@/lib/store", () => ({
  runtimeRequest: vi.fn(),
  useStudio: () => ({
    reconcile: vi.fn(),
    state: { seats, sharedAgentId: "main", management: { agents: [] } },
  }),
}));
afterEach(cleanup);

it("names every seat sharing a backend agent and warns that a change affects all of them", () => {
  seats = [seat("a", "Alice", "main"), seat("b", "Bob", "main"), seat("c", "Orion", "town-r")];
  render(<BackendManagement seat={seats[0]} agentId="main" onRefresh={async () => {}} />);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Alice, Bob");
  expect(alert.textContent).not.toContain("Orion");
  expect(alert.textContent).toContain("affects all 2 seats");
  expect(alert.textContent).toContain("not independent agents");
});

it("shows no shared warning for an independent backend agent or unassigned seats", () => {
  seats = [
    seat("c", "Orion", "town-r"),
    seat("a", "Alice", "main"),
    seat("d", "Dave", "main", false),
  ];
  render(<BackendManagement seat={seats[0]} agentId="town-r" onRefresh={async () => {}} />);
  expect(screen.queryByRole("alert")).toBeNull();
});
