"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import type { AgentDef } from "./officeData";

export type CharDef = Pick<AgentDef, "hair" | "skin" | "shirt" | "pants" | "cap">;

// Internal canvas resolution
const CW = 12,
  CH = 20,
  SC = 4;

function draw(ctx: CanvasRenderingContext2D, def: CharDef, bobY: number) {
  ctx.clearRect(0, 0, CW * SC, CH * SC);
  const f = (x: number, y: number, w: number, h: number, col: string) => {
    ctx.fillStyle = col;
    ctx.fillRect(x * SC, y * SC, w * SC, h * SC);
  };

  const X = 1;
  const Y = 3 - bobY; // bob upward

  // shadow at feet
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fillRect((X + 1) * SC, (Y + 15) * SC, 7 * SC, SC);

  // legs
  f(X + 2, Y + 11, 2, 3, def.pants);
  f(X + 5, Y + 11, 2, 3, def.pants);

  // body / torso
  f(X + 1, Y + 7, 7, 5, def.shirt);

  // arms
  f(X, Y + 8, 1, 3, def.skin);
  f(X + 8, Y + 8, 1, 3, def.skin);

  // head
  f(X + 1, Y + 1, 7, 6, def.skin);

  // hair — front-facing style (matches engine.ts)
  f(X + 1, Y, 7, 2, def.hair); // top band
  f(X + 1, Y + 1, 1, 3, def.hair); // left side strand
  f(X + 7, Y + 1, 1, 3, def.hair); // right side strand

  // eyes
  f(X + 3, Y + 3, 1, 1, "#1a1410");
  f(X + 5, Y + 3, 1, 1, "#1a1410");

  // cap (optional)
  if (def.cap) f(X, Y - 1, 9, 2, def.cap);
}

interface Props {
  def: CharDef;
  className?: string;
  animate?: boolean;
}

export function PixelCharacter({ def, className = "", animate = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  // Keep def in a ref so the animation loop always reads the latest value
  // without needing it as an effect dependency
  const defRef = useRef(def);
  useLayoutEffect(() => {
    defRef.current = def;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!animate || reduced) {
      draw(ctx, defRef.current, 0);
      return;
    }

    const tick = () => {
      frameRef.current++;
      const bobY = Math.sin(frameRef.current * 0.045) > 0.5 ? 1 : 0;
      draw(ctx, defRef.current, bobY);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [animate]);

  return (
    <canvas
      ref={canvasRef}
      width={CW * SC}
      height={CH * SC}
      className={`[image-rendering:pixelated] ${className}`}
      style={{ display: "block", width: "auto" }}
    />
  );
}
