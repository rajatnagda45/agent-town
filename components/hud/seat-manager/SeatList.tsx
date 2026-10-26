"use client";

import type { SeatState, SeatType } from "@/types/game";
import CharacterPortrait from "../CharacterPortrait";

function seatStateLabel(seat: SeatState) {
  if (!seat.assigned) return "vacant";
  if (seat.status === "empty") return "idle";
  return seat.status;
}

function seatSummary(seat: SeatState) {
  if (!seat.assigned) return "No crew assigned";
  if (seat.status === "returning") return seat.taskSnippet ?? "Returning to desk";
  if (seat.status === "running") return seat.taskSnippet ?? "Handling task";
  if (seat.status === "done") return "Recently completed task";
  if (seat.status === "failed") return "Last task failed";
  return "Ready for a task";
}

function seatTypeIcon(type: SeatType) {
  return type === "agent" ? "◆" : "●";
}

interface SeatListProps {
  seats: SeatState[];
  selectedSeatId: string;
  dirtyIds?: string[];
  onSelectSeat: (seat: SeatState) => void;
}

export default function SeatList({
  seats,
  selectedSeatId,
  dirtyIds = [],
  onSelectSeat,
}: SeatListProps) {
  return (
    <nav className="team-roster" aria-label="Team seats">
      {seats.map((seat, index) => {
        const active = seat.seatId === selectedSeatId;
        const statusLabel = seatStateLabel(seat);
        return (
          <button
            key={seat.seatId}
            type="button"
            className={`seat-card ${active ? "seat-card--active" : ""}`}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelectSeat(seat)}
          >
            <div className="seat-card__info">
              <div className={`seat-manager__portrait-frame seat-manager__portrait-frame--small`}>
                {seat.assigned && seat.spritePath ? (
                  <CharacterPortrait spritePath={seat.spritePath} name={seat.label} />
                ) : (
                  <span style={{ color: "var(--pixel-muted)" }}>EMPTY</span>
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    color: "var(--pixel-muted)",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      color:
                        seat.seatType === "agent" ? "var(--pixel-accent)" : "var(--pixel-muted)",
                    }}
                  >
                    {seatTypeIcon(seat.seatType)}
                  </span>
                  Seat {index + 1}
                  {dirtyIds.includes(seat.seatId) && (
                    <span className="team-draft-dot" title="Unsaved changes">
                      {" "}
                      · Draft
                    </span>
                  )}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {seat.assigned ? seat.label : "Vacant Seat"}
                </div>
                <div style={{ color: "var(--pixel-muted)", marginTop: 4 }}>
                  {seat.assigned
                    ? (seat.roleTitle ?? (seat.seatType === "agent" ? "Agent" : "Worker"))
                    : "Unassigned"}
                </div>
              </div>
              <div
                className={`seat-card__status ${statusLabel === "running" ? "seat-card__status--running" : ""}`}
                style={{
                  color: statusLabel === "vacant" ? "var(--pixel-muted)" : "var(--pixel-text)",
                }}
              >
                {statusLabel}
              </div>
            </div>
            <div className="seat-card__summary">{seatSummary(seat)}</div>
          </button>
        );
      })}
    </nav>
  );
}
