"use client";

import React, {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ChatMessage,
  GatewayConfig,
  SeatState,
  StudioSnapshot,
  TaskDispatchOptions,
  TaskItem,
  SessionMetrics,
} from "@/types/game";
import type { SeatDef } from "@/components/game/utils/MapHelpers";
import { gameEvents } from "./events";
import { initialState, MAIN_SESSION_KEY, mergeDiscoveredSeats } from "./reducer";
import {
  loadActiveSessionKey,
  loadChat,
  loadTasks,
  loadSeatConfigs,
  loadDeviceId,
  saveActiveSessionKey,
  saveChat,
  saveTasks,
  saveGatewayConfig,
  lsGet,
  lsSet,
} from "./persistence";
import { getDefaultGatewayUrl } from "./utils";
import { boundConversationSession } from "./identity";

type RuntimeSnapshot = Pick<
  StudioSnapshot,
  | "connection"
  | "tasks"
  | "sessions"
  | "capabilities"
  | "reviews"
  | "reviewRecovery"
  | "management"
  | "voice"
  | "sharedAgentId"
  | "officeLead"
> & { seats: SeatState[]; cursor: number };
export async function runtimeRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/runtime/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Task server unavailable");
  return data as T;
}
interface StudioContextValue {
  state: StudioSnapshot;
  connect: (config?: GatewayConfig) => void;
  disconnect: () => void;
  assignTask: (
    message: string,
    seatId?: string,
    options?: TaskDispatchOptions,
  ) => Promise<string | undefined>;
  upsertVoiceMessage: (message: ChatMessage) => void;
  getActiveSessionKey: () => string | undefined;
  updateSeatConfig: (seatId: string, patch: Partial<SeatState>) => Promise<void>;
  newSession: () => void;
  switchSession: (key: string) => Promise<void>;
  prepareSessionForSeat: (seatId: string) => Promise<void>;
  newSessionForSeat: (seatId: string) => void;
  getBoundSessionForSeat: (seatId: string) => string | undefined;
  loadSessionChat: (key: string) => Promise<ChatMessage[]>;
  reconcile: () => Promise<void>;
}
const StudioContext = createContext<StudioContextValue | null>(null);
export function useStudio() {
  const context = React.useContext(StudioContext);
  if (!context) throw new Error("useStudio must be used within StudioProvider");
  return context;
}
const terminal = (status: string) =>
  ["completed", "failed", "stopped", "interrupted"].includes(status);

export function StudioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initialState);
  const latest = useRef(state);
  const viewState: StudioSnapshot = {
    ...state,
    seats: state.seats.map((seat) => {
      const task = [...state.tasks]
        .reverse()
        .find((task) => task.seatId === seat.seatId && !terminal(task.status));
      return {
        ...seat,
        status: task ? "running" : "empty",
        runId: task?.runId ?? undefined,
        taskSnippet: task?.message.slice(0, 28),
        startedAt: task?.createdAt,
      };
    }),
  };
  useLayoutEffect(() => {
    latest.current = viewState;
  });
  const definitions = useRef<SeatDef[]>([]);
  const serverSeats = useRef<SeatState[]>([]);
  const activeKey = useRef<string | undefined>(undefined);
  const presented = useRef(new Map<string, string>());
  const selectedSessionBySeat = useRef(new Map<string, string>());
  const submissionIds = useRef(new Map<string, string>());
  const hydrated = useRef(false);
  const appliedCursor = useRef(0);
  const reportError = useCallback(
    (error: unknown) =>
      setState((old) => ({
        ...old,
        runtimeError: error instanceof Error ? error.message : "Task server unavailable",
      })),
    [],
  );
  const mergeSeats = useCallback((seats: SeatState[], old: SeatState[]) => {
    // The communication workspace does not mount the scene; server seats remain authoritative.
    const merged = definitions.current.length
      ? mergeDiscoveredSeats(definitions.current, seats, old)
      : seats;
    return merged.map((seat) => ({
      ...seat,
      binding: seats.find((config) => config.seatId === seat.seatId)?.binding,
    }));
  }, []);
  const snapshot = useCallback(
    (data: RuntimeSnapshot, authoritative = false) => {
      if (!authoritative && data.cursor < appliedCursor.current) return;
      appliedCursor.current = data.cursor;
      hydrated.current = true;
      serverSeats.current = data.seats;
      setState((old) => ({
        ...old,
        connection: data.connection,
        capabilities: data.capabilities,
        reviews: data.reviews ?? [],
        reviewRecovery: data.reviewRecovery ?? {},
        management: data.management,
        voice: data.voice,
        sharedAgentId: data.sharedAgentId,
        officeLead: data.officeLead,
        tasks: data.tasks,
        sessions: data.sessions,
        seats: mergeSeats(data.seats, old.seats),
        runtimeError: undefined,
      }));
    },
    [mergeSeats],
  );
  const loadSessionChat = useCallback(async (key: string) => {
    const result = await runtimeRequest<{
      messages: ChatMessage[];
      limited: boolean;
      reason: string;
      metrics?: SessionMetrics;
    }>(`history?sessionKey=${encodeURIComponent(key)}`);
    const messages = [...result.messages];
    if (activeKey.current === key && result.metrics)
      setState((old) => ({ ...old, sessionMetrics: result.metrics! }));
    if (result.limited)
      messages.unshift({
        id: `history_limit_${key}`,
        runId: "",
        role: "system",
        content: result.reason,
        sessionKey: key,
        timestamp: new Date().toISOString(),
      });
    return messages;
  }, []);
  const switchSession = useCallback(
    async (key: string) => {
      activeKey.current = key;
      saveActiveSessionKey(key);
      setState((old) => ({ ...old, activeSessionKey: key }));
      try {
        const messages = await loadSessionChat(key);
        setState((old) => ({
          ...old,
          chatMessages: [
            ...old.chatMessages.filter(
              (message) =>
                message.sessionKey !== key ||
                (message.source === "voice" &&
                  !messages.some((incoming) => incoming.id === message.id)),
            ),
            ...messages,
          ],
        }));
      } catch (error) {
        reportError(error);
      }
    },
    [loadSessionChat, reportError],
  );

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let events: EventSource | undefined;
    const key = loadActiveSessionKey() ?? MAIN_SESSION_KEY;
    activeKey.current = key;
    // Restore browser cache asynchronously so mounting does not synchronously
    // cascade through every store consumer. Ignore a restore after unmount.
    const cachedMessages = loadChat(key);
    queueMicrotask(() => {
      if (!closed)
        setState((old) => ({ ...old, activeSessionKey: key, chatMessages: cachedMessages }));
    });
    const cachedTasks = loadTasks(key);
    const cachedSeats = loadSeatConfigs();
    const pending = lsGet<Array<[string, string]>>("agent-town:pending-submissions", []);
    if (Array.isArray(pending))
      submissionIds.current = new Map(
        pending
          .filter(
            (entry) =>
              Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
          )
          .slice(0, 20),
      );
    // Migration is idempotent and never executes imported records.
    const initialize = () =>
      runtimeRequest("import", { id: loadDeviceId(), tasks: cachedTasks, seats: cachedSeats })
        .then(() => runtimeRequest<RuntimeSnapshot>("state"))
        .then((data) => {
          if (closed) return;
          snapshot(data);
          void switchSession(key);
          events = new EventSource("/api/runtime/events");
          events.onmessage = (message) => {
            if (closed) return;
            const event = JSON.parse(message.data);
            if (event.kind === "metrics" && event.data.sessionKey === activeKey.current)
              setState((old) => ({ ...old, sessionMetrics: event.data.metrics }));
            if (event.kind === "snapshot") {
              snapshot(event.data, true);
              void switchSession(activeKey.current ?? key);
              return;
            }
            if (event.seq && event.seq < appliedCursor.current) return;
            if (event.seq) appliedCursor.current = event.seq;
            if (event.kind === "connection") {
              setState((old) => ({ ...old, ...event.data }));
              if (event.data.connection === "connected")
                void runtimeRequest<RuntimeSnapshot>("state")
                  .then((data) => {
                    if (!closed) snapshot(data);
                  })
                  .catch(reportError);
            }
            if (event.kind === "seat") {
              serverSeats.current = [
                ...serverSeats.current.filter((seat) => seat.seatId !== event.data.seatId),
                event.data,
              ];
              setState((old) => ({ ...old, seats: mergeSeats(serverSeats.current, old.seats) }));
            }
            if (event.kind === "review")
              setState((old) => ({
                ...old,
                reviews: [
                  event.data,
                  ...(old.reviews ?? []).filter((item) => item.id !== event.data.id),
                ],
              }));
            if (event.kind === "reviewRecovery")
              setState((old) => ({ ...old, reviewRecovery: event.data }));
            if (event.kind === "management")
              setState((old) => ({ ...old, management: event.data }));
            if (event.kind === "voiceCall")
              setState((old) => ({
                ...old,
                voice: {
                  billingNotice: old.voice?.billingNotice ?? "",
                  calls: [
                    event.data,
                    ...(old.voice?.calls ?? []).filter((call) => call.id !== event.data.id),
                  ]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .slice(0, 100),
                },
              }));
            if (event.kind === "managementOperation")
              setState((old) => ({
                ...old,
                management: {
                  agents: old.management?.agents ?? [],
                  operations: [
                    ...(old.management?.operations ?? []).filter((op) => op.id !== event.data.id),
                    event.data,
                  ],
                },
              }));
            if (event.kind === "task")
              setState((old) => ({
                ...old,
                tasks: [
                  event.data,
                  ...old.tasks.filter((task) => task.taskId !== event.data.taskId),
                ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
              }));
            if (event.kind === "session")
              setState((old) => ({
                ...old,
                sessions: [
                  event.data,
                  ...old.sessions.filter((session) => session.key !== event.data.key),
                ],
              }));
            if (event.kind === "message")
              setState((old) => ({
                ...old,
                chatMessages: [
                  ...old.chatMessages.filter((item) => item.id !== event.data.id),
                  event.data,
                ],
              }));
          };
          events.onerror = () => {
            if (!closed)
              setState((old) => ({
                ...old,
                runtimeError:
                  "Task updates disconnected. Reconnecting; server execution continues.",
              }));
          };
          events.onopen = () => {
            if (!closed) setState((old) => ({ ...old, runtimeError: undefined }));
          };
        })
        .catch((error) => {
          if (!closed) {
            reportError(error);
            retry = setTimeout(initialize, 2000);
          }
        });
    void initialize();
    return () => {
      closed = true;
      clearTimeout(retry);
      events?.close();
    };
  }, [mergeSeats, reportError, snapshot, switchSession]);

  useEffect(
    () =>
      gameEvents.on("seats-discovered", (seats) => {
        definitions.current = seats;
        setState((old) => ({ ...old, seats: mergeSeats(serverSeats.current, old.seats) }));
      }),
    [mergeSeats],
  );

  useEffect(() => {
    if (!state.capabilities?.["agents.list"]?.available || !state.seats.length) return;
    const missing = state.seats.filter((seat) => !seat.binding);
    if (missing.length)
      void runtimeRequest<{ seats: SeatState[] }>("bootstrap", { seats: missing })
        .then((data) => {
          serverSeats.current = data.seats;
          setState((old) => ({ ...old, seats: mergeSeats(data.seats, old.seats) }));
        })
        .catch(reportError);
  }, [state.capabilities, state.seats, mergeSeats, reportError]);

  useEffect(() => {
    if (!state.seats.length) return;
    const seats = state.seats.map((seat) => {
      const task = [...state.tasks]
        .reverse()
        .find((task) => task.seatId === seat.seatId && !terminal(task.status));
      return {
        ...seat,
        status: task ? ("running" as const) : ("empty" as const),
        runId: task?.runId ?? undefined,
        taskSnippet: task?.message.slice(0, 28),
        startedAt: task?.createdAt,
      };
    });
    gameEvents.emit("seat-configs-updated", seats);
    for (const task of state.tasks) {
      const previous = presented.current.get(task.taskId);
      if (!previous && !terminal(task.status))
        gameEvents.emit("task-assigned", task.taskId, task.message, task.seatId, task.sessionKey);
      if (previous && !terminal(previous) && terminal(task.status))
        gameEvents.emit(
          task.status === "completed"
            ? "task-completed"
            : task.status === "failed"
              ? "task-failed"
              : "task-aborted",
          task.taskId,
        );
      presented.current.set(task.taskId, task.status);
    }
  }, [state.seats, state.tasks]);
  useEffect(() => {
    if (!hydrated.current) return;
    const timer = setTimeout(() => {
      saveTasks(state.tasks);
      saveChat(state.chatMessages);
    }, 400);
    return () => clearTimeout(timer);
  }, [state.tasks, state.chatMessages]);

  const assignTask = useCallback(
    async (message: string, seatId?: string, options?: TaskDispatchOptions) => {
      const candidates = latest.current.seats.filter(
        (seat) =>
          seat.assigned &&
          seat.binding?.available &&
          seat.binding.agentId === (options?.sessionKey ?? activeKey.current)?.split(":")[1],
      );
      const seat = seatId
        ? latest.current.seats.find((seat) => seat.seatId === seatId && seat.assigned)
        : (candidates.find((seat) => seat.status === "empty") ?? candidates[0]);
      if (!seat?.binding?.available) {
        reportError(new Error("Select an available backend agent binding first."));
        return;
      }
      setState((old) => ({ ...old, workRedirect: undefined }));
      const sessionKey =
        options?.sessionKey ??
        boundConversationSession(
          seat,
          activeKey.current,
          selectedSessionBySeat.current.get(seat.seatId),
        );
      const dedupe = `${seat.seatId}:${sessionKey}:${options?.sourceMessageId ?? "text"}:${message}`;
      const taskId = submissionIds.current.get(dedupe) ?? crypto.randomUUID();
      submissionIds.current.set(dedupe, taskId);
      lsSet("agent-town:pending-submissions", [...submissionIds.current.entries()].slice(-20));
      try {
        const { task, redirected } = await runtimeRequest<{
          task?: TaskItem;
          redirected?: { composerTaskId: string; reason: string };
        }>("tasks", {
          taskId,
          message,
          seatId: seat.seatId,
          bindingRevision: seat.binding.revision,
          sessionKey,
          sourceMessageId: options?.sourceMessageId,
          context: options?.context,
        });
        submissionIds.current.delete(dedupe);
        lsSet("agent-town:pending-submissions", [...submissionIds.current.entries()].slice(-20));
        if (redirected || !task) {
          // No seat task exists: the request runs in the verified work pipeline.
          setState((old) => ({ ...old, runtimeError: undefined, workRedirect: redirected }));
          if (redirected) options?.onRedirect?.(redirected);
          return undefined;
        }
        setState((old) => ({
          ...old,
          runtimeError: undefined,
          tasks: old.tasks.some((item) => item.taskId === task.taskId)
            ? old.tasks
            : [task, ...old.tasks],
          chatMessages: old.chatMessages.map((item) =>
            item.id === options?.sourceMessageId ? { ...item, taskId: task.taskId } : item,
          ),
        }));
        return task.taskId;
      } catch (error) {
        reportError(error);
        return;
      }
    },
    [reportError],
  );
  useEffect(
    () =>
      gameEvents.on("stop-task", (id) => {
        const task = latest.current.tasks.find((task) => task.taskId === id || task.runId === id);
        if (task)
          void runtimeRequest(`tasks/${encodeURIComponent(task.taskId)}/cancel`, {}).catch(
            reportError,
          );
      }),
    [reportError],
  );
  const updateSeatConfig = useCallback(
    async (seatId: string, patch: Partial<SeatState>) => {
      const seat = latest.current.seats.find((seat) => seat.seatId === seatId);
      const result = await runtimeRequest<{ seat: SeatState }>("seats", {
        ...seat,
        ...patch,
        seatId,
        revision: seat?.binding?.revision ?? 0,
      });
      serverSeats.current = [
        ...serverSeats.current.filter((seat) => seat.seatId !== seatId),
        result.seat,
      ];
      setState((old) => ({ ...old, seats: mergeSeats(serverSeats.current, old.seats) }));
    },
    [mergeSeats],
  );
  const newSessionForSeat = useCallback(
    (seatId: string) => {
      void runtimeRequest<{ session: { key: string; createdAt: string } }>("sessions", { seatId })
        .then(({ session }) => {
          selectedSessionBySeat.current.set(seatId, session.key);
          setState((old) => ({
            ...old,
            sessions: [session, ...old.sessions.filter((item) => item.key !== session.key)],
          }));
          return switchSession(session.key);
        })
        .catch(reportError);
    },
    [switchSession, reportError],
  );
  useEffect(
    () =>
      gameEvents.on("new-session-for-seat", (seatId) => {
        newSessionForSeat(seatId);
        gameEvents.emit("open-terminal", seatId);
      }),
    [newSessionForSeat],
  );
  const reconcile = useCallback(async () => {
    try {
      snapshot(await runtimeRequest<RuntimeSnapshot>("reconcile", {}));
    } catch (error) {
      reportError(error);
    }
  }, [snapshot, reportError]);
  const value: StudioContextValue = {
    state: viewState,
    assignTask,
    updateSeatConfig,
    loadSessionChat,
    switchSession,
    newSessionForSeat,
    reconcile,
    connect: () => {
      void runtimeRequest("connect", {})
        .then(() => saveGatewayConfig({ url: getDefaultGatewayUrl() }))
        .catch(reportError);
    },
    disconnect: () => {
      void runtimeRequest("disconnect", {}).catch(reportError);
    },
    getActiveSessionKey: () => activeKey.current,
    getBoundSessionForSeat: (seatId) =>
      boundConversationSession(
        latest.current.seats.find((seat) => seat.seatId === seatId),
        latest.current.sessions.some(
          (session) =>
            session.key === activeKey.current && session.seatId && session.seatId !== seatId,
        )
          ? undefined
          : activeKey.current,
        selectedSessionBySeat.current.get(seatId),
      ),
    prepareSessionForSeat: async (seatId) => {
      const seat = latest.current.seats.find((seat) => seat.seatId === seatId);
      const key = boundConversationSession(
        seat,
        latest.current.sessions.some(
          (session) =>
            session.key === activeKey.current && session.seatId && session.seatId !== seatId,
        )
          ? undefined
          : activeKey.current,
        selectedSessionBySeat.current.get(seatId),
      );
      if (key) await switchSession(key);
    },
    newSession: () => {
      const seat = latest.current.seats.find(
        (seat) => seat.binding?.agentId === activeKey.current?.split(":")[1] && seat.assigned,
      );
      if (seat) newSessionForSeat(seat.seatId);
    },
    upsertVoiceMessage: (message) =>
      setState((old) => ({
        ...old,
        chatMessages: [
          ...old.chatMessages.filter((item) => item.id !== message.id),
          {
            ...message,
            taskId:
              old.chatMessages.find((item) => item.id === message.id)?.taskId ?? message.taskId,
          },
        ],
      })),
  };
  return React.createElement(StudioContext.Provider, { value }, children);
}
