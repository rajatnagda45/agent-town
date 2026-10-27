// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { request, sendText, setMode } = vi.hoisted(() => ({
  request: vi.fn(),
  sendText: vi.fn(),
  setMode: vi.fn(),
}));
vi.mock("../store", () => ({
  runtimeRequest: request,
  useStudio: () => ({
    state: {
      seats: [
        { seatId: "alice", label: "Alice", assigned: true, binding: { available: true } },
        { seatId: "bob", label: "Bob", assigned: true, binding: { available: true } },
      ],
      tasks: [],
      chatMessages: [],
      capabilities: { "chat.send": { available: true } },
    },
  }),
}));
vi.mock("../voice/VoiceProvider", () => ({
  useVoice: () => ({
    mode: "text",
    setMode,
    agent: undefined,
    active: false,
    status: "idle",
    sendText,
  }),
}));
vi.mock("../events", () => ({ gameEvents: { emit: vi.fn() } }));

import ChatPanel from "@/components/hud/ChatPanel";

afterEach(() => {
  cleanup();
  request.mockReset();
  sendText.mockReset();
  setMode.mockReset();
});

it("sends Text to the office channel without selecting the Voice agent", async () => {
  request.mockImplementation(async (path: string) =>
    path === "office-group" ? { messages: [], message: { id: "group_user_turn" } } : {},
  );
  render(<ChatPanel messages={[]} tasks={[]} isConnected sessions={[]} />);
  expect(screen.getByText("Office group")).toBeTruthy();
  expect(screen.queryByLabelText("Conversation agent")).toBeNull();
  fireEvent.change(screen.getByPlaceholderText("Type a message..."), {
    target: { value: "Investigate the pressure" },
  });
  fireEvent.click(screen.getByTitle("Send"));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("office-group", {
      turnId: expect.any(String),
      message: "Investigate the pressure",
    }),
  );
  expect(sendText).not.toHaveBeenCalled();
});

it("reuses the turn id after an uncertain send failure and keeps the message for retry", async () => {
  let attempts = 0;
  request.mockImplementation(async (_path: string, body?: unknown) => {
    if (!body) return { messages: [] };
    if (++attempts === 1) throw new Error("Connection interrupted");
    return {};
  });
  render(<ChatPanel messages={[]} tasks={[]} isConnected sessions={[]} />);
  const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "Check the count" } });
  fireEvent.click(screen.getByLabelText("Send message"));
  await screen.findByText("Connection interrupted");
  expect(input.value).toBe("Check the count");
  fireEvent.click(screen.getByLabelText("Send message"));
  await waitFor(() => expect(input.value).toBe(""));
  const sends = request.mock.calls.filter((call) => call[1]);
  expect(sends).toHaveLength(2);
  expect(sends[0][1].turnId).toBe(sends[1][1].turnId);
});
