import { describe, expect, it, vi } from "vitest";
vi.mock("phaser", () => ({
  Math: {
    Distance: { Between: (x: number, y: number, a: number, b: number) => Math.hypot(x - a, y - b) },
  },
}));
import { updateAmbient, stopIdleActivity } from "@/components/game/entities/worker/idle";
import { AmbientRoutine } from "@/components/game/systems/AmbientRoutine";
import type { WorkerCtx } from "@/components/game/entities/worker/types";
function worker() {
  const routine = new AmbientRoutine("seat-0");
  routine.nextAt = 0;
  return {
    routine,
    scene: { time: { now: 20000 } },
    canWander: true,
    ambientAllowed: true,
    ambientIntensity: "calm",
    _status: "idle",
    interactionLocked: false,
    moveTarget: null,
    homeX: 10,
    homeY: 10,
    sprite: { x: 10, y: 10, body: { center: { x: 10, y: 10 } } },
    pois: [],
    reservations: new Set(),
    lastPOI: null,
    reservedPOI: null,
    hideEmote: vi.fn(),
    bubble: { hide: vi.fn() },
    navigateHome: vi.fn(),
  } as unknown as WorkerCtx;
}
describe("ambient priority and lifecycle", () => {
  for (const overrides of [
    { _status: "working" },
    { ambientAllowed: false },
    { canWander: false },
    { interactionLocked: true },
    { ambientIntensity: "off" },
  ])
    it(`does not advance an ineligible worker ${JSON.stringify(overrides)}`, () => {
      const ctx = worker();
      Object.assign(ctx, overrides);
      updateAmbient(ctx);
      expect(ctx.routine.activity).toBe("idle");
      expect(ctx.navigateHome).not.toHaveBeenCalled();
    });
  it("starts a bounded desk routine without dispatching a task", () => {
    const ctx = worker();
    updateAmbient(ctx);
    expect(ctx.routine.activity).not.toBe("idle");
    expect(ctx._status).toBe("idle");
    expect(ctx.routine.until).toBeGreaterThan(ctx.scene.time.now);
  });
  it("releases the destination and arrival callback when a task or call interrupts", () => {
    const ctx = worker();
    const poi = { name: "window", x: 20, y: 20, facing: null };
    ctx.reservedPOI = poi;
    ctx.reservations.add(poi);
    ctx.onArrival = vi.fn();
    stopIdleActivity(ctx);
    expect(ctx.reservations.size).toBe(0);
    expect(ctx.onArrival).toBeNull();
    expect(ctx.routine.nextAt).toBe(Infinity);
  });
});
