// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerManager } from "@/components/game/systems/WorkerManager";
import type { InteractionManager } from "@/components/game/systems/InteractionManager";

vi.mock("phaser", () => ({
  AUTO: 0,
  Scale: { RESIZE: 1, NO_CENTER: 0 },
  Scenes: { Events: { SHUTDOWN: "shutdown", DESTROY: "destroy" } },
  Scene: class {
    events = {
      handlers: new Map<string, { fn: (...args: unknown[]) => void; context: unknown }>(),
      once(name: string, fn: (...args: unknown[]) => void, context: unknown) {
        this.handlers.set(name, { fn, context });
      },
      off(name: string) {
        this.handlers.delete(name);
      },
      emit(name: string) {
        const handler = this.handlers.get(name);
        this.handlers.delete(name);
        handler?.fn.call(handler.context);
      },
    };
    cache = { tilemap: { get: () => undefined } };
  },
}));
import { OfficeScene } from "@/components/game/scenes/OfficeScene";
import { gameConfig } from "@/components/game/config";
import { initSceneEventBridge } from "@/components/game/systems/SceneEventBridge";
import { gameEvents } from "../events";

afterEach(() => vi.restoreAllMocks());

it.each(["destroy", "shutdown"])(
  "disconnects global listeners on %s and tolerates repeated disposal",
  (event) => {
    const scene = new OfficeScene();
    scene.init();
    const manager = {
      workers: [],
      syncWorkers: vi.fn(),
      publishActivities: vi.fn(),
      destroyAll: vi.fn(),
    };
    const interaction = { clearIfNearest: vi.fn(), destroy: vi.fn() };
    const detach = initSceneEventBridge(
      manager as unknown as WorkerManager,
      interaction as unknown as InteractionManager,
      new Map(),
      vi.fn(),
    );
    const motionCleanup = vi.fn();
    Object.assign(scene, {
      workerManager: manager,
      interactionManager: interaction,
      cleanupEventBridge: detach,
      cleanupMotion: motionCleanup,
    });
    gameEvents.emit("seat-configs-updated", []);
    expect(manager.syncWorkers).toHaveBeenCalledOnce();
    scene.events.emit(event);
    gameEvents.emit("seat-configs-updated", []);
    gameEvents.emit("office-runtime", "connected", undefined, "idle");
    document.dispatchEvent(new Event("visibilitychange"));
    scene.dispose();
    expect(manager.syncWorkers).toHaveBeenCalledOnce();
    expect(manager.destroyAll).toHaveBeenCalledOnce();
    expect(interaction.destroy).toHaveBeenCalledOnce();
    expect(motionCleanup).toHaveBeenCalledOnce();
    expect(scene.readOfficeFrame()).toBeNull();
    expect(() => scene.update()).not.toThrow();
  },
);

it("reports missing assets without updating uninitialized scene systems", () => {
  const scene = new OfficeScene();
  scene.init();
  const error = vi.fn();
  const off = gameEvents.on("office-load-error", error);
  try {
    expect(() => scene.create()).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("map could not load"));
    expect(() => scene.update()).not.toThrow();
    expect(() => scene.chooseOfficeMenu(0)).not.toThrow();
    expect(scene.readOfficeFrame()).toBeNull();
  } finally {
    off();
    scene.dispose();
  }
});

it("does not create an unused Phaser AudioContext alongside voice and music", () => {
  expect(gameConfig.audio).toEqual({ noAudio: true });
});
