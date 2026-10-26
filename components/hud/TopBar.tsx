"use client";
import Link from "next/link";
import { useSyncExternalStore } from "react";

import { useOfficeActivity } from "@/lib/useOfficeActivity";
import { Mic, Volume2, Share2, ListTodo, Users, Building2, Activity } from "lucide-react";
import type { SeatState, ConnectionStatus } from "@/types/game";
import type { HudPanelId, HudDockItem } from "./HudDock";
import CharacterPortrait from "./CharacterPortrait";

interface TopBarProps {
  seats: SeatState[];
  connection: ConnectionStatus;
  toolItems: HudDockItem[];
  openPanel: HudPanelId | null;
  onToggle: (id: HudPanelId) => void;
  iconOverrides?: Partial<Record<HudPanelId, string>>;
  onSeatClick?: (seatId: string) => void;
  selectedSeatId?: string | null;
  voiceActive?: boolean;
  voiceSeatId?: string;
  voiceStatus?: import("@/lib/voice/client").VoiceStatus;
}

function subscribeLocation(notify: () => void) {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}

function seatDotColor(seat: SeatState): string {
  if (!seat.assigned) return "gray";
  if (seat.status === "running" || seat.status === "returning") return "yellow";
  if (seat.status === "failed") return "red";
  return "green";
}

export default function TopBar({
  seats,
  connection,
  toolItems,
  openPanel,
  onToggle,
  onSeatClick,
  selectedSeatId,
  voiceActive,
  voiceSeatId,
  voiceStatus,
}: TopBarProps) {
  const search = useSyncExternalStore(
    subscribeLocation,
    () => window.location.search,
    () => "",
  );
  const params = new URLSearchParams(search);
  const returnSession = params.get("seat") === selectedSeatId ? (params.get("session") ?? "") : "";
  const activities = useOfficeActivity();
  const assignedSeats = seats.filter((s) => s.assigned);

  return (
    <div className="layout-top">
      {/* Left: logo */}
      <div className="layout-topbar__title">
        <span className="layout-topbar__logo">
          <Building2 size={23} aria-hidden="true" />
          AGENT TOWN
        </span>
      </div>

      {/* Center: agent pills (each pill is its own floating element) */}
      <div className="layout-topbar__agents">
        {assignedSeats.map((seat) => (
          <button
            key={seat.seatId}
            type="button"
            className={`topbar-agent-pill ${
              seat.status === "running" || seat.status === "returning"
                ? "topbar-agent-pill--active"
                : ""
            } ${voiceSeatId === seat.seatId ? "topbar-agent-pill--talking" : ""}`}
            aria-pressed={selectedSeatId === seat.seatId}
            onClick={() => onSeatClick?.(seat.seatId)}
            title={`${seat.label} — ${connection === "connected" ? seat.status : "offline"}`}
            aria-label={`${seat.label}, ${connection === "connected" ? (seat.status === "empty" ? "Idle" : seat.status) : "Offline"}. Inspect worker`}
          >
            <div className="topbar-agent-pill__avatar">
              <CharacterPortrait spritePath={seat.spritePath} name={seat.label} />
            </div>
            <span className="topbar-agent-pill__identity">
              <span className="topbar-agent-pill__name">{seat.label}</span>
              <span className="topbar-agent-pill__activity">
                {voiceSeatId === seat.seatId
                  ? voiceStatus === "connecting"
                    ? "Connecting call"
                    : voiceStatus === "speaking"
                      ? "Speaking"
                      : voiceStatus === "thinking"
                        ? "Thinking"
                        : voiceStatus === "muted"
                          ? "Call · muted"
                          : "Listening"
                  : connection !== "connected"
                    ? "Offline"
                    : !seat.binding?.available
                      ? "Setup needed"
                      : seat.status === "running"
                        ? "Working"
                        : seat.status === "returning"
                          ? "Returning"
                          : seat.status === "failed"
                            ? "Needs attention"
                            : seat.status === "done"
                              ? "Complete"
                              : (activities[seat.seatId]?.activity ?? "Available")}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`pixel-dot pixel-dot--${connection === "connected" ? (seat.binding?.available ? seatDotColor(seat) : "yellow") : "gray"}`}
            />
          </button>
        ))}
        {assignedSeats.length === 0 && (
          <span className="topbar-agent-pill__empty">No agents assigned</span>
        )}
      </div>

      {/* Right: tool buttons group */}
      <div className="layout-topbar__tools">
        <Link
          className="full-chat-link"
          href={`/app/chat?seat=${encodeURIComponent(selectedSeatId ?? "group")}${returnSession ? `&session=${encodeURIComponent(returnSession)}` : ""}`}
        >
          Chat & Tasks ↗
        </Link>
        {toolItems.map((item) => {
          const active = openPanel === item.id;
          const Icon =
            item.id === "music"
              ? Volume2
              : item.id === "connection"
                ? Share2
                : item.id === "tasks"
                  ? ListTodo
                  : item.id === "operations"
                    ? Activity
                    : Users;
          return (
            <button
              key={item.id}
              type="button"
              data-dock-id={item.id}
              onClick={() => onToggle(item.id)}
              title={item.id === "voice" && voiceActive ? "Voice call active" : item.label}
              aria-label={item.id === "voice" && voiceActive ? "Voice call active" : item.label}
              aria-pressed={active}
              className={`topbar-tool-btn ${active ? "topbar-tool-btn--active" : ""}`}
            >
              {item.id === "voice" ? (
                <Mic
                  size={22}
                  className={voiceActive ? "voice-toolbar--active" : ""}
                  aria-hidden="true"
                />
              ) : (
                <Icon size={19} aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
