// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Markdown from "@/components/ui/Markdown";
import CopyButton from "@/components/ui/CopyButton";
import MessageStream from "@/components/chat/MessageStream";
import type { ChatMessage } from "@/types/game";
afterEach(cleanup);
it("renders semantic Markdown without allowing executable links or raw HTML", () => {
  const { container } = render(
    <Markdown
      text={
        "# Findings\n\n- **One**\n- Two\n\n3. Third\n\n[Docs](https://example.com) [bad](javascript:alert)\n\n<script>alert(1)</script>\n\n```ts\nconst n = 1;\n```"
      }
    />,
  );
  expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
  expect(container.querySelectorAll("li")).toHaveLength(3);
  expect(screen.getByRole("link", { name: "Docs" }).getAttribute("rel")).toContain("noopener");
  expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("const n = 1;")).toBeTruthy();
});
it("announces copy success only after clipboard confirmation and allows failure retry", async () => {
  const writeText = vi.fn().mockRejectedValueOnce(Error("Denied")).mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<CopyButton text="Exact response" />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Copy failed — retry");
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Copied");
  expect(writeText).toHaveBeenLastCalledWith("Exact response");
});
it("groups only adjacent messages with matching identity and distinguishes days", () => {
  const base: ChatMessage = {
    id: "1",
    runId: "r",
    sessionKey: "s",
    role: "assistant",
    seatId: "a",
    actorName: "Alice",
    timestamp: "2026-10-26T12:00:00Z",
    content: "First",
  };
  render(
    <MessageStream
      messages={[
        base,
        { ...base, id: "2", content: "Second", timestamp: "2026-10-26T12:00:20Z" },
        { ...base, id: "3", seatId: "b", actorName: "Bob", content: "Third" },
        { ...base, id: "4", content: "Fourth", timestamp: "2026-10-27T12:00:00Z" },
      ]}
      seats={[]}
      tasks={[]}
      onInspect={vi.fn()}
    />,
  );
  expect(screen.getAllByText("Continued")).toHaveLength(1);
  expect(screen.getAllByText("Alice")).toHaveLength(2);
  expect(screen.getByText("Bob")).toBeTruthy();
});

it("does not label newly streamed content as already copied", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  const view = render(<CopyButton text="Partial" />);
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Copied");
  view.rerender(<CopyButton text="Complete response" />);
  expect(screen.queryByText("Copied")).toBeNull();
  expect(screen.getByText("Copy")).toBeTruthy();
});
