"use client";
import { useEffect, useState } from "react";
import { runtimeRequest, useStudio } from "@/lib/store";
import type { ChatMessage, TaskItem } from "@/types/game";
import MessageBubble from "@/components/hud/MessageBubble";
import CopyButton from "@/components/ui/CopyButton";
import TaskStatus from "@/components/ui/TaskStatus";
import { taskIsActive, taskPresentation } from "@/lib/conversations";
type Detail = { events: { seq: number; kind: string; data: TaskItem }[]; messages: ChatMessage[] };
export default function TaskInspector({
  task,
  onConversation,
  onRetry,
}: {
  task: TaskItem;
  onConversation: () => void;
  onRetry: () => void;
}) {
  const { state } = useStudio();
  const presentation = taskPresentation(task);
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let valid = true;
    runtimeRequest<Detail>(`tasks/${encodeURIComponent(task.taskId)}`)
      .then((d) => {
        if (valid) {
          setDetail(d);
          setError("");
          setLoading(false);
        }
      })
      .catch((e) => {
        if (valid) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      valid = false;
    };
  }, [task.taskId, task.status, task.completedAt, task.result, refresh]);
  const cancel = async () => {
    setBusy(true);
    setError("");
    try {
      await runtimeRequest(`tasks/${encodeURIComponent(task.taskId)}/cancel`, {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancellation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="center-task-detail">
      <div className="center-eyebrow">Execution inspector</div>
      <h2>{task.actorName ?? "Agent"}</h2>
      <TaskStatus status={task.status} />
      <div className="center-id">
        <code>{task.taskId}</code>
        <CopyButton text={task.taskId} label="Copy task ID" />
      </div>
      <button className="pixel-button" onClick={onConversation}>
        Open related conversation
      </button>
      <details open>
        <summary>Original request</summary>
        <p className="center-preserve">{presentation.request}</p>
      </details>
      {presentation.contribution && (
        <details>
          <summary>Agent contribution instructions</summary>
          <p className="center-preserve">{presentation.contribution}</p>
        </details>
      )}
      <details>
        <summary>Full stored instructions</summary>
        <p className="center-preserve">{task.message}</p>
        <CopyButton text={task.message} label="Copy instructions" />
      </details>
      <dl>
        <dt>Submitted</dt>
        <dd>{new Date(task.createdAt).toLocaleString()}</dd>
        <dt>Backend</dt>
        <dd>{task.agentId ?? "Not recorded"}</dd>
        {task.completedAt && (
          <>
            <dt>Finished</dt>
            <dd>{new Date(task.completedAt).toLocaleString()}</dd>
          </>
        )}
      </dl>
      {taskIsActive(task) && (
        <button
          className="pixel-button"
          disabled={
            busy ||
            !state.capabilities?.["chat.abort"]?.available ||
            task.status === "cancel_requested"
          }
          onClick={() => void cancel()}
        >
          {busy
            ? "Requesting…"
            : task.status === "cancel_requested"
              ? "Cancellation pending"
              : "Cancel task"}
        </button>
      )}
      {["failed", "interrupted", "stopped"].includes(task.status) && (
        <button className="pixel-button" onClick={onRetry}>
          Use instructions in a new attempt
        </button>
      )}
      {(error || task.error || task.cancellationError) && (
        <p role="alert" className="ui-error">
          {error || task.error || task.cancellationError}
        </p>
      )}
      {error && (
        <button
          className="pixel-button"
          onClick={() => {
            setLoading(true);
            setRefresh((n) => n + 1);
          }}
        >
          Retry details
        </button>
      )}
      <details open>
        <summary>Execution history {detail ? `· ${detail.events.length}` : ""}</summary>
        {loading && <p role="status">Loading recorded events…</p>}
        <ol className="center-timeline">
          {detail?.events.map((e) => (
            <li key={e.seq}>
              <TaskStatus status={e.data.status} />
              <small>
                Event #{e.seq}
                {e.data.completedAt ? ` · ${new Date(e.data.completedAt).toLocaleString()}` : ""}
              </small>
            </li>
          ))}
        </ol>
        {!loading && !error && !detail?.events.length && <p>No lifecycle events recorded.</p>}
      </details>
      <details open={!!task.result}>
        <summary>Result {task.result ? "· available" : "· not reported"}</summary>
        {task.result ? (
          <MessageBubble
            msg={{
              id: task.taskId,
              runId: task.runId ?? "",
              timestamp: task.completedAt ?? "",
              sessionKey: task.sessionKey,
              role: "assistant",
              actorName: task.actorName,
              content: task.result,
            }}
          />
        ) : (
          <p>No final result reported.</p>
        )}
      </details>
      <details>
        <summary>Related messages · {detail?.messages.length ?? "—"}</summary>
        {detail?.messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
      </details>
      <details>
        <summary>Artifacts & record limits</summary>
        <p className="center-muted">
          Only recorded runtime events are shown. Structured artifact metadata is not exposed by
          this runtime; no files or milestones are inferred from response text.
        </p>
      </details>
    </section>
  );
}
