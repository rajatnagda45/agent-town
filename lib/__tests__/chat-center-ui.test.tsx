// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// Partial provider fixtures deliberately expose only the members used by this surface.
const fixture = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  studio: {} as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  voice: {} as any,
  request: vi.fn(),
  params: new URLSearchParams("seat=alice"),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => fixture.params,
}));
vi.mock("../store", () => ({ useStudio: () => fixture.studio, runtimeRequest: fixture.request }));
vi.mock("../voice/VoiceProvider", () => ({ useVoice: () => fixture.voice }));
vi.mock("@/components/hud/PendingReviews", () => ({ default: () => null }));
vi.mock("@/components/hud/SeatManagerModal", () => ({ default: () => null }));
vi.mock("@/components/hud/VoiceDiagnostics", () => ({ default: () => null }));
import ChatCenter from "@/components/chat/ChatCenter";
beforeEach(() => {
  fixture.params = new URLSearchParams("seat=alice");
  fixture.request.mockReset().mockResolvedValue({ messages: [] });
  fixture.studio = {
    state: {
      connection: "connected",
      seats: ["alice", "bob"].map((seatId) => ({
        seatId,
        label: seatId === "alice" ? "Alice" : "Bob",
        assigned: true,
        binding: { agentId: "main", available: true },
      })),
      sessions: ["alice", "bob"].map((seatId) => ({
        seatId,
        key: `agent:main:${seatId}`,
        createdAt: "2026-01-01",
      })),
      tasks: [],
      chatMessages: [],
      capabilities: { "chat.send": { available: true } },
    },
    loadSessionChat: vi.fn().mockResolvedValue([]),
    assignTask: vi.fn(),
    getActiveSessionKey: () => "agent:main:alice",
  };
  fixture.voice = {
    active: false,
    configured: true,
    agent: { seatId: "alice", label: "Alice" },
    start: vi.fn(),
  };
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(cleanup);
it("preserves failed individual text, blocks duplicate clicks, and retries the exact target", async () => {
  let finish!: (id?: string) => void;
  fixture.studio.assignTask
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue("task2");
  render(<ChatCenter />);
  const input = screen.getByLabelText("Message Alice") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Research operating systems" } });
  const send = screen.getByRole("button", { name: "Send message" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(fixture.studio.assignTask).toHaveBeenCalledTimes(1);
  finish();
  await screen.findByText(/Task was not confirmed/);
  expect(input.value).toBe("Research operating systems");
  fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
  await waitFor(() => expect(input.value).toBe(""));
  expect(fixture.studio.assignTask).toHaveBeenLastCalledWith(
    "Research operating systems",
    "alice",
    expect.objectContaining({ sessionKey: "agent:main:alice" }),
  );
});
it("locks conversation changes throughout an active voice call", async () => {
  fixture.voice.active = true;
  fixture.voice.elapsed = 5;
  fixture.voice.status = "listening";
  render(<ChatCenter />);
  const bob = screen.getByRole("button", { name: /Bob.*Available/ }) as HTMLButtonElement;
  expect(bob.disabled).toBe(true);
  fireEvent.click(bob);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Alice");
  expect(screen.getByLabelText("Message Alice")).toBeTruthy();
});
it("retains the group turn ID after uncertain failure even when switching conversations", async () => {
  fixture.params = new URLSearchParams();
  let attempts = 0;
  fixture.request.mockImplementation(async (_path: string, body?: unknown) => {
    if (!body) return { messages: [] };
    if (++attempts === 1) throw Error("Lost acknowledgement");
    return {};
  });
  render(<ChatCenter />);
  fireEvent.change(screen.getByLabelText("Message Office Group"), {
    target: { value: "Investigate" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Lost acknowledgement");
  fireEvent.click(screen.getByRole("button", { name: /Bob.*Available/ }));
  fireEvent.click(screen.getByRole("button", { name: /Office Group.*Shared team/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Message Office Group") as HTMLTextAreaElement).value).toBe(""),
  );
  const sends = fixture.request.mock.calls.filter((call) => call[1]);
  expect(sends).toHaveLength(2);
  expect(sends[0][1].turnId).toBe(sends[1][1].turnId);
});
it("disables dispatch when the runtime capability audit rejects it", async () => {
  fixture.studio.state.capabilities["chat.send"] = {
    available: false,
    reason: "Protocol unavailable",
  };
  render(<ChatCenter />);
  fireEvent.change(screen.getByLabelText("Message Alice"), { target: { value: "hello" } });
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText("Protocol unavailable")).toBeTruthy();
});

it("restores the intended conversation on browser history navigation", async () => {
  render(<ChatCenter />);
  window.history.pushState({}, "", "/app/chat?seat=bob&session=agent%3Amain%3Abob");
  fireEvent(window, new PopStateEvent("popstate"));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bob");
  fireEvent.change(screen.getByLabelText("Message Bob"), { target: { value: "Bob's request" } });
  fixture.studio.assignTask.mockResolvedValue("bob-task");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(fixture.studio.assignTask).toHaveBeenCalledWith(
      "Bob's request",
      "bob",
      expect.objectContaining({ sessionKey: "agent:main:bob" }),
    ),
  );
});

it("shows offline availability and preserves a draft across reconnection", async () => {
  fixture.studio.state.connection = "disconnected";
  const view = render(<ChatCenter />);
  expect(screen.getByRole("button", { name: /Bob.*Offline/ })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Message Alice"), {
    target: { value: "Keep this draft" },
  });
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fixture.studio.state.connection = "connected";
  view.rerender(<ChatCenter />);
  expect((screen.getByLabelText("Message Alice") as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
  expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("updates the URL when creating a conversation from an older deep link", async () => {
  fixture.params = new URLSearchParams("seat=alice&session=agent:main:alice");
  fixture.request.mockResolvedValue({
    session: { key: "agent:main:new", seatId: "alice", createdAt: "2026-10-27" },
  });
  fixture.studio.reconcile = vi.fn().mockResolvedValue(undefined);
  fixture.studio.switchSession = vi.fn().mockResolvedValue(undefined);
  render(<ChatCenter />);
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get("session")).toBe("agent:main:new"),
  );
  expect(fixture.studio.switchSession).toHaveBeenCalledWith("agent:main:new");
});

it("distinguishes unavailable history from an empty conversation and preserves the draft on retry", async () => {
  fixture.studio.loadSessionChat
    .mockRejectedValueOnce(Error("History service unavailable"))
    .mockResolvedValue([]);
  render(<ChatCenter />);
  fireEvent.change(screen.getByLabelText("Message Alice"), {
    target: { value: "My unsent draft" },
  });
  await screen.findByText("History is temporarily unavailable");
  expect(screen.queryByText("Start a conversation with Alice")).toBeNull();
  expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
  await screen.findByText("Start a conversation with Alice");
  expect((screen.getByLabelText("Message Alice") as HTMLTextAreaElement).value).toBe(
    "My unsent draft",
  );
});

it("inspects a task in the same conversation without clearing search or resetting follow", async () => {
  fixture.studio.state.tasks = [
    {
      taskId: "t1",
      seatId: "alice",
      sessionKey: "agent:main:alice",
      message: "Research",
      status: "completed",
      createdAt: "2026-01-01",
    },
  ];
  fixture.request.mockResolvedValue({ events: [], messages: [] });
  render(<ChatCenter />);
  await screen.findByText("Start a conversation with Alice");
  fireEvent.change(screen.getByLabelText("Search message history"), {
    target: { value: "retained search" },
  });
  const scroll = screen.getByLabelText("Conversation messages");
  Object.defineProperties(scroll, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 400 },
    scrollTop: { value: 100, writable: true },
  });
  fireEvent.scroll(scroll);
  vi.mocked(HTMLElement.prototype.scrollTo).mockClear();
  fireEvent.click(screen.getByRole("button", { name: /Research.*completed/ }));
  expect((screen.getByLabelText("Search message history") as HTMLInputElement).value).toBe(
    "retained search",
  );
  expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
});

it("prepares voice only after switching to the selected conversation", async () => {
  fixture.voice.agent = { seatId: "bob", label: "Bob" };
  fixture.voice.selectAgent = vi.fn();
  fixture.voice.setMode = vi.fn();
  let finish!: () => void;
  fixture.studio.switchSession = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<ChatCenter />);
  fireEvent.click(screen.getByRole("button", { name: "Prepare call with Alice" }));
  expect(fixture.studio.switchSession).toHaveBeenCalledWith("agent:main:alice");
  expect(fixture.voice.selectAgent).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: /Bob.*Available/ }) as HTMLButtonElement).disabled,
  ).toBe(true);
  finish();
  await waitFor(() => expect(fixture.voice.selectAgent).toHaveBeenCalledWith("alice"));
  expect(fixture.voice.setMode).toHaveBeenCalledWith("voice");
});

it("keeps late history from a previous conversation out of the current view", async () => {
  let finishAlice!: (rows: unknown[]) => void;
  fixture.studio.loadSessionChat.mockImplementation((key: string) =>
    key.endsWith(":alice")
      ? new Promise((resolve) => {
          finishAlice = resolve;
        })
      : Promise.resolve([]),
  );
  render(<ChatCenter />);
  fireEvent.click(screen.getByRole("button", { name: /Bob.*Available/ }));
  finishAlice([
    {
      id: "late",
      sessionKey: "agent:main:alice",
      role: "assistant",
      content: "Alice private history",
      timestamp: new Date().toISOString(),
    },
  ]);
  await waitFor(() =>
    expect(fixture.studio.loadSessionChat).toHaveBeenCalledWith("agent:main:bob"),
  );
  expect(screen.queryByText("Alice private history")).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bob");
});

it("restores pins and updates them from storage events without a mount state effect", async () => {
  localStorage.setItem(
    "agent-town:pinned-conversations",
    JSON.stringify(["alice:agent:main:alice"]),
  );
  render(<ChatCenter />);
  await screen.findByRole("button", { name: "Unpin" });
  localStorage.setItem("agent-town:pinned-conversations", "[]");
  fireEvent(window, new StorageEvent("storage", { key: "agent-town:pinned-conversations" }));
  await screen.findByRole("button", { name: "Pin" });
  localStorage.removeItem("agent-town:pinned-conversations");
});
