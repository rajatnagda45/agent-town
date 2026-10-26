"use client";

import { useEffect, useState } from "react";
import type { TaskItem } from "@/types/game";
import { formatRelativeTime } from "@/lib/constants";
import TaskStatus from "@/components/ui/TaskStatus";
import HudFlyout from "./HudFlyout";
import { runtimeRequest, useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";

const ACTIVE_STATUSES = new Set([
  "running",
  "submitted",
  "queued",
  "returning",
  "cancel_requested",
  "outcome_unknown",
  "waiting_approval",
  "waiting_question",
]);
const DONE_STATUSES = new Set(["completed", "failed", "stopped", "interrupted"]);

function elapsedSeconds(isoStart: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(isoStart).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function TaskPanel({ tasks }: { tasks: TaskItem[] }) {
  const { state, reconcile } = useStudio();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  // Tick every second so elapsed times on running tasks stay live
  const [, setTick] = useState(0);
  const hasActive = tasks.some((t) => ACTIVE_STATUSES.has(t.status));
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasActive]);

  const runningCount = tasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length;

  return (
    <HudFlyout title="Tasks" subtitle={`${runningCount} active / ${tasks.length} total`}>
      <div className="hud-list">
        {tasks.length === 0 ? (
          <div className="hud-empty">No tasks yet.</div>
        ) : (
          tasks.map((task) => {
            const isActive = ACTIVE_STATUSES.has(task.status);
            const isDone = DONE_STATUSES.has(task.status);
            const timeStr = isActive
              ? elapsedSeconds(task.createdAt)
              : formatRelativeTime(task.completedAt ?? task.createdAt);
            const resultSnippet = isDone ? task.result : undefined;

            return (
              <div key={task.taskId} className="hud-list__item">
                <div className="hud-list__top">
                  <TaskStatus status={task.status} />
                  <span style={{ color: isActive ? "var(--pixel-yellow)" : undefined }}>
                    {isActive ? `⏱ ${timeStr}` : timeStr}
                  </span>
                </div>
                <div className="hud-list__title">{task.message}</div>
                {task.error && <div className="hud-list__meta">{task.error}</div>}
                {task.cancellationError && (
                  <div role="status" className="hud-list__meta">
                    {task.cancellationError}
                  </div>
                )}
                {(task.status === "outcome_unknown" || task.cancelRequestedAt) && isActive && (
                  <button
                    className="pixel-button"
                    disabled={checking}
                    onClick={async () => {
                      setChecking(true);
                      setCheckError("");
                      try {
                        await reconcile();
                      } catch (error) {
                        setCheckError(
                          error instanceof Error ? error.message : "Backend reconciliation failed.",
                        );
                      } finally {
                        setChecking(false);
                      }
                    }}
                  >
                    Check backend again
                  </button>
                )}
                {isActive && (!task.cancelRequestedAt || task.cancelState === "rejected") && (
                  <button
                    className="pixel-button"
                    disabled={
                      task.status !== "queued" && !state.capabilities?.["chat.abort"]?.available
                    }
                    title={
                      task.status === "queued"
                        ? "Cancel queued task"
                        : state.capabilities?.["chat.abort"]?.reason
                    }
                    onClick={() => {
                      if (task.cancelState === "rejected")
                        void runtimeRequest(`tasks/${encodeURIComponent(task.taskId)}/cancel`, {
                          retry: true,
                          expectedAttempt: task.cancelAttempt,
                        }).catch((error) => setCheckError(error.message));
                      else gameEvents.emit("stop-task", task.taskId, task.seatId ?? "");
                    }}
                  >
                    {task.cancelState === "rejected" ? "Retry cancellation" : "Stop"}
                  </button>
                )}
                {resultSnippet && (
                  <details
                    style={{
                      fontSize: 10,
                      color: "var(--pixel-muted)",
                      marginTop: 2,
                      fontFamily: "var(--pixel-font-chat)",
                      wordBreak: "break-word",
                    }}
                  >
                    <summary>View result</summary>
                    <div style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{resultSnippet}</div>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>
      {checkError && <p role="alert">{checkError}</p>}
    </HudFlyout>
  );
}
