import type { ChatMessage, SeatState, TaskItem } from "@/types/game";

export interface VoiceSelection {
  seatId: string;
  sessionKey?: string;
  bindingRevision?: number;
  /** Task outcomes that must remain visible even outside the recent-task window. */
  taskIds?: string[];
}

export interface VoiceAgentContext {
  agentId?: string;
  bindingRevision?: number;
  execution?: {
    canSubmit: boolean;
    configurationPending: boolean;
    reviewRequired: boolean;
    activeTaskIds: string[];
  };
  seatId: string;
  /** Roster position chosen by the server; selects a distinct prebuilt voice. */
  voiceIndex?: number;
  name: string;
  role: string;
  status: string;
  gatewayConnected: boolean;
  sessionKey?: string;
  tasks: Array<{
    taskId: string;
    message: string;
    status: string;
    result?: string;
    createdAt?: string;
  }>;
  conversation: Array<{ role: "user" | "assistant"; text: string; interrupted?: boolean }>;
  instructions?: Array<{ name: string; text: string; truncated: boolean }>;
  memory?: Array<{
    id: string;
    content: string;
    score: number;
    source: { taskId: string; evidenceRefs: string[] };
    layer: string;
    confidence: number;
    retrievalReason: string;
  }>;
  retrieval?: Record<
    "history" | "instructions" | "memory" | "workspace",
    {
      status: "available" | "unavailable" | "error";
      source?: string;
      reason?: string;
      limited?: boolean;
    }
  >;
}

export function buildVoiceAgentContext(
  seat: SeatState,
  tasks: TaskItem[],
  messages: ChatMessage[],
  gatewayConnected: boolean,
  sessionKey?: string,
): VoiceAgentContext {
  const ownTasks = tasks
    .filter(
      (task) =>
        (task.seatId === seat.seatId || (!task.seatId && task.actorName === seat.label)) &&
        (!sessionKey || task.sessionKey === sessionKey),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);
  const runIds = new Set(
    ownTasks.flatMap((task) => [task.taskId, ...(task.runId ? [task.runId] : [])]),
  );
  return {
    seatId: seat.seatId,
    name: seat.label.slice(0, 80),
    role: (seat.roleTitle || "AI teammate").slice(0, 160),
    status: seat.status === "empty" ? "idle" : seat.status,
    gatewayConnected,
    sessionKey,
    tasks: ownTasks.map((task) => ({
      taskId: task.taskId,
      message: task.message.slice(0, 1200),
      status: task.status,
      result: (task.result ?? task.error)?.slice(0, 2500),
      createdAt: task.createdAt,
    })),
    conversation: messages
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          (!sessionKey || message.sessionKey === sessionKey) &&
          !message.streaming &&
          (runIds.has(message.runId) ||
            (message.source === "voice" && message.seatId === seat.seatId)),
      )
      .slice(-6)
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: message.content.slice(0, 1000),
        ...(message.interrupted && message.role === "assistant" ? { interrupted: true } : {}),
      })),
  };
}

/** Bound client-provided context; never pass an arbitrary client system prompt or tool schema. */
export function parseVoiceAgentContext(value: unknown): VoiceAgentContext | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent context");
  const record = value as Record<string, unknown>;
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.slice(0, max) : "";
  if (!text(record.seatId, 100) || !text(record.name, 80)) throw new Error("Select an agent first");
  return {
    seatId: text(record.seatId, 100),
    name: text(record.name, 80),
    role: text(record.role, 160) || "AI teammate",
    status: text(record.status, 40),
    gatewayConnected: record.gatewayConnected === true,
    sessionKey: text(record.sessionKey, 256) || undefined,
    tasks: (Array.isArray(record.tasks) ? record.tasks : [])
      .slice(0, 30)
      .filter((task) => task && typeof task === "object")
      .map((task) => ({
        taskId: text(task.taskId, 100),
        message: text(task.message, 1200),
        status: text(task.status, 40),
        result: text(task.result, 2500),
        createdAt: text(task.createdAt, 40) || undefined,
      })),
    conversation: (Array.isArray(record.conversation) ? record.conversation : [])
      .slice(-8)
      .filter((message) => message && (message.role === "user" || message.role === "assistant"))
      .map((message) => ({
        role: message.role as "user" | "assistant",
        text: text(message.text, 1000),
        ...(message.interrupted === true && message.role === "assistant"
          ? { interrupted: true }
          : {}),
      })),
  };
}
