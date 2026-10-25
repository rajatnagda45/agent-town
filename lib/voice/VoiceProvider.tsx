"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStudio } from "@/lib/store";
import { MAIN_SESSION_KEY } from "@/lib/reducer";
import { gameEvents } from "@/lib/events";
import type { SeatState } from "@/types/game";
import { GeminiVoiceClient, type VoiceStatus } from "./client";
import type { VoiceAgentContext } from "./agent-context";
import { runVoiceAgentTool, VOICE_ACTIONS } from "./agent-actions";
import { inferConversationAgent, isTerminalTask, voiceExecutionContext } from "./conversation";

type Mode = "text" | "voice";
type Turn = { id: string; timestamp: string; finished: boolean };
type ActiveCall = {
  id: string;
  seatId: string;
  sessionKey: string;
  name: string;
  client: GeminiVoiceClient;
  user?: Turn;
  assistant?: Turn;
  assigned: Map<string, Promise<Record<string, unknown>>>;
  bindingRevision?: number;
  taskStatuses: Map<string, string>;
  pendingAnnouncements: Set<string>;
  pendingReviews: Set<string>;
  abort: AbortController;
  refreshing: boolean;
  refreshAgain: boolean;
  contextReady: boolean;
  closing?: boolean;
  startedAt: number;
};
interface VoiceState {
  mode: Mode;
  setMode: (mode: Mode) => void;
  agent?: SeatState;
  selectAgent: (seatId: string) => Promise<void>;
  status: VoiceStatus;
  active: boolean;
  muted: boolean;
  elapsed: number;
  configured: boolean | null;
  error: string;
  notice: string;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  sendText: (message: string) => Promise<string | undefined>;
}
const VoiceContext = createContext<VoiceState | null>(null);
export function useVoice() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error("useVoice must be inside VoiceProvider");
  return value;
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const studio = useStudio();
  const latest = useRef(studio);
  useLayoutEffect(() => {
    latest.current = studio;
  });
  const sessionKey = studio.state.activeSessionKey ?? MAIN_SESSION_KEY;
  const finalizedMessage = studio.state.chatMessages
    .filter(
      (message) =>
        message.sessionKey === sessionKey &&
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming,
    )
    .at(-1);
  const [mode, setModeState] = useState<Mode>("text");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const agent = inferConversationAgent(
    studio.state.seats,
    studio.state.tasks,
    studio.state.chatMessages,
    sessionKey,
    selected[sessionKey],
  );
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const connected = status !== "idle" && status !== "connecting";
  const callRef = useRef<ActiveCall | null>(null);
  const sequence = useRef(0);
  const selectionRequest = useRef(0);

  const stop = useCallback(() => {
    // Final transcripts are saved under the old target before the call is released.
    const call = callRef.current;
    if (call) {
      call.closing = true;
      call.abort.abort();
      call.client.close();
    }
    callRef.current = null;
    setStatus("idle");
    setMuted(false);
  }, []);
  const setMode = useCallback(
    (next: Mode) => {
      if (next === "text") stop();
      setModeState(next);
    },
    [stop],
  );

  const selectAgent = useCallback(
    async (seatId: string) => {
      const existing = callRef.current;
      if (
        existing?.seatId === seatId &&
        existing.sessionKey === (latest.current.getActiveSessionKey() ?? MAIN_SESSION_KEY)
      )
        return;
      if (existing) {
        setNotice("End the current call before choosing another conversation partner.");
        return;
      }
      const request = ++selectionRequest.current;
      stop();
      setError("");
      setNotice("");
      const current = latest.current;
      const seat = current.state.seats.find((seat) => seat.assigned && seat.seatId === seatId);
      if (!seat) return;
      // Independent agents use their canonical session. Workers can share the current one.
      const targetSession =
        current.getBoundSessionForSeat?.(seatId) ??
        (seat.seatType === "agent" && seat.agentConfig?.agentId
          ? `agent:${seat.agentConfig.agentId}:main`
          : (current.getActiveSessionKey() ?? MAIN_SESSION_KEY));
      if (targetSession !== (current.getActiveSessionKey() ?? MAIN_SESSION_KEY)) {
        await current.switchSession(targetSession);
      }
      if (
        request !== selectionRequest.current ||
        (latest.current.getActiveSessionKey() ?? MAIN_SESSION_KEY) !== targetSession
      )
        return;
      setSelected((previous) => ({ ...previous, [targetSession]: seatId }));
    },
    [stop],
  );

  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/voice/session", { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { configured: boolean }) => setConfigured(data.configured))
      .catch(() => {
        if (!abort.signal.aborted)
          setError("Could not check voice configuration. Refresh and try again.");
      });
    return () => abort.abort();
  }, []);
  useEffect(
    () =>
      gameEvents.on("open-voice", (seatId) => {
        setModeState("voice");
        void selectAgent(seatId);
      }),
    [selectAgent],
  );
  useEffect(() => {
    const onPageHide = () => stop();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      stop();
    };
  }, [stop]);

  // Layout effect runs before another interaction can use a stale target after a switch.
  useLayoutEffect(() => {
    const call = callRef.current;
    if (
      call &&
      (call.sessionKey !== sessionKey ||
        call.seatId !== agent?.seatId ||
        call.name !== agent.label ||
        !agent.assigned ||
        call.bindingRevision !== agent.binding?.revision)
    ) {
      stop();
      setNotice("Call ended because the agent or session changed.");
    }
  }, [sessionKey, agent?.seatId, agent?.label, agent?.assigned, agent?.binding?.revision, stop]);

  const selectionFor = useCallback((seatId: string, targetSession: string) => {
    const current = latest.current;
    if ((current.getActiveSessionKey() ?? MAIN_SESSION_KEY) !== targetSession) return null;
    const seat = current.state.seats.find((seat) => seat.seatId === seatId && seat.assigned);
    return seat
      ? { seatId, sessionKey: targetSession, bindingRevision: seat.binding?.revision }
      : null;
  }, []);

  const isCurrentCall = useCallback((call: ActiveCall) => {
    const seat = latest.current.state.seats.find((seat) => seat.seatId === call.seatId);
    return (
      callRef.current === call &&
      !call.closing &&
      (latest.current.getActiveSessionKey() ?? MAIN_SESSION_KEY) === call.sessionKey &&
      seat?.assigned === true &&
      seat.label === call.name &&
      seat.binding?.revision === call.bindingRevision
    );
  }, []);

  const refreshCall = useCallback(
    async (call: ActiveCall) => {
      if (!isCurrentCall(call)) return;
      if (call.refreshing) {
        call.refreshAgain = true;
        return;
      }
      call.refreshing = true;
      try {
        do {
          call.refreshAgain = false;
          const taskIds = [
            ...new Set([
              ...call.pendingAnnouncements,
              ...[...call.taskStatuses]
                .filter(
                  ([, status]) =>
                    !["completed", "failed", "interrupted", "stopped"].includes(status),
                )
                .map(([taskId]) => taskId),
              ...latest.current.state.tasks
                .filter(
                  (task) => task.seatId === call.seatId && task.sessionKey === call.sessionKey,
                )
                .filter(
                  (task) =>
                    isTerminalTask(task) && call.taskStatuses.get(task.taskId) !== task.status,
                )
                .slice(-20)
                .map((task) => task.taskId),
            ]),
          ].slice(-20);
          const response = await fetch("/api/runtime/voice/context", {
            method: "POST",
            signal: call.abort.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              seatId: call.seatId,
              sessionKey: call.sessionKey,
              bindingRevision: call.bindingRevision,
              taskIds,
            }),
          });
          if (!isCurrentCall(call)) return;
          if (!response.ok) {
            if ([400, 404, 409].includes(response.status)) {
              stop();
              setNotice("Call ended because the agent or session changed.");
            }
            return;
          }
          const { agent: context } = (await response.json()) as { agent: VoiceAgentContext };
          if (!isCurrentCall(call)) return;
          if (
            context.seatId !== call.seatId ||
            context.sessionKey !== call.sessionKey ||
            context.bindingRevision !== call.bindingRevision
          ) {
            stop();
            setNotice("Call ended because the agent or session changed.");
            return;
          }
          call.client.updateContext(context);
          for (const task of context.tasks) {
            const previous = call.taskStatuses.get(task.taskId);
            call.taskStatuses.set(task.taskId, task.status);
            const terminal = ["completed", "failed", "interrupted", "stopped"].includes(
              task.status,
            );
            if (!terminal) {
              call.client.cancelTaskAnnouncement(task.taskId);
              call.pendingAnnouncements.delete(task.taskId);
            } else if (
              previous !== task.status &&
              (previous !== undefined ||
                call.contextReady ||
                Date.parse(task.createdAt ?? "") >= call.startedAt)
            ) {
              call.client.queueTaskAnnouncement({
                taskId: task.taskId,
                status: task.status,
                message: task.message.slice(0, 500),
                result: task.result?.slice(0, 1800),
              });
              call.pendingAnnouncements.add(task.taskId);
            }
          }
          for (const taskId of call.pendingAnnouncements) {
            if (!context.tasks.some((task) => task.taskId === taskId)) {
              call.client.cancelTaskAnnouncement(taskId);
              call.pendingAnnouncements.delete(taskId);
            }
          }
          call.contextReady = true;
        } while (call.refreshAgain && isCurrentCall(call));
      } catch {
        // A transient refresh failure retains the last confirmed context; the next poll retries.
      } finally {
        call.refreshing = false;
      }
    },
    [isCurrentCall, stop],
  );

  const sendText = useCallback(
    async (message: string) => {
      const current = latest.current;
      const key = current.getActiveSessionKey() ?? MAIN_SESSION_KEY;
      const seat = inferConversationAgent(
        current.state.seats,
        current.state.tasks,
        current.state.chatMessages,
        key,
        selected[key],
      );
      if (!seat || !message.trim()) return;
      return current.assignTask(message.trim(), seat.seatId, {
        sessionKey: key,
        context: voiceExecutionContext(current.state.chatMessages, seat.seatId, key),
      });
    },
    [selected],
  );

  const start = useCallback(async () => {
    if (callRef.current || !agent) return;
    const context = selectionFor(agent.seatId, sessionKey);
    if (!context) return;
    setSelected((previous) => ({ ...previous, [sessionKey]: agent.seatId }));
    setError("");
    setNotice("");
    setMuted(false);
    setElapsed(0);
    setStatus("connecting");
    const id = `voice_${crypto.randomUUID()}`;
    const call: ActiveCall = {
      id,
      seatId: agent.seatId,
      sessionKey,
      name: agent.label,
      bindingRevision: agent.binding?.revision,
      client: null!,
      assigned: new Map(),
      taskStatuses: new Map(
        studio.state.tasks
          .filter((task) => task.seatId === agent.seatId && task.sessionKey === sessionKey)
          .map((task) => [task.taskId, task.status]),
      ),
      pendingAnnouncements: new Set(),
      pendingReviews: new Set(),
      abort: new AbortController(),
      refreshing: false,
      refreshAgain: false,
      contextReady: false,
      startedAt: Date.now(),
    };
    const upsertTurn = (
      role: "user" | "assistant",
      text: string,
      finished: boolean,
      metadata?: { interrupted?: boolean },
    ) => {
      if (callRef.current !== call || (!call.closing && !isCurrentCall(call))) return;
      let turn = call[role];
      if (!turn || turn.finished)
        turn = call[role] = {
          id: `${id}_${role}_${++sequence.current}`,
          timestamp: new Date().toISOString(),
          finished: false,
        };
      turn.finished = finished;
      latest.current.upsertVoiceMessage({
        id: turn.id,
        runId: call.id,
        source: "voice",
        seatId: call.seatId,
        sessionKey: call.sessionKey,
        actorName: call.name,
        role,
        content: text,
        streaming: !finished,
        timestamp: turn.timestamp,
        ...(metadata?.interrupted ? { interrupted: true } : {}),
      });
      if (finished && text.trim())
        void call.client
          .saveTranscript({
            id: turn.id,
            role,
            content: text,
            timestamp: turn.timestamp,
            ...metadata,
          })
          .then(() => refreshCall(call))
          .catch(() => {
            if (isCurrentCall(call))
              setError(
                "Voice transcript could not be saved to the server. Your transcript remains in this tab.",
              );
          });
    };
    call.client = new GeminiVoiceClient({
      telemetryError: () =>
        setNotice("Some call diagnostics or usage could not be saved. Records may be incomplete."),
      status: (next) => {
        if (isCurrentCall(call)) setStatus(next);
      },
      error: (message) => {
        if (isCurrentCall(call)) {
          call.abort.abort();
          callRef.current = null;
          setStatus("idle");
          setMuted(false);
          setError(message);
        }
      },
      transcript: upsertTurn,
      announcement: (taskId) => {
        if (isCurrentCall(call)) call.pendingAnnouncements.delete(taskId);
      },
      activity: () => {
        if (call.user?.finished) call.user = undefined;
      },
      tool: async (tool, args, signal, actionId = crypto.randomUUID()) => {
        if (!isCurrentCall(call) || signal?.aborted)
          return { error: "Call ended or interrupted. No task created." };
        if (!VOICE_ACTIONS.has(tool))
          return {
            error: "Unsupported voice action. Use the review dialog for approvals and answers.",
          };
        const selection = selectionFor(call.seatId, call.sessionKey);
        if (!selection || selection.bindingRevision !== call.bindingRevision)
          return { error: "Conversation changed. No action was taken." };
        if (tool === "assign_task") {
          const response = await fetch("/api/runtime/voice/context", {
            method: "POST",
            signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(selection),
          });
          if (!response.ok)
            return { error: "Agent context unavailable or binding changed. No action was taken." };
          const { agent: currentContext } = (await response.json()) as { agent: VoiceAgentContext };
          if (
            !isCurrentCall(call) ||
            signal?.aborted ||
            !selectionFor(call.seatId, call.sessionKey) ||
            latest.current.state.seats.find((seat) => seat.seatId === call.seatId)?.binding
              ?.revision !== call.bindingRevision
          )
            return { error: "Conversation changed. No action was taken." };
          if (
            currentContext.seatId !== call.seatId ||
            currentContext.sessionKey !== call.sessionKey ||
            currentContext.bindingRevision !== call.bindingRevision
          )
            return { error: "Agent context changed. No action was taken." };
        }
        return runVoiceAgentTool(tool, args, async (name, parameters) => {
          if (!isCurrentCall(call) || signal?.aborted)
            return { error: "Call ended or interrupted. No action was taken." };
          if (name !== "assign_task") {
            const result = await call.client.action(name, parameters, { actionId, signal });
            if (name === "open_pending_review" && typeof result.reviewId === "string") {
              if (!isCurrentCall(call) || signal?.aborted)
                return { error: "Call ended. Review was not opened." };
              gameEvents.emit("open-review", result.reviewId);
              return { opened: true, note: result.note };
            }
            return result;
          }
          const message = typeof parameters.message === "string" ? parameters.message.trim() : "";
          if (!message) return { error: "A task description is required." };
          const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
          const sourceId = call.user?.id ?? `${call.id}_user_${++sequence.current}`;
          const dedupeKey = `${sourceId}:${normalized}`;
          const previous = call.assigned.get(dedupeKey);
          if (previous) return previous;
          // Some tool calls arrive before the input transcription. Reserve its timeline row.
          if (!call.user) {
            call.user = { id: sourceId, timestamp: new Date().toISOString(), finished: false };
            upsertTurn("user", message, false);
          }
          const accepted = call.client
            .action(name, parameters, {
              actionId,
              sourceMessageId: call.user!.id,
              signal,
            })
            .then((result) => {
              if (result.error) call.assigned.delete(dedupeKey);
              if (result.accepted === true && typeof result.taskId === "string") {
                const row = latest.current.state.chatMessages.find((item) => item.id === sourceId);
                if (row) latest.current.upsertVoiceMessage({ ...row, taskId: result.taskId });
              }
              return result;
            })
            .catch((error) => {
              call.assigned.delete(dedupeKey);
              throw error;
            });
          call.assigned.set(dedupeKey, accepted);
          return accepted;
        });
      },
    });
    callRef.current = call;
    try {
      await call.client.start(context);
    } catch (cause) {
      if (callRef.current !== call) return;
      stop();
      const name = cause instanceof Error ? cause.name : "";
      setError(
        name === "NotAllowedError"
          ? "Allow microphone access in browser site settings."
          : name === "NotFoundError"
            ? "Connect a microphone and try again."
            : cause instanceof Error
              ? cause.message
              : "Could not start voice.",
      );
    }
  }, [agent, selectionFor, sessionKey, studio.state.tasks, stop, isCurrentCall, refreshCall]);

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      const call = callRef.current;
      if (call) setElapsed(Math.floor((Date.now() - call.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [connected]);

  useEffect(() => {
    const call = callRef.current;
    if (call && connected) void refreshCall(call);
  }, [connected, studio.state.tasks, finalizedMessage, studio.state.connection, refreshCall]);

  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      const call = callRef.current;
      if (call) void refreshCall(call);
    }, 5000);
    return () => clearInterval(timer);
  }, [connected, refreshCall]);

  useEffect(() => {
    const call = callRef.current;
    if (!call || !isCurrentCall(call)) return;
    const seat = studio.state.seats.find((seat) => seat.seatId === call.seatId);
    const pendingReviews = new Set<string>();
    for (const item of studio.state.reviews ?? []) {
      if (
        item.status !== "pending" ||
        item.sessionKey !== call.sessionKey ||
        item.agentId !== seat?.binding?.agentId
      )
        continue;
      pendingReviews.add(`review_${item.id}`);
      call.client.queueTaskAnnouncement({
        taskId: `review_${item.id}`,
        status: "review_required",
        message:
          "An approval or blocking question requires your explicit review in the Reviews dialog.",
      });
    }
    for (const id of call.pendingReviews) {
      if (!pendingReviews.has(id)) call.client.cancelTaskAnnouncement(id);
    }
    call.pendingReviews = pendingReviews;
  }, [connected, studio.state.reviews, studio.state.seats, isCurrentCall]);

  return (
    <VoiceContext.Provider
      value={{
        mode,
        setMode,
        agent,
        selectAgent,
        status,
        active: status !== "idle",
        muted,
        elapsed,
        configured,
        error,
        notice,
        start,
        stop,
        toggleMute: () => {
          if (callRef.current && status !== "connecting") {
            const next = !muted;
            callRef.current.client.setMuted(next);
            setMuted(next);
          }
        },
        sendText,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
}
