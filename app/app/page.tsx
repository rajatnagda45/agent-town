"use client";

import { WorkspaceView } from "@/components/hud/WorkspaceView";
import dynamic from "next/dynamic";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GameErrorBoundary } from "@/components/game/GameErrorBoundary";
import TerminalModal from "@/components/panel/TerminalModal";
import WorkerSessionHistoryModal from "@/components/panel/WorkerSessionHistoryModal";
import GameHud from "@/components/hud/GameHud";
import "@/components/hud/cinematic.css";
import "@/components/hud/workspace.css";

const PhaserGame = dynamic(() => import("@/components/game/PhaserGame"), {
  ssr: false,
});

export default function Page() {
  return (
    <ErrorBoundary>
      <WorkspaceView>
        {/* Game canvas — full screen background */}
        <div className="office-world absolute inset-0">
          <GameErrorBoundary>
            <PhaserGame />
          </GameErrorBoundary>
        </div>
        {/* HUD overlay — floating UI on top */}
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}>
          <GameHud />
        </div>
        <TerminalModal />
        <WorkerSessionHistoryModal />
      </WorkspaceView>
    </ErrorBoundary>
  );
}
