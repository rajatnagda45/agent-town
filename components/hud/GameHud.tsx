"use client";

import "./hud.css";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import { isVisibleChatMessage } from "@/lib/constants";
import { MAIN_SESSION_KEY } from "@/lib/reducer";
import { useBgm } from "@/lib/useBgm";
import { loadOnboardingDone, loadGatewayConfig, saveOnboardingDone } from "@/lib/persistence";
import type { HudDockItem, HudPanelId } from "./HudDock";
import TopBar from "./TopBar";
import BottomBar from "./BottomBar";
import ConnectionPanel from "./ConnectionPanel";
import ChatPanel from "./ChatPanel";
import TaskPanel from "./TaskPanel";
import WorkerPanel from "./WorkerPanel";
import SeatManagerModal from "./SeatManagerModal";
import MusicControls from "./MusicControls";
import OnboardingOverlay from "./OnboardingOverlay";
import AgentDetailPanel from "./AgentDetailPanel";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { useWorkspaceView } from "./WorkspaceView";
import PendingReviews from "./PendingReviews";
import OperationsPanel from "./OperationsPanel";

export default function GameHud() {
  const { state } = useStudio();
  const workspace = useWorkspaceView()!;
  const { openPanel, setOpenPanel, observingSeatId, setObservingSeatId } = workspace;
  const [seatManagerOpen, setSeatManagerOpen] = useState(false);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const seat = query.get("seat");
    const panel = query.get("panel");
    if (seat && seat !== "group") {
      setObservingSeatId(seat);
      gameEvents.emit("office-focus", seat);
    } else if (panel === "operations") setOpenPanel("operations");
  }, [setObservingSeatId, setOpenPanel]);

  useEffect(() => {
    const openInvestigation = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string" && /^inventory_[A-Za-z0-9_-]+$/.test(id)) {
        try {
          sessionStorage.setItem("agent-town:inventory:selected", id);
        } catch {
          /* storage unavailable */
        }
      }
      setObservingSeatId(null);
      setOpenPanel("operations");
    };
    window.addEventListener("agent-town:open-investigation", openInvestigation);
    return () => window.removeEventListener("agent-town:open-investigation", openInvestigation);
  }, [setObservingSeatId, setOpenPanel]);
  const voice = useVoice();
  useEffect(
    () =>
      gameEvents.on("open-voice", () => {
        setObservingSeatId(null);
        setOpenPanel("chat");
      }),
    [setObservingSeatId, setOpenPanel],
  );
  useEffect(
    () =>
      gameEvents.on("office-inspect", (seatId) => {
        setOpenPanel(null);
        setObservingSeatId(seatId);
      }),
    [setObservingSeatId, setOpenPanel],
  );
  const bgm = useBgm(voice.active);
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read browser-only onboarding preferences after hydration
    setShowOnboarding(!loadOnboardingDone() && !loadGatewayConfig());
  }, []);

  // Auto-dismiss onboarding when connection panel opens
  useEffect(() => {
    if (showOnboarding && openPanel === "connection") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacting to panel open
      setShowOnboarding(false);
      saveOnboardingDone();
    }
  }, [showOnboarding, openPanel]);

  // Auto-open connection panel on auth/connection failures
  useEffect(() => {
    if (
      state.connection === "auth_failed" ||
      state.connection === "device_pairing" ||
      state.connection === "unreachable" ||
      state.connection === "rate_limited" ||
      state.connection === "protocol_mismatch"
    ) {
      setOpenPanel("connection");
    } else if (state.connection === "connected") {
      setOpenPanel((prev) => (prev === "connection" ? null : prev));
    }
  }, [state.connection, setOpenPanel]);

  useEffect(() => {
    const closePanel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[aria-modal="true"]')) return;
      if (!openPanel && !observingSeatId && workspace.immersive) workspace.exit();
      else {
        setOpenPanel(null);
        setObservingSeatId(null);
      }
    };
    window.addEventListener("keydown", closePanel);
    return () => window.removeEventListener("keydown", closePanel);
  }, [openPanel, observingSeatId, workspace, setOpenPanel, setObservingSeatId]);

  const activeSessionKey = state.activeSessionKey ?? MAIN_SESSION_KEY;
  const visibleTasks = useMemo(
    () => state.tasks.filter((task) => task.sessionKey === activeSessionKey),
    [activeSessionKey, state.tasks],
  );
  const visibleMessages = useMemo(
    () =>
      state.chatMessages.filter(
        (message) => message.sessionKey === activeSessionKey && isVisibleChatMessage(message),
      ),
    [activeSessionKey, state.chatMessages],
  );

  // Top-right toolbar items (everything except chat)
  const toolItems: HudDockItem[] = useMemo(
    () => [
      { id: "voice", label: "Voice", icon: "", iconActive: "" },
      {
        id: "music",
        label: "Music",
        icon: "/ui/icons/icon-music.png",
        iconActive: "/ui/icons/icon-music-active.png",
      },
      {
        id: "connection",
        label: "Connection",
        icon: "/ui/icons/icon-connection.png",
        iconActive: "/ui/icons/icon-connection-active.png",
      },
      {
        id: "tasks",
        label: "Tasks",
        icon: "/ui/icons/icon-tasks.png",
        iconActive: "/ui/icons/icon-tasks-active.png",
      },
      { id: "operations", label: "Office operations", icon: "", iconActive: "" },
      {
        id: "workers",
        label: "Employees",
        icon: "/ui/icons/icon-workers.png",
        iconActive: "/ui/icons/icon-workers-active.png",
      },
    ],
    [],
  );

  const togglePanel = useCallback(
    (id: HudPanelId) => {
      setObservingSeatId(null);
      if (id === "voice") {
        voice.setMode("voice");
        setOpenPanel("chat");
        return;
      }
      setOpenPanel((current) => (current === id ? null : id));
    },
    [voice, setObservingSeatId, setOpenPanel],
  );

  const handleSeatClick = useCallback(
    (seatId: string) => {
      setOpenPanel(null);
      setObservingSeatId((prev) => (prev === seatId ? null : seatId));
      gameEvents.emit("office-focus", seatId);
    },
    [setObservingSeatId, setOpenPanel],
  );

  const musicIconOverrides = useMemo(
    () => (bgm.volume <= 0 ? { music: "/ui/icons/icon-music-muted.png" as string } : undefined),
    [bgm.volume],
  );

  const topRightPanelOpen =
    (openPanel && openPanel !== "chat" && openPanel !== "voice") || observingSeatId;

  return (
    <div className="hud-overlay">
      {/* Top area: logo | agent pills | tool buttons */}
      <TopBar
        seats={state.seats}
        connection={state.connection}
        toolItems={toolItems}
        openPanel={openPanel}
        onToggle={togglePanel}
        iconOverrides={musicIconOverrides}
        onSeatClick={handleSeatClick}
        selectedSeatId={observingSeatId}
        voiceStatus={voice.status}
        voiceActive={voice.active}
        voiceSeatId={voice.active ? voice.agent?.seatId : undefined}
      />

      {/* Top-right flyout panels */}
      {topRightPanelOpen && (
        <div className="hud-topright-flyout">
          {observingSeatId ? (
            <AgentDetailPanel seatId={observingSeatId} onClose={() => setObservingSeatId(null)} />
          ) : (
            <>
              {openPanel === "music" ? <MusicControls bgm={bgm} /> : null}
              {openPanel === "connection" ? <ConnectionPanel /> : null}
              {openPanel === "tasks" ? <TaskPanel tasks={visibleTasks} /> : null}
              {openPanel === "operations" ? <OperationsPanel /> : null}
              {openPanel === "workers" ? (
                <WorkerPanel
                  seats={state.seats}
                  onInspect={handleSeatClick}
                  onOpenManager={() => setSeatManagerOpen(true)}
                />
              ) : null}
            </>
          )}
        </div>
      )}

      {/* Bottom area: status pills (left) + chat dock (right) */}
      <div className="layout-bottom">
        <div className="workspace-status">
          <PendingReviews />
          <BottomBar
            connection={state.connection}
            setupReason={
              state.capabilities?.["chat.send"]?.available === false
                ? state.capabilities["chat.send"].reason
                : undefined
            }
            sessionMetrics={state.sessionMetrics}
            seats={state.seats}
          />
        </div>
        {/* Spacer pushes chat to right */}
        <div style={{ flex: "1 1 auto" }} />

        {/* Chat dock */}
        <div className="hud-chat-dock">
          {openPanel === "chat" && (
            <div className="hud-chat-dock__panel">
              <ChatPanel
                key={activeSessionKey}
                messages={visibleMessages}
                tasks={visibleTasks}
                isConnected={state.connection === "connected"}
                sessions={state.sessions}
                activeSessionKey={state.activeSessionKey}
              />
            </div>
          )}
          <button
            type="button"
            className={`hud-chat-dock__btn ${openPanel === "chat" ? "hud-chat-dock__btn--active" : ""}`}
            onClick={() => togglePanel("chat")}
            title="Chat"
            aria-expanded={openPanel === "chat"}
          >
            <Image
              src={
                openPanel === "chat" ? "/ui/icons/icon-chat-active.png" : "/ui/icons/icon-chat.png"
              }
              alt="Chat"
              width={28}
              height={28}
              style={{ imageRendering: "pixelated" }}
            />
            <span className="hud-chat-dock__label">Chat</span>
          </button>
        </div>
      </div>

      {/* Modals */}
      <SeatManagerModal
        open={seatManagerOpen}
        onClose={() => setSeatManagerOpen(false)}
        seats={state.seats}
      />

      {showOnboarding && <OnboardingOverlay onDone={() => setShowOnboarding(false)} />}
    </div>
  );
}
