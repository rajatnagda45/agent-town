"use client";

import Link from "next/link";
import TaskStatus from "@/components/ui/TaskStatus";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useOfficeActivity } from "@/lib/useOfficeActivity";
import { X, Square, Mic } from "lucide-react";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import { formatRelativeTime } from "@/lib/constants";
import type { ChatMessage } from "@/types/game";
import HudFlyout from "./HudFlyout";
import CharacterPortrait from "./CharacterPortrait";

// Live elapsed-time hook, ticks every second only while startedAt is set.
function useElapsed(startedAt?: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return "";
  const s = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeLabel(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function timelineIcon(msg: ChatMessage): string {
  if (msg.role === "tool") return "🔧";
  if (msg.role === "system") return "·";
  if (msg.role === "assistant") return msg.streaming ? "…" : "💬";
  return "→";
}

function timelineText(msg: ChatMessage): string {
  if (msg.role === "tool") {
    // Only show tool name — never show input/output which may contain sensitive data
    return msg.toolName;
  }
  const raw = msg.content ?? "";
  return raw.length > 72 ? raw.slice(0, 72) + "…" : raw;
}

export default function AgentDetailPanel({
  seatId,
  onClose,
}: {
  seatId: string;
  onClose: () => void;
}) {
  const { state } = useStudio();
  const office = useOfficeActivity()[seatId];
  const seat = state.seats.find((s) => s.seatId === seatId);

  // All tasks for this seat, newest first
  const seatTasks = useMemo(
    () =>
      [...state.tasks]
        .filter((t) => t.seatId === seatId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [state.tasks, seatId],
  );

  // Collect all runIds that belong to this seat
  const seatRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of seatTasks) {
      ids.add(t.taskId);
      if (t.runId) ids.add(t.runId);
    }
    return ids;
  }, [seatTasks]);

  const activeTask = seatTasks.find((t) =>
    [
      "running",
      "submitted",
      "queued",
      "returning",
      "outcome_unknown",
      "cancel_requested",
      "waiting_approval",
      "waiting_question",
    ].includes(t.status),
  );

  // Timeline: assistant + tool + system messages for this seat's runs (last 40, chrono)
  const timeline = useMemo(
    () =>
      state.chatMessages
        .filter(
          (m) =>
            seatRunIds.has(m.runId) &&
            (m.role === "assistant" || m.role === "tool" || m.role === "system"),
        )
        .slice(-40),
    [state.chatMessages, seatRunIds],
  );

  const isActiveRunning = seat?.status === "running" || seat?.status === "returning";
  const elapsedFrom = isActiveRunning ? (activeTask?.createdAt ?? seat?.startedAt) : undefined;
  const elapsed = useElapsed(elapsedFrom);

  const handleStop = useCallback(() => {
    if (!activeTask) return;
    const runId = activeTask.runId ?? activeTask.taskId;
    gameEvents.emit("stop-task", runId, seatId);
  }, [activeTask, seatId]);

  const closeAction = (
    <button
      type="button"
      className="pixel-icon-btn"
      onClick={onClose}
      title="Close panel"
      aria-label="Close agent details"
    >
      <X size={16} />
    </button>
  );

  if (!seat) {
    return (
      <HudFlyout title="Agent" headerAction={closeAction}>
        <div className="hud-empty">Seat not found.</div>
      </HudFlyout>
    );
  }

  const typeLabel = seat.roleTitle ?? (seat.seatType === "agent" ? "Agent" : "Worker");

  return (
    <HudFlyout
      title={seat.label}
      subtitle={`${typeLabel} · ${seat.status === "empty" ? "idle" : seat.status}`}
      headerAction={closeAction}
    >
      <Link className="full-chat-link" href={`/app/chat?seat=${encodeURIComponent(seatId)}`}>
        Open full conversation ↗
      </Link>
      <div className="obs-body">
        <button
          className="pixel-button pixel-button--primary voice-talk-button"
          onClick={() => gameEvents.emit("open-voice", seatId)}
        >
          <Mic size={14} /> Talk to {seat.label}
        </button>
        {/* Portrait row */}
        <div className="obs-portrait-row">
          <div className="obs-portrait-avatar">
            <CharacterPortrait spritePath={seat.spritePath} name={seat.label} />
          </div>
          <div className="obs-portrait-meta">
            <span className={`hud-status hud-status--${seat.status}`} style={{}}>
              {seat.status === "empty" ? "idle" : seat.status}
            </span>
            {elapsed && <span className="obs-elapsed">⏱ {elapsed}</span>}
          </div>
        </div>

        <dl className="office-profile-facts">
          <div>
            <dt>Connection</dt>
            <dd>{state.connection === "connected" ? "Online" : "Offline"}</dd>
          </div>
          <div>
            <dt>Office activity</dt>
            <dd>
              {state.connection !== "connected"
                ? "Paused"
                : activeTask
                  ? "Working on task"
                  : (office?.activity ?? "Available")}
            </dd>
          </div>
          <div>
            <dt>Location</dt>
            <dd>{office?.location ?? "Office"}</dd>
          </div>
        </dl>
        <p className="office-ambient-note">
          Office activity shows where your teammate is. Assigned work appears below.
        </p>
        {/* Current Task */}
        <div className="obs-section-label">Current Task</div>
        {activeTask ? (
          <div className="obs-task-card">
            <div className="obs-task-card__msg">{activeTask.message}</div>
            <div className="obs-task-card__meta">
              <TaskStatus status={activeTask.status} />
              {isActiveRunning && !!activeTask && (
                <button
                  type="button"
                  className="obs-stop-btn"
                  onClick={handleStop}
                  disabled={
                    activeTask.status === "cancel_requested" ||
                    (activeTask.status !== "queued" &&
                      !state.capabilities?.["chat.abort"]?.available)
                  }
                  title={
                    activeTask.status === "queued"
                      ? "Cancel queued task"
                      : state.capabilities?.["chat.abort"]?.reason
                  }
                >
                  <Square size={7} fill="currentColor" style={{ flexShrink: 0 }} />
                  Stop
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="hud-empty" style={{ padding: "8px 0" }}>
            No active task
          </div>
        )}

        {/* Activity Timeline */}
        <div className="obs-section-label">Activity Timeline</div>
        {timeline.length === 0 ? (
          <div className="hud-empty" style={{ padding: "8px 0" }}>
            No activity yet.
          </div>
        ) : (
          <div className="obs-timeline">
            {timeline.map((msg) => (
              <div key={msg.id} className="obs-timeline__item">
                <span className="obs-timeline__icon">{timelineIcon(msg)}</span>
                <span className="obs-timeline__time">{timeLabel(msg.timestamp)}</span>
                <span className="obs-timeline__text">{timelineText(msg)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Task History */}
        {seatTasks.length > 0 && (
          <>
            <div className="obs-section-label">
              Task History{seatTasks.length > 1 ? ` (${seatTasks.length})` : ""}
            </div>
            <div className="obs-history">
              {seatTasks.slice(0, 8).map((task) => (
                <div key={task.taskId} className="obs-history__item">
                  <TaskStatus status={task.status} />
                  <span className="obs-history__msg">{task.message}</span>
                  <span className="obs-history__time">
                    {formatRelativeTime(task.completedAt ?? task.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </HudFlyout>
  );
}
