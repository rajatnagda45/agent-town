"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { HudPanelId } from "./HudDock";

function useWorkspaceState() {
  const [immersive, setImmersive] = useState(false);
  const [openPanel, setOpenPanel] = useState<HudPanelId | null>(null);
  const [observingSeatId, setObservingSeatId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const previous = useRef<{ panel: HudPanelId | null; seat: string | null } | null>(null);
  const ownedFullscreen = useRef(false);
  const mounted = useRef(true);
  const exit = useCallback(() => {
    setImmersive(false);
    setNotice("");
    if (previous.current) {
      setOpenPanel(previous.current.panel);
      setObservingSeatId(previous.current.seat);
      previous.current = null;
    }
    if (document.fullscreenElement === document.querySelector<HTMLElement>(".office-app"))
      void document.exitFullscreen().catch(() => {});
  }, []);
  const enter = () => {
    if (immersive) return;
    previous.current = { panel: openPanel, seat: observingSeatId };
    setOpenPanel(null);
    setObservingSeatId(null);
    setImmersive(true);
    setNotice("");
  };
  const fullscreen = async () => {
    enter();
    if (
      !document.querySelector<HTMLElement>(".office-app")?.requestFullscreen ||
      !document.fullscreenEnabled
    ) {
      setNotice("Browser fullscreen is unavailable. Full View is still active.");
      return;
    }
    try {
      await document.querySelector<HTMLElement>(".office-app")!.requestFullscreen();
      if (!mounted.current) {
        if (document.fullscreenElement) await document.exitFullscreen();
        return;
      }
      ownedFullscreen.current = true;
    } catch {
      if (!mounted.current) return;
      setNotice("Browser fullscreen was declined. Full View is still active.");
    }
  };
  useEffect(() => {
    mounted.current = true;
    const change = () => {
      if (!document.fullscreenElement && ownedFullscreen.current) {
        ownedFullscreen.current = false;
        exit();
      }
    };
    document.addEventListener("fullscreenchange", change);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", change);
      if (ownedFullscreen.current && document.fullscreenElement)
        void document.exitFullscreen().catch(() => {});
    };
  }, [exit]);
  return {
    immersive,
    openPanel,
    setOpenPanel,
    observingSeatId,
    setObservingSeatId,
    enter,
    exit,
    fullscreen,
    notice,
  };
}
const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceState> | null>(null);
export function WorkspaceView({ children }: { children: React.ReactNode }) {
  const value = useWorkspaceState();
  return (
    <WorkspaceContext.Provider value={value}>
      <main
        className={`office-app relative w-screen h-screen overflow-hidden${value.immersive ? " office-app--immersive" : ""}`}
      >
        {children}
        {value.notice && (
          <div className="workspace-fullscreen-notice" role="status">
            {value.notice}
          </div>
        )}
      </main>
    </WorkspaceContext.Provider>
  );
}
export function useWorkspaceView() {
  return useContext(WorkspaceContext);
}
