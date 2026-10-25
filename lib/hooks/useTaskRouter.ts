import type { SeatState, TaskItem } from "@/types/game";

export function resolveExecutionSessionKey(
  seats: SeatState[],
  seatId: string | undefined,
  fallbackSessionKey: string,
  seatBindings?: Map<string, string>,
): string {
  const seat = seatId ? seats.find((candidate) => candidate.seatId === seatId) : undefined;
  if (seat?.seatType === "agent" && seat.agentConfig?.agentId) {
    return `agent:${seat.agentConfig.agentId}:main`;
  }
  return (seatId ? seatBindings?.get(seatId) : undefined) ?? fallbackSessionKey;
}

export function classifyTaskSendError(error: Error): "outcome_unknown" | "failed" {
  return /timeout|connection closed|not connected|websocket|network/i.test(error.message)
    ? "outcome_unknown"
    : "failed";
}

export function resolveTaskSessionKey(
  task: TaskItem | undefined,
  seats: SeatState[],
  seatId: string | undefined,
  fallback: string,
  bindings?: Map<string, string>,
) {
  return task?.sessionPinned
    ? task.sessionKey
    : resolveExecutionSessionKey(seats, seatId, task?.sessionKey ?? fallback, bindings);
}
