import type { ChatMessage, SeatState, TaskItem } from "@/types/game";

export function inferConversationAgent(
  seats: SeatState[],
  tasks: TaskItem[],
  messages: ChatMessage[],
  sessionKey: string,
  preferred?: string,
) {
  const assigned = seats.filter(
    (seat) =>
      seat.assigned &&
      (seat.binding
        ? seat.binding.agentId === sessionKey.split(":")[1]
        : seat.seatType !== "agent" ||
          !seat.agentConfig?.agentId ||
          `agent:${seat.agentConfig.agentId}:main` === sessionKey),
  );
  const explicit = assigned.find((seat) => seat.seatId === preferred);
  if (explicit) return explicit;
  for (const message of [...messages].reverse()) {
    if (message.sessionKey !== sessionKey) continue;
    const task = tasks.find(
      (task) => task.taskId === (message.taskId ?? message.runId) || task.runId === message.runId,
    );
    const seat = assigned.find(
      (seat) =>
        seat.seatId === (message.seatId ?? task?.seatId) ||
        seat.label === (message.actorName ?? task?.actorName),
    );
    if (seat) return seat;
  }
  const task = [...tasks]
    .filter((task) => task.sessionKey === sessionKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    assigned.find((seat) => seat.seatId === task?.seatId || seat.label === task?.actorName) ??
    assigned.find(
      (seat) =>
        seat.seatType === "agent" && `agent:${seat.agentConfig?.agentId}:main` === sessionKey,
    ) ??
    assigned[0]
  );
}

export function voiceExecutionContext(messages: ChatMessage[], seatId: string, sessionKey: string) {
  return messages
    .filter(
      (message) =>
        message.source === "voice" &&
        message.seatId === seatId &&
        message.sessionKey === sessionKey &&
        message.role !== "tool" &&
        !message.streaming,
    )
    .slice(-8)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : (message.actorName ?? "Agent")}${message.interrupted ? " (interrupted, unfinished)" : ""}: ${message.content.slice(0, 1000)}`,
    )
    .join("\n")
    .slice(-6000);
}

export function isTerminalTask(task: TaskItem) {
  return ["completed", "failed", "interrupted", "stopped"].includes(task.status);
}
