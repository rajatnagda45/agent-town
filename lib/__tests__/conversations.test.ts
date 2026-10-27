import { expect, it } from "vitest";
import {
  mergeConversationMessages,
  seatSessions,
  matchesTaskFilter,
  taskPresentation,
} from "@/lib/conversations";
import type { ChatMessage, TaskItem } from "@/types/game";
it("keeps worker sessions separate despite a shared backend and rejects rebound history", () => {
  const sessions = [
    { key: "agent:main:alice", seatId: "a", createdAt: "1" },
    { key: "agent:main:bob", seatId: "b", createdAt: "1" },
    { key: "agent:main:main", createdAt: "1" },
  ];
  expect(seatSessions(sessions, "a", "main").map((s) => s.key)).toEqual(["agent:main:alice"]);
  expect(seatSessions(sessions, "a", "other")).toEqual([]);
});
it("deduplicates live updates and filters late history from other conversations", () => {
  const a = {
    id: "1",
    sessionKey: "a",
    role: "assistant",
    content: "draft",
    timestamp: "2026-01-01",
    runId: "r",
  } as ChatMessage;
  expect(
    mergeConversationMessages(
      "a",
      [a, { ...a, id: "2", sessionKey: "b" }],
      [{ ...a, content: "final" }],
    ),
  ).toEqual([{ ...a, content: "final" }]);
});
it("uses actual lifecycle states for task filters", () => {
  expect(matchesTaskFilter({ status: "waiting_question" } as TaskItem, "Awaiting Input")).toBe(
    true,
  );
  expect(matchesTaskFilter({ status: "cancel_requested" } as TaskItem, "Cancelled")).toBe(false);
  expect(matchesTaskFilter({ status: "stopped" } as TaskItem, "Cancelled")).toBe(true);
});

it("keeps terminal history when a delayed streaming fragment arrives", () => {
  const final = {
    id: "response",
    role: "assistant",
    sessionKey: "a",
    runId: "run",
    timestamp: "2026-01-01",
    content: "Final answer",
    streaming: false,
  } as ChatMessage;
  expect(
    mergeConversationMessages(
      "a",
      [final],
      [{ ...final, content: "Partial", streaming: true } as ChatMessage],
    ),
  ).toEqual([final]);
});

it("presents group request and contribution separately without mutating source", () => {
  const task = {
    taskId: "grp_1",
    message: "Office request: Review the plan\nYour contribution: Find risks",
  } as TaskItem;
  expect(taskPresentation(task)).toEqual({
    request: "Review the plan",
    contribution: "Find risks",
    title: "Review the plan",
  });
  expect(task.message).toBe("Office request: Review the plan\nYour contribution: Find risks");
  expect(taskPresentation({ ...task, taskId: "individual" }).request).toBe(task.message);
});
