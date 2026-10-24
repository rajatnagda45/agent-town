import type { ChatMessage, SessionRecord, TaskItem } from "@/types/game";
export const OFFICE_GROUP = "office:group:main";
export function seatSessions(sessions: SessionRecord[], seatId: string, agentId?: string | null) {
  return sessions.filter((s) => s.seatId === seatId && s.key.split(":")[1] === agentId);
}
export function mergeConversationMessages(
  key: string,
  history: ChatMessage[],
  live: ChatMessage[],
) {
  const map = new Map<string, ChatMessage>();
  for (const m of [...history, ...live]) {
    if (m.sessionKey !== key) continue;
    const previous = map.get(m.id);
    // A delayed streaming fragment must not replace a persisted terminal response.
    if (
      previous &&
      "streaming" in previous &&
      previous.streaming === false &&
      "streaming" in m &&
      m.streaming
    )
      continue;
    map.set(m.id, m);
  }
  return [...map.values()].sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
  );
}
export const taskFilters = [
  "All Tasks",
  "Running",
  "Awaiting Input",
  "Completed",
  "Failed",
  "Cancelled",
] as const;
export function matchesTaskFilter(task: TaskItem, filter: string) {
  if (filter === "All Tasks") return true;
  const statuses: Record<string, string[]> = {
    Running: ["submitted", "queued", "returning", "running", "cancel_requested", "outcome_unknown"],
    "Awaiting Input": ["waiting_approval", "waiting_question"],
    Completed: ["completed"],
    Failed: ["failed", "interrupted"],
    Cancelled: ["stopped"],
  };
  return statuses[filter]?.includes(task.status) ?? false;
}
export const taskIsActive = (task: TaskItem) =>
  !["completed", "failed", "stopped", "interrupted"].includes(task.status);

/** Presentation only: retain the exact stored instructions and separate the known group envelope. */
export function taskPresentation(task: TaskItem) {
  const marker = "\nYour contribution: ";
  const split = task.message.lastIndexOf(marker);
  const grouped =
    task.taskId.startsWith("grp_") && task.message.startsWith("Office request: ") && split >= 16;
  const request = grouped ? task.message.slice("Office request: ".length, split) : task.message;
  const contribution = grouped ? task.message.slice(split + marker.length) : undefined;
  const compact = request.replace(/\s+/g, " ").trim();
  return {
    request,
    contribution,
    title: compact.length > 110 ? `${compact.slice(0, 109)}…` : compact || "Untitled request",
  };
}
