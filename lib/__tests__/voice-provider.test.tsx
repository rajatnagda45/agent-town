// @vitest-environment jsdom
/* eslint-disable react-hooks/globals, react-hooks/immutability -- this test harness publishes a fake store snapshot for the mocked useStudio boundary */
import React, { useReducer } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action } from "../reducer";
import { VoiceProvider, useVoice } from "../voice/VoiceProvider";
import type { VoiceEvents } from "../voice/client";
import type { ChatMessage, StudioSnapshot, TaskDispatchOptions, TaskItem } from "@/types/game";
import { gameEvents } from "../events";

const { store, calls, assign } = vi.hoisted(() => ({
  store: { current: null as unknown },
  calls: [] as Array<{
    events: VoiceEvents;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    queueTaskAnnouncement: ReturnType<typeof vi.fn>;
    cancelTaskAnnouncement: ReturnType<typeof vi.fn>;
    updateContext: ReturnType<typeof vi.fn>;
    saveTranscript: ReturnType<typeof vi.fn>;
    action: ReturnType<typeof vi.fn>;
  }>,
  assign: vi.fn(),
}));
vi.mock("../store", () => ({ useStudio: () => store.current }));
vi.mock("../voice/client", () => ({
  GeminiVoiceClient: class {
    start = vi.fn(async () => {
      this.events.status("listening");
    });
    close = vi.fn(() => this.events.status("idle"));
    queueTaskAnnouncement = vi.fn();
    cancelTaskAnnouncement = vi.fn();
    updateContext = vi.fn();
    saveTranscript = vi.fn().mockResolvedValue(undefined);
    action = vi.fn(async (tool: string) => {
      if (tool === "assign_task") return { accepted: true, taskId: "task-new", status: "queued" };
      if (tool === "open_pending_review") {
        const pending = state.reviews?.find(
          (item) => item.status === "pending" && item.sessionKey === activeKey,
        );
        return pending
          ? { reviewId: pending.id, note: "Explicit user action required." }
          : { error: "No pending review" };
      }
      return { task: { taskId: "t1", status: "cancel_requested" } };
    });
    setMuted = vi.fn();
    constructor(public events: VoiceEvents) {
      calls.push(this);
    }
  },
}));

let dispatch: React.Dispatch<Action>;
let state: StudioSnapshot;
let activeKey: string;
const seats = [
  {
    seatId: "bob",
    label: "Bob",
    roleTitle: "Engineer",
    seatType: "worker" as const,
    status: "empty" as const,
    assigned: true,
  },
  {
    seatId: "alice",
    label: "Alice",
    roleTitle: "Writer",
    seatType: "worker" as const,
    status: "empty" as const,
    assigned: true,
  },
];
const task: TaskItem = {
  taskId: "t1",
  seatId: "alice",
  actorName: "Alice",
  runId: "run-1",
  sessionKey: "s1",
  status: "running",
  message: "Draft email",
  createdAt: "2026-10-25T00:00:00Z",
};
const message: ChatMessage = {
  id: "m1",
  runId: "run-1",
  sessionKey: "s1",
  actorName: "Alice",
  role: "assistant",
  content: "What should I include?",
  timestamp: task.createdAt,
};
function Controls() {
  const voice = useVoice();
  return (
    <>
      <span data-testid="agent">{voice.agent?.label}</span>
      <span data-testid="status">{voice.status}</span>
      <span data-testid="error">{voice.error}</span>
      <button onClick={() => voice.setMode("voice")}>Voice</button>
      <button onClick={() => voice.setMode("text")}>Text</button>
      <button onClick={() => void voice.start()}>Start</button>
      <button onClick={voice.stop}>End</button>
      <button onClick={() => void voice.selectAgent("bob")}>Bob</button>
      <button onClick={() => gameEvents.emit("open-voice", "alice")}>Toolbar Alice</button>
      <button onClick={() => voice.sendText("Continue the draft")}>Send text</button>
    </>
  );
}
function Harness({ override = {} }: { override?: Partial<StudioSnapshot> }) {
  const [snapshot, update] = useReducer(reducer, {
    ...initialState,
    connection: "connected",
    activeSessionKey: "s1",
    seats,
    tasks: [task],
    chatMessages: [message],
    ...override,
  });
  state = snapshot;
  dispatch = update;
  store.current = {
    state: snapshot,
    getActiveSessionKey: () => activeKey,
    switchSession: async (key: string) => {
      activeKey = key;
      update({ type: "SWITCH_SESSION", sessionKey: key });
    },
    upsertVoiceMessage: (message: ChatMessage) => update({ type: "UPSERT_VOICE_CHAT", message }),
    assignTask: (message: string, seatId?: string, options?: TaskDispatchOptions) => {
      const id = assign(message, seatId, options);
      if (id && options?.sourceMessageId)
        update({
          type: "LINK_CHAT_TASK",
          messageId: options.sourceMessageId,
          taskId: id,
          sessionKey: options.sessionKey!,
        });
      return id;
    },
  };
  return (
    <VoiceProvider>
      <Controls />
    </VoiceProvider>
  );
}
beforeEach(() => {
  activeKey = "s1";
  calls.length = 0;
  assign.mockReset().mockReturnValue("task-new");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url, options) => ({
      ok: true,
      json: async () => {
        if (url === "/api/runtime/voice/context") {
          const selection = JSON.parse(options.body);
          const seat = state.seats.find((seat) => seat.seatId === selection.seatId)!;
          return {
            agent: {
              ...selection,
              name: seat.label,
              role: seat.roleTitle,
              gatewayConnected: true,
              tasks: state.tasks.filter(
                (task) => task.seatId === seat.seatId && task.sessionKey === selection.sessionKey,
              ),
              conversation: [],
            },
          };
        }
        return { configured: true };
      },
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function begin() {
  render(<Harness />);
  fireEvent.click(screen.getByText("Voice"));
  fireEvent.click(screen.getByText("Start"));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("listening"));
}

describe("shared voice controller", () => {
  it("routes progress and cancellation through server actions and keeps requests bound to the call", async () => {
    await begin();
    const call = calls[0];
    const controller = new AbortController();
    expect(
      await call.events.tool!(
        "get_task_progress",
        { taskId: "t1" },
        controller.signal,
        "progress-tool",
      ),
    ).toMatchObject({ task: { taskId: "t1" } });
    expect(
      await call.events.tool!("cancel_task", { taskId: "t1" }, controller.signal, "cancel-tool"),
    ).toMatchObject({ task: { status: "cancel_requested" } });
    expect(call.action).toHaveBeenCalledWith(
      "cancel_task",
      { taskId: "t1" },
      { actionId: "cancel-tool", signal: controller.signal },
    );
    expect(assign).not.toHaveBeenCalled();
    activeKey = "s2";
    expect(await call.events.tool!("cancel_task", { taskId: "t1" })).toHaveProperty("error");
    expect(call.action).toHaveBeenCalledTimes(2);
  });

  it("does not open a review dialog when its response arrives after the call ends", async () => {
    await begin();
    let complete!: (value: Record<string, unknown>) => void;
    calls[0].action.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const opened = vi.fn();
    const unsubscribe = gameEvents.on("open-review", opened);
    const action = calls[0].events.tool!("open_pending_review", {});
    fireEvent.click(screen.getByText("End"));
    complete({ reviewId: "late-review" });
    expect(await action).toHaveProperty("error");
    expect(opened).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("uses server context for tools and rejects a target change during its fetch", async () => {
    await begin();
    let complete!: (value: unknown) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve as (value: unknown) => void;
        }),
    );
    const action = calls[0].events.tool!("assign_task", { message: "Draft a note" });
    fireEvent.click(screen.getByText("End"));
    complete({
      ok: true,
      json: async () => ({
        agent: { seatId: "alice", name: "Verified Alice", gatewayConnected: true },
      }),
    });
    expect(await action).toHaveProperty("error");
    expect(assign).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/voice/context",
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("persists finalized turns only and reports persistence failure", async () => {
    await begin();
    const call = calls[0];
    act(() => call.events.transcript("user", "Draft", false));
    expect(call.saveTranscript).not.toHaveBeenCalled();
    act(() => call.events.transcript("user", "Draft a note", true));
    expect(call.saveTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "Draft a note" }),
    );
    call.saveTranscript.mockRejectedValueOnce(new Error("offline"));
    await act(async () => call.events.transcript("assistant", "Hello", true));
    expect(screen.getByTestId("error").textContent).toContain("could not be saved");
  });
  it("announces and opens only the current conversation's review and cannot submit a decision", async () => {
    activeKey = "agent:main:main";
    const opened = vi.fn();
    const unsubscribe = gameEvents.on("open-review", opened);
    const binding = {
      seatId: "alice",
      agentId: "main",
      sessionKey: activeKey,
      revision: 1,
      available: true,
    };
    const review = {
      id: "review-current",
      backendId: "approval-id",
      kind: "approval" as const,
      revision: 1,
      status: "pending" as const,
      backendStatus: "pending",
      agentId: "main",
      sessionKey: activeKey,
      expiresAtMs: Date.now() + 60000,
      payload: {
        presentation: { kind: "exec", commandText: "private action", allowedDecisions: ["deny"] },
      },
    };
    render(
      <Harness
        override={{
          activeSessionKey: activeKey,
          seats: seats.map((seat) => ({ ...seat, binding: { ...binding, seatId: seat.seatId } })),
          tasks: [{ ...task, sessionKey: activeKey }],
          reviews: [{ ...review, id: "foreign", sessionKey: "agent:main:other" }, review],
        }}
      />,
    );
    fireEvent.click(screen.getByText("Voice"));
    fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("listening"));
    const call = calls[0];
    expect(call.queueTaskAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "review_review-current", status: "review_required" }),
    );
    expect(JSON.stringify(call.queueTaskAnnouncement.mock.calls)).not.toContain("private action");
    expect(await call.events.tool!("open_pending_review", {})).toMatchObject({ opened: true });
    expect(opened).toHaveBeenCalledWith("review-current");
    expect(await call.events.tool!("approval.resolve", { decision: "allow-once" })).toHaveProperty(
      "error",
    );
    expect(assign).not.toHaveBeenCalled();
    activeKey = "agent:main:other";
    expect(await call.events.tool!("open_pending_review", {})).toHaveProperty("error");
    expect(opened).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
  it("starts Alice's existing conversation and shares the call across toolbar entry points", async () => {
    await begin();
    expect(screen.getByTestId("agent").textContent).toBe("Alice");
    expect(calls[0].start).toHaveBeenCalledWith(
      expect.objectContaining({ seatId: "alice", sessionKey: "s1" }),
    );
    fireEvent.click(screen.getByText("Toolbar Alice"));
    expect(calls).toHaveLength(1);
    expect(calls[0].close).not.toHaveBeenCalled();
  });

  it("keeps streaming speech in one row and submits a repeated task only once", async () => {
    await begin();
    const call = calls[0];
    act(() => {
      call.events.transcript("user", "Draft", false);
      call.events.transcript("user", "Draft an email", true);
    });
    const voiceRows = state.chatMessages.filter((item) => item.source === "voice");
    expect(voiceRows).toHaveLength(1);
    await act(async () => {
      await Promise.all([
        call.events.tool!("assign_task", { message: "Draft an email" }),
        call.events.tool!("assign_task", { message: "Draft an email" }),
      ]);
    });
    expect(call.action).toHaveBeenCalledOnce();
    expect(assign).not.toHaveBeenCalled();
    expect(call.action).toHaveBeenCalledWith(
      "assign_task",
      { message: "Draft an email" },
      expect.objectContaining({ sourceMessageId: voiceRows[0].id }),
    );
    expect(state.chatMessages.find((item) => item.id === voiceRows[0].id)?.taskId).toBe("task-new");
  });

  it("closes on session change and rejects stale callbacks even before React updates", async () => {
    await begin();
    const call = calls[0];
    await act(async () => {
      activeKey = "s2";
      dispatch({ type: "SWITCH_SESSION", sessionKey: "s2" });
      expect(await call.events.tool!("assign_task", { message: "Wrong session" })).toHaveProperty(
        "error",
      );
    });
    expect(assign).not.toHaveBeenCalled();
    expect(call.close).toHaveBeenCalledOnce();
    act(() => call.events.transcript("assistant", "Late reply", true));
    expect(state.chatMessages.some((item) => item.content === "Late reply")).toBe(false);
  });

  it("keeps the current call when another agent is selected, then allows an explicit switch", async () => {
    await begin();
    fireEvent.click(screen.getByText("Bob"));
    expect(screen.getByTestId("agent").textContent).toBe("Alice");
    expect(screen.getByTestId("status").textContent).toBe("listening");
    expect(calls[0].close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("End"));
    fireEvent.click(screen.getByText("Bob"));
    await waitFor(() => expect(screen.getByTestId("agent").textContent).toBe("Bob"));
    expect(calls[0].close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Start"));
    await waitFor(() => expect(calls).toHaveLength(2));
    fireEvent.click(screen.getByText("Text"));
    expect(calls[1].close).toHaveBeenCalledOnce();
    expect(screen.getByTestId("status").textContent).toBe("idle");
  });

  it("queues one completion notice for the current agent and session only", async () => {
    await begin();
    act(() =>
      dispatch({
        type: "UPDATE_TASK",
        taskId: "t1",
        patch: { status: "completed", result: "Email ready" },
      }),
    );
    await waitFor(() => expect(calls[0].queueTaskAnnouncement).toHaveBeenCalledOnce());
    act(() =>
      dispatch({
        type: "ADD_TASK",
        task: {
          ...task,
          taskId: "bob-task",
          seatId: "bob",
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    expect(calls[0].queueTaskAnnouncement).toHaveBeenCalledOnce();
  });

  it("refreshes context during a call and refuses an unconfirmed local completion", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    await begin();
    await waitFor(() => expect(calls[0].updateContext).toHaveBeenCalled());
    vi.mocked(fetch).mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            agent: {
              seatId: "alice",
              sessionKey: "s1",
              name: "Alice",
              role: "Writer",
              status: "running",
              gatewayConnected: true,
              tasks: [task],
              conversation: [],
            },
          }),
        }) as Response,
    );
    calls[0].updateContext.mockClear();
    act(() =>
      dispatch({
        type: "UPDATE_TASK",
        taskId: "t1",
        patch: { status: "completed", result: "Unverified" },
      }),
    );
    await waitFor(() => expect(calls[0].updateContext).toHaveBeenCalled());
    expect(calls[0].queueTaskAnnouncement).not.toHaveBeenCalled();
    expect(calls[0].cancelTaskAnnouncement).toHaveBeenCalledWith("t1");
    calls[0].updateContext.mockClear();
    const poll = intervals.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;
    await act(async () => poll());
    expect(calls[0].updateContext).toHaveBeenCalledOnce();
  });

  it("drops a delayed refresh after switching sessions", async () => {
    await begin();
    await waitFor(() => expect(calls[0].updateContext).toHaveBeenCalled());
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    act(() => dispatch({ type: "UPDATE_TASK", taskId: "t1", patch: { status: "completed" } }));
    const before = calls[0].updateContext.mock.calls.length;
    act(() => {
      activeKey = "s2";
      dispatch({ type: "SWITCH_SESSION", sessionKey: "s2" });
    });
    await act(async () =>
      complete({
        ok: true,
        json: async () => ({
          agent: {
            seatId: "alice",
            sessionKey: "s1",
            name: "Alice",
            tasks: [{ ...task, status: "completed" }],
            conversation: [],
          },
        }),
      } as Response),
    );
    expect(calls[0].updateContext).toHaveBeenCalledTimes(before);
    expect(calls[0].queueTaskAnnouncement).not.toHaveBeenCalled();
  });

  it("requests old active tasks so polling can confirm their outcome without a local event", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    await begin();
    await waitFor(() => expect(calls[0].updateContext).toHaveBeenCalled());
    calls[0].updateContext.mockClear();
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      expect(JSON.parse(options!.body as string).taskIds).toContain("t1");
      return {
        ok: true,
        json: async () => ({
          agent: {
            seatId: "alice",
            sessionKey: "s1",
            name: "Alice",
            role: "Writer",
            gatewayConnected: true,
            tasks: [{ ...task, status: "completed", result: "Confirmed by polling" }],
            conversation: [],
          },
        }),
      } as Response;
    });
    const poll = intervals.mock.calls.find(([, delay]) => delay === 5000)![0] as () => void;
    await act(async () => poll());
    expect(calls[0].queueTaskAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "t1", result: "Confirmed by polling" }),
    );
    act(() => calls[0].events.announcement!("t1"));
    await act(async () => poll());
    const body = JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string);
    expect(body.taskIds).not.toContain("t1");
  });

  it("rejects transcription before React commits a session switch", async () => {
    await begin();
    act(() => {
      activeKey = "s2";
      calls[0].events.transcript("assistant", "Stale response", true);
    });
    expect(state.chatMessages.some((item) => item.content === "Stale response")).toBe(false);
    expect(calls[0].saveTranscript).not.toHaveBeenCalled();
  });

  it("preserves interrupted fragments and ignores save failures from an ended call", async () => {
    await begin();
    let reject!: (reason: Error) => void;
    calls[0].saveTranscript.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    act(() => calls[0].events.transcript("assistant", "I was saying", true, { interrupted: true }));
    expect(state.chatMessages.find((item) => item.content === "I was saying")).toMatchObject({
      interrupted: true,
      streaming: false,
    });
    expect(calls[0].saveTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ interrupted: true }),
    );
    fireEvent.click(screen.getByText("End"));
    await act(async () => reject(new Error("Old save failed")));
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("does not submit an interrupted tool after its context fetch completes", async () => {
    await begin();
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const abort = new AbortController();
    const result = calls[0].events.tool!(
      "assign_task",
      { message: "Canceled request" },
      abort.signal,
    );
    abort.abort();
    complete({
      ok: true,
      json: async () => ({
        agent: {
          seatId: "alice",
          sessionKey: "s1",
          name: "Alice",
          gatewayConnected: true,
        },
      }),
    } as Response);
    expect(await result).toHaveProperty("error");
    expect(assign).not.toHaveBeenCalled();
  });

  it("passes voice context into a later typed request without duplicating its visible text", async () => {
    await begin();
    act(() => calls[0].events.transcript("user", "My name is Sam", true));
    fireEvent.click(screen.getByText("Text"));
    fireEvent.click(screen.getByText("Send text"));
    expect(assign).toHaveBeenCalledWith(
      "Continue the draft",
      "alice",
      expect.objectContaining({ sessionKey: "s1", context: "User: My name is Sam" }),
    );
  });
});
