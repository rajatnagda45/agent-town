import { describe, expect, it } from "vitest";
import { OfficeAssets } from "@/components/game/three/assets";
import { OfficeCharacter } from "@/components/game/three/character";
import { worldPosition, shortestAngle, type OfficeActor } from "@/components/game/three/types";

const actor: OfficeActor = {
  id: "seat-1",
  label: "Alice",
  spriteKey: "character_02",
  x: 680,
  y: 500,
  facing: "down",
  moving: false,
  atDesk: false,
  status: "idle",
  voice: "idle",
  connection: "connected",
  activity: "",
  bubble: "",
};

describe("3D office presentation boundary", () => {
  it("maps the Tiled navigation coordinate system to world space without changing simulation data", () => {
    expect(worldPosition(680, 500)).toEqual({ x: 0, z: 0 });
    expect(worldPosition(728, 548)).toEqual({ x: 1, z: 1 });
    const input = Object.freeze({ ...actor, x: 728 });
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, input.id);
    model.update(input, 1 / 60, false);
    expect(model.root.position.x).toBe(1);
    expect(input.x).toBe(728);
    model.dispose();
    assets.dispose();
  });
  it("turns along the shortest arc across the angle boundary", () => {
    expect(shortestAngle(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });
  it("only types while genuine connected work is active", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id);
    const arm = model.root.getObjectByName("arm-0")!;
    model.update(actor, 1 / 60, false);
    expect(arm.rotation.x).toBe(0);
    model.update({ ...actor, status: "working", atDesk: true }, 1 / 60, false);
    expect(arm.rotation.x).toBeLessThan(-0.7);
    model.update({ ...actor, status: "working", connection: "disconnected" }, 1 / 60, false);
    expect(arm.rotation.x).toBe(0);
    model.dispose();
    assets.dispose();
  });
  it("reconciles speaking gestures immediately when the actual call ends", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id);
    const arm = model.root.getObjectByName("arm-0")!;
    model.update({ ...actor, voice: "speaking" }, 1 / 60, false);
    expect(arm.rotation.x).not.toBe(0);
    model.update({ ...actor, voice: "idle" }, 1 / 60, false);
    expect(arm.rotation.x).toBe(0);
    expect(arm.rotation.z).toBe(0);
    model.dispose();
    assets.dispose();
  });
  it("reduced motion preserves navigation while suppressing the optional walk cycle", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id);
    model.update({ ...actor, moving: true, x: 776 }, 1 / 60, true);
    expect(model.root.position.x).toBe(2);
    expect(model.root.getObjectByName("leg-0")!.rotation.x).toBe(0);
    model.dispose();
    assets.dispose();
  });
});
