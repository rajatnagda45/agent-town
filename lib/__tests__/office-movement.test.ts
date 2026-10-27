import { describe, expect, it, vi } from "vitest";
vi.mock("phaser", () => ({
  Math: {
    Distance: { Between: (x: number, y: number, a: number, b: number) => Math.hypot(x - a, y - b) },
  },
}));
import {
  navPoint,
  navigateTo,
  navigateHome,
  updateMovement,
} from "@/components/game/entities/worker/movement";
import type { WorkerCtx } from "@/components/game/entities/worker/types";

function context(status: "idle" | "working" = "idle") {
  const velocity = vi.fn();
  const arrival = vi.fn();
  const position = vi.fn();
  const ctx = {
    sprite: {
      x: 20,
      y: 20,
      setPosition: position,
      body: { center: { x: 20, y: 20 }, setVelocity: velocity },
      anims: { play: vi.fn() },
    },
    pathfinder: { findPath: () => null },
    homeX: 200,
    homeY: 200,
    facing: "down",
    spriteKey: "character",
    _status: status,
    onArrival: arrival,
    currentPath: [],
    pathIndex: 0,
    stopIdleActivity: vi.fn(() => {
      ctx.onArrival = null;
    }),
    scheduleWander: vi.fn(),
  } as unknown as WorkerCtx;
  return { ctx, velocity, arrival, position };
}

describe("failed movement never fabricates arrival", () => {
  it("releases ambient activity without running the interaction callback", () => {
    const { ctx, arrival, velocity } = context();
    navigateTo(ctx, 200, 200);
    expect(arrival).not.toHaveBeenCalled();
    expect(ctx.stopIdleActivity).toHaveBeenCalled();
    expect(ctx.navigationBlocked).toBe(true);
    expect(velocity).toHaveBeenCalledWith(0, 0);
  });
  it("allows genuine task dispatch in place when the desk is unreachable", () => {
    const { ctx, arrival, position } = context("working");
    navigateHome(ctx);
    expect(arrival).toHaveBeenCalledOnce();
    expect(position).not.toHaveBeenCalled();
    expect(ctx.moveTarget).toBeNull();
    expect(ctx._status).toBe("working");
  });
  it("does not skip an obstructed waypoint", () => {
    const { ctx, arrival, position } = context();
    Object.assign(ctx, {
      moveTarget: { x: 100, y: 100 },
      currentPath: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
      ],
      stuckFrames: 10000,
      lastX: 20,
      lastY: 20,
    });
    updateMovement(ctx);
    expect(ctx.navigationBlocked).toBe(true);
    expect(ctx.moveTarget).toBeNull();
    expect(arrival).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
  });
});

describe("body-center and waypoint precision", () => {
  it("uses the real fractional footprint instead of Phaser's rounded half-height", () => {
    const { ctx } = context();
    Object.assign(ctx.sprite.body!, {
      center: { x: 20, y: 53 },
      width: 24,
      height: 19.2,
      halfWidth: 12,
      halfHeight: 9,
    });
    expect(navPoint(ctx)).toEqual({ x: 20, y: 53.6 });
  });
  it("does not accept an eight-pixel early arrival or cut the next corner", () => {
    const { ctx, arrival, velocity } = context();
    Object.assign(ctx, { moveTarget: { x: 26, y: 20 }, lastX: 19, lastY: 20, stuckFrames: 0 });
    updateMovement(ctx);
    expect(arrival).not.toHaveBeenCalled();
    expect(ctx.moveTarget).toEqual({ x: 26, y: 20 });
    expect(velocity).toHaveBeenCalledWith(expect.any(Number), 0);
  });
});
