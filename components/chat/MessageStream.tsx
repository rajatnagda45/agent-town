import type { ChatMessage, SeatState, TaskItem } from "@/types/game";
import MessageBubble from "@/components/hud/MessageBubble";
import CharacterPortrait from "@/components/hud/CharacterPortrait";
export default function MessageStream({
  messages,
  seats,
  tasks,
  onInspect,
}: {
  messages: ChatMessage[];
  seats: SeatState[];
  tasks: TaskItem[];
  onInspect: (task: TaskItem) => void;
}) {
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const date = new Date(message.timestamp);
    const valid = Number.isFinite(date.getTime());
    const newDay =
      valid && (!previous || new Date(previous.timestamp).toDateString() !== date.toDateString());
    const grouped =
      !newDay &&
      previous?.role === message.role &&
      previous?.seatId === message.seatId &&
      previous?.actorName === message.actorName &&
      previous?.source === message.source &&
      Math.abs(date.getTime() - Date.parse(previous.timestamp)) < 120000;
    const owner = message.seatId ? seats.find((s) => s.seatId === message.seatId) : undefined;
    const task = message.taskId ? taskMap.get(message.taskId) : undefined;
    const bubble = (
      <MessageBubble
        msg={message}
        grouped={grouped}
        avatar={
          owner && message.role === "assistant" && !grouped ? (
            <span className="message-avatar">
              <CharacterPortrait name={owner.label} spritePath={owner.spritePath} />
            </span>
          ) : undefined
        }
      />
    );
    return (
      <article key={message.id} className={grouped ? "message-grouped" : undefined}>
        {newDay && (
          <div className="message-day">
            <time dateTime={message.timestamp}>
              {date.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </time>
          </div>
        )}
        {message.content.length > 2400 && message.role !== "tool" ? (
          <details open className="center-long-message">
            <summary>Long response · expand or collapse</summary>
            {bubble}
          </details>
        ) : (
          bubble
        )}
        {task && messages[index + 1]?.taskId !== message.taskId && (
          <button className="center-task-link" onClick={() => onInspect(task)}>
            {/* A seat task is one agent's reply, not a verified deliverable. */}
            Inspect task ·{" "}
            {task.status === "completed"
              ? "reply delivered · unverified"
              : task.status.replaceAll("_", " ")}
          </button>
        )}
      </article>
    );
  });
}
