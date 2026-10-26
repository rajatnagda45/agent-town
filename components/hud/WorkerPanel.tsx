"use client";

import { useEffect, useState } from "react";
import { Search, ArrowUpRight, Users } from "lucide-react";
import { runtimeRequest } from "@/lib/store";
import type { SeatState } from "@/types/game";
import HudFlyout from "./HudFlyout";
import CharacterPortrait from "./CharacterPortrait";

interface SpecialistActivity {
  id: string;
  role?: string;
  requestedBy: "agent" | "user";
  reason: string;
  taskId?: string | null;
  seatId?: string;
  tools: string[];
  skills: string[];
  templateVersion?: string;
  templateSource?: string;
  executionStatus: string;
  lifecycle: string;
}

export default function WorkerPanel({
  seats,
  onOpenManager,
  onInspect,
}: {
  seats: SeatState[];
  onOpenManager: () => void;
  onInspect?: (seatId: string) => void;
}) {
  const [specialists, setSpecialists] = useState<SpecialistActivity[]>([]);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () =>
      void runtimeRequest<{ specialists?: SpecialistActivity[] }>("office-overview")
        .then((view) => {
          if (!closed) setSpecialists(view.specialists ?? []);
        })
        .catch(() => {});
    const events = new EventSource("/api/runtime/events");
    events.onmessage = (message) => {
      try {
        if (!/^laneD\.|^task$|^seat$/.test(JSON.parse(message.data).kind)) return;
      } catch {
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 180);
    };
    refresh();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      events.close();
    };
  }, []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const assigned = seats.filter((s) => s.assigned).length;
  const busy = (s: SeatState) => s.assigned && ["running", "returning"].includes(s.status);
  const working = seats.filter(busy).length;
  const visible = seats.filter(
    (s) =>
      (filter === "all" || (filter === "busy" ? busy(s) : !s.assigned)) &&
      [s.label, s.roleTitle, s.agentConfig?.agentId]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <HudFlyout
      title="Employees"
      subtitle="Your people, their roles, and live assignments"
      headerAction={
        <button
          type="button"
          className="pixel-button pixel-button--primary"
          onClick={onOpenManager}
        >
          Manage Seats
        </button>
      }
    >
      <div className="team-directory">
        <div className="workspace-metrics" aria-label="Team overview">
          <div>
            <strong>
              {assigned}
              <small> / {seats.length}</small>
            </strong>
            <span>Assigned</span>
          </div>
          <div>
            <strong>{working}</strong>
            <span>Busy now</span>
          </div>
          <div>
            <strong>{seats.length - assigned}</strong>
            <span>Available seats</span>
          </div>
        </div>
        <label className="workspace-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="Search team"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people or roles…"
          />
        </label>
        <div className="ui-segmented" role="group" aria-label="Filter team">
          {[
            ["all", "Everyone"],
            ["busy", "Busy"],
            ["vacant", "Available seats"],
          ].map(([id, label]) => (
            <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="team-directory__list">
          {visible.map((seat) => (
            <button
              key={seat.seatId}
              className="team-directory__person"
              onClick={() =>
                seat.assigned && onInspect ? onInspect(seat.seatId) : onOpenManager()
              }
            >
              <span className="team-directory__avatar">
                {seat.assigned ? (
                  <CharacterPortrait spritePath={seat.spritePath} name={seat.label} />
                ) : (
                  <Users size={20} />
                )}
              </span>
              <span className="team-directory__identity">
                <strong>{seat.assigned ? seat.label : "Available seat"}</strong>
                <span>
                  {seat.assigned
                    ? seat.roleTitle || (seat.seatType === "agent" ? "Independent agent" : "Worker")
                    : "Add someone to your office"}
                </span>
                {seat.taskSnippet && <small>{seat.taskSnippet}</small>}
              </span>
              <span
                className={busy(seat) ? "directory-state directory-state--busy" : "directory-state"}
              >
                {!seat.assigned ? (
                  <ArrowUpRight size={16} />
                ) : busy(seat) ? (
                  "Working"
                ) : seat.status === "failed" ? (
                  "Needs attention"
                ) : (
                  "Idle"
                )}
              </span>
            </button>
          ))}
          {!visible.length && (
            <div className="hud-empty">No seats match this view. Try another name or filter.</div>
          )}
        </div>
        {specialists.length > 0 && (
          <section aria-label="Specialist assignments">
            <h3>Specialist assignments</h3>
            {specialists.map((item) => (
              <div className="hud-workers__item" key={item.id}>
                <strong>{item.role ?? "Specialist"}</strong> · {item.lifecycle.replaceAll("_", " ")}
                <div>
                  Requested by {item.requestedBy} · {item.reason.replaceAll("_", " ")}
                </div>
                <div>
                  Task {item.taskId ?? "waiting"} · Seat {item.seatId ?? "unplaced"}
                </div>
                <div>Tools: {item.tools.length ? item.tools.join(", ") : "none"}</div>
                {item.skills.length > 0 && <div>Skills: {item.skills.join(", ")}</div>}
                <small>
                  {item.templateSource ?? "reviewed"} · v{item.templateVersion ?? "unknown"} ·{" "}
                  {item.executionStatus.replaceAll("_", " ")}
                </small>
              </div>
            ))}
          </section>
        )}
      </div>
    </HudFlyout>
  );
}
