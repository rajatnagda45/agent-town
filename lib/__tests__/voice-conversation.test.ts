import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../reducer";
import { inferConversationAgent, voiceExecutionContext } from "../voice/conversation";
import { buildVoiceAgentContext } from "../voice/agent-context";
import { resolveTaskSessionKey } from "../hooks/useTaskRouter";
import type { ChatMessage, SeatState, TaskItem } from "@/types/game";

const alice: SeatState = {
  seatId: "alice",
  label: "Alice",
  seatType: "worker",
  assigned: true,
  status: "empty",
};
const bob: SeatState = { ...alice, seatId: "bob", label: "Bob" };
const message: ChatMessage = {
  id: "v1",
  runId: "voice-call",
  source: "voice",
  seatId: "alice",
  actorName: "Alice",
  role: "user",
  content: "Draft an intern email",
  streaming: true,
  timestamp: "2026-10-25T00:00:00Z",
  sessionKey: "s1",
};
const task: TaskItem = {
  taskId: "t1",
  runId: "gateway-run",
  seatId: "alice",
  actorName: "Alice",
  message: "Draft email",
  status: "running",
  createdAt: message.timestamp,
  sessionKey: "s1",
};

describe("shared voice conversation", () => {
  it("infers Alice from her conversation even when Bob is first in the roster", () => {
    expect(
      inferConversationAgent(
        [bob, alice],
        [task],
        [{ ...message, source: undefined, seatId: undefined, runId: "gateway-run" }],
        "s1",
      )?.seatId,
    ).toBe("alice");
    expect(inferConversationAgent([bob, alice], [task], [message], "s2")?.seatId).toBe("bob");
  });

  it("does not infer an independent agent into a different agent's session", () => {
    const independent: SeatState = {
      ...alice,
      seatType: "agent",
      agentConfig: { agentId: "specialist" },
    };
    expect(inferConversationAgent([independent], [], [], "s1")).toBeUndefined();
    expect(inferConversationAgent([independent], [], [], "agent:specialist:main")?.seatId).toBe(
      "alice",
    );
  });

  it("updates one streaming row and retains its task association after finalization", () => {
    let state = reducer(initialState, { type: "UPSERT_VOICE_CHAT", message });
    state = reducer(state, {
      type: "LINK_CHAT_TASK",
      messageId: message.id,
      taskId: task.taskId,
      sessionKey: "s1",
    });
    state = reducer(state, {
      type: "UPSERT_VOICE_CHAT",
      message: { ...message, content: "Draft an AI intern email", streaming: false },
    });
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toMatchObject({
      taskId: "t1",
      content: "Draft an AI intern email",
      streaming: false,
    });
    const unchanged = reducer(state, {
      type: "UPSERT_VOICE_CHAT",
      message: { ...message, sessionKey: "s2" },
    });
    expect(unchanged).toBe(state);
  });

  it("keeps voice turns through gateway history hydration without duplicating the task request", () => {
    const voice = { ...message, streaming: false, taskId: "t1" };
    const state = {
      ...initialState,
      tasks: [task],
      chatMessages: [voice, { ...message, id: "other", sessionKey: "s2" }],
    };
    const hydrated = reducer(state, {
      type: "HYDRATE_SESSION_CHAT",
      sessionKey: "s1",
      chatMessages: [
        { ...message, id: "echo", source: undefined, runId: "gateway-run", streaming: false },
        {
          ...message,
          id: "result",
          source: undefined,
          role: "assistant",
          content: "Draft ready",
          runId: "gateway-run",
          streaming: false,
        },
      ],
    });
    expect(hydrated.chatMessages.map((item) => item.id).sort()).toEqual(["other", "result", "v1"]);
  });

  it("keeps execution in its original session even after saved seat bindings change", () => {
    expect(
      resolveTaskSessionKey(
        { ...task, sessionPinned: true },
        [alice],
        "alice",
        "s2",
        new Map([["alice", "s3"]]),
      ),
    ).toBe("s1");
  });

  it("deduplicates identifier-free preview echoes while keeping a repeated later user request", () => {
    const voice = { ...message, streaming: false, taskId: "t1" };
    const linked = {
      ...task,
      executionMessage:
        "Recent conversation context (background data):\nSam\n\nCurrent user request:\nDraft email",
    };
    const state = { ...initialState, tasks: [linked], chatMessages: [voice] };
    const preview = {
      ...message,
      source: undefined,
      runId: "",
      content: linked.executionMessage.slice(0, 30),
      streaming: false,
    };
    const hydrated = reducer(state, {
      type: "HYDRATE_SESSION_CHAT",
      sessionKey: "s1",
      chatMessages: [
        { ...preview, id: "echo" },
        { ...preview, id: "later-repeat" },
      ],
    });
    expect(hydrated.chatMessages.map((item) => item.id).sort()).toEqual(["later-repeat", "v1"]);
    expect(hydrated.chatMessages.find((item) => item.id === "later-repeat")?.content).toBe(
      "Draft email",
    );
  });

  it("shares only finalized voice context from the selected agent and session with text execution", () => {
    const context = voiceExecutionContext(
      [
        { ...message, streaming: false },
        { ...message, id: "bob", seatId: "bob", content: "Bob secret", streaming: false },
        { ...message, id: "other", sessionKey: "s2", content: "Other session", streaming: false },
        { ...message, id: "partial", content: "Partial speech", streaming: true },
      ],
      "alice",
      "s1",
    );
    expect(context).toBe("User: Draft an intern email");
    const snapshot = buildVoiceAgentContext(
      alice,
      [task, { ...task, taskId: "old", sessionKey: "s2", message: "Old session task" }],
      [{ ...message, streaming: false }],
      true,
      "s1",
    );
    expect(snapshot.tasks.map((item) => item.taskId)).toEqual(["t1"]);
    expect(snapshot.conversation[0].text).toBe(message.content);
  });

  it("marks interrupted assistant fragments as unfinished in later typed requests", () => {
    expect(
      voiceExecutionContext(
        [
          {
            ...message,
            role: "assistant",
            content: "I started to explain",
            streaming: false,
            interrupted: true,
          },
        ],
        "alice",
        "s1",
      ),
    ).toBe("Alice (interrupted, unfinished): I started to explain");
  });
});
