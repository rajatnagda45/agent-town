"use client";

import { useEffect, useRef, useState } from "react";
import type * as PhaserTypes from "phaser";
import type { OfficeRenderer } from "./three/OfficeRenderer";
import type { OfficeScene } from "./scenes/OfficeScene";
import { useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { gameEvents } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import "./three/office.css";
import OfficeControls from "@/components/hud/OfficeControls";

const log = createLogger("Office");

export default function PhaserGame() {
  const { state } = useStudio();
  const voice = useVoice();
  useEffect(() => {
    const publish = () =>
      gameEvents.emit("office-runtime", state.connection, voice.agent?.seatId, voice.status);
    publish();
    return gameEvents.on("office-runtime-request", publish);
  }, [state.connection, voice.agent?.seatId, voice.status]);
  const gameRef = useRef<PhaserTypes.Game | null>(null);
  const renderRef = useRef<OfficeRenderer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const threeRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(false);
  const [cinematic, setCinematic] = useState(true);
  const [intensity, setIntensity] = useState<import("./systems/AmbientRoutine").AmbientIntensity>(
    () => {
      try {
        const v = localStorage.getItem("agent-town:ambient");
        return v === "off" || v === "lively" ? v : "calm";
      } catch {
        return "calm";
      }
    },
  );
  const [daylight, setDaylight] = useState("day");
  const [error, setError] = useState("");

  useEffect(() => {
    const publish = () => gameEvents.emit("office-settings", intensity);
    publish();
    try {
      localStorage.setItem("agent-town:ambient", intensity);
    } catch {}
    return gameEvents.on("office-runtime-request", publish);
  }, [intensity]);
  useEffect(() => {
    renderRef.current?.setDaylight(daylight === "day");
  }, [daylight]);

  useEffect(() => {
    let mounted = true;
    let stopFrames: (() => void) | undefined;
    let stopAttach: (() => void) | undefined;
    const offFocus = gameEvents.on("office-focus", (id) => renderRef.current?.focus(id));
    const offLoadError = gameEvents.on("office-load-error", (message) => {
      if (!mounted) return;
      setError(message);
      setLoading(false);
    });
    async function init() {
      const [{ gameConfig }, Phaser, { OfficeRenderer }] = await Promise.all([
        import("./config"),
        import("phaser"),
        import("./three/OfficeRenderer"),
      ]);
      if (!mounted || !containerRef.current) return;
      const game = new Phaser.Game({ ...gameConfig, parent: containerRef.current });
      gameRef.current = game;
      game.scale.resize(containerRef.current.clientWidth, containerRef.current.clientHeight);
      const attach = () => {
        if (!mounted) return;
        const scene = game.scene.getScene("OfficeScene") as OfficeScene;
        if (!scene?.readOfficeFrame()) return;
        game.events.off(Phaser.Core.Events.POST_STEP, attach);
        if (!mounted || !threeRef.current) return;
        try {
          const view = new OfficeRenderer(
            threeRef.current,
            {
              read: () => scene.readOfficeFrame(),
              inspect: (seatId) =>
                seatId === "boss"
                  ? gameEvents.emit("open-terminal")
                  : gameEvents.emit("office-inspect", seatId),
              chooseMenu: (index) => scene.chooseOfficeMenu(index),
            },
            (message) => {
              if (mounted) {
                setError(message);
                setCinematic(false);
              }
            },
          );
          renderRef.current = view;
          setAvailable(true);
          scene.sys.setVisible(false);
          const render = (time: number, delta: number) => view.render(time, delta);
          game.events.on(Phaser.Core.Events.POST_STEP, render);
          stopFrames = () => game.events.off(Phaser.Core.Events.POST_STEP, render);
        } catch (err) {
          log.error("3D renderer unavailable", err);
          setError(
            "3D rendering is unavailable on this device. The original office remains fully usable.",
          );
          setCinematic(false);
        }
        setLoading(false);
      };
      game.events.on(Phaser.Core.Events.POST_STEP, attach);
      stopAttach = () => game.events.off(Phaser.Core.Events.POST_STEP, attach);
    }
    init().catch((err) => {
      log.error("Office initialization failed", err);
      if (mounted) {
        setError("The office could not load. Refresh to try again.");
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      offFocus();
      offLoadError();
      stopAttach?.();
      stopFrames?.();
      renderRef.current?.dispose();
      renderRef.current = null;
      const game = gameRef.current;
      const scene = game?.scene.getScene("OfficeScene") as OfficeScene | undefined;
      scene?.dispose();
      game?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    renderRef.current?.setVisible(cinematic);
    const scene = gameRef.current?.scene.getScene("OfficeScene");
    scene?.sys.setVisible(!cinematic);
  }, [cinematic]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0)
        gameRef.current?.scale.resize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={`office-stage ${cinematic ? "office-stage--3d" : "office-stage--classic"}`}>
      <div className="office-simulation" ref={containerRef} aria-hidden={cinematic} />
      <div className="office-three" ref={threeRef} hidden={!cinematic} />
      {loading && (
        <div className="office-loading" role="status">
          <span className="office-loading__mark">AT</span>
          <strong>Opening the office</strong>
          <span>Preparing your workspace…</span>
        </div>
      )}
      {error && (
        <div className="office-render-error" role="status">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss rendering notice">
            ×
          </button>
        </div>
      )}
      <OfficeControls
        cinematic={cinematic}
        available={available}
        loading={loading}
        intensity={intensity}
        daylight={daylight}
        onRecenter={() => renderRef.current?.resetCamera()}
        onToggleView={() => setCinematic((value) => !value)}
        onIntensity={setIntensity}
        onDaylight={setDaylight}
      />
    </div>
  );
}
