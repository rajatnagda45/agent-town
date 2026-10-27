"use client";

import { useEffect, useRef } from "react";
import { OfficeEngine } from "./engine";
import type { WorkerSnapshot } from "./status";

export function OfficeCanvas({ onStatus }: { onStatus?: (workers: WorkerSnapshot[]) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const engine = new OfficeEngine(canvas, media.matches, onStatus);
    let visible = false;
    let disposed = false;
    const sync = () => (visible && !document.hidden ? engine.start() : engine.stop());
    const motion = () => {
      engine.stop();
      engine.reduced = media.matches;
      engine.intro = 1;
      engine.draw();
      sync();
    };
    media.addEventListener("change", motion);
    const ro = new ResizeObserver(([e]) => e && engine.resize(e.contentRect.width));
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = Boolean(e?.isIntersecting);
      sync();
    });
    io.observe(canvas);
    const vis = sync;
    document.addEventListener("visibilitychange", vis);
    const move = (ev: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      engine.pointer((ev.clientX - b.left) / b.width - 0.5, (ev.clientY - b.top) / b.height - 0.5);
    };
    const leave = () => engine.pointer(0, 0);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    document.fonts?.ready.then(() => {
      if (!disposed) engine.draw();
    });
    return () => {
      disposed = true;
      engine.stop();
      ro.disconnect();
      io.disconnect();
      media.removeEventListener("change", motion);
      document.removeEventListener("visibilitychange", vis);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, [onStatus]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Local demo simulation: six pixel-art workers in Agent Town; current activities are listed in Meet the Crew"
      className="block aspect-[3/2] w-full [image-rendering:pixelated]"
      style={{
        maskImage: "radial-gradient(ellipse 85% 88% at 52% 50%, black 62%, transparent 100%)",
        WebkitMaskImage: "radial-gradient(ellipse 85% 88% at 52% 50%, black 62%, transparent 100%)",
      }}
    />
  );
}
