import { AMBIENT_POIS, NAV_CLEARANCE } from "../config/office-layout";
import * as Phaser from "phaser";
import type { OfficeFrame } from "../three/types";
import { activityLabel } from "../entities/worker/visual";
import { Player } from "../entities/Player";
import { resetWanderClock } from "../entities/Worker";
import { SPRITE_KEY, SPRITE_PATH, WORKER_SPRITES } from "../config/animations";
import { EMOTE_SHEET_KEY, EMOTE_SHEET_PATH, EMOTE_FRAME_SIZE } from "../config/emotes";
import { Pathfinder } from "../utils/Pathfinder";
import {
  buildSpriteFrames,
  parseSpawns,
  parsePOIs,
  buildCollisionRects,
  renderTileObjectLayer,
  type AnimatedProp,
} from "../utils/MapHelpers";
import { gameEvents } from "@/lib/events";
import { createLogger } from "@/lib/logger";
import {
  BOSS_INTERACT_DISTANCE,
  PRESS_E_STYLE,
  BOSS_PROMPT_OFFSET_X,
  BOSS_PROMPT_OFFSET_Y,
} from "@/lib/constants";

import { CameraController } from "../systems/CameraController";
import { WorkerManager } from "../systems/WorkerManager";
import { InteractionManager } from "../systems/InteractionManager";
import { DoorManager } from "../systems/DoorManager";
import { initSceneEventBridge } from "../systems/SceneEventBridge";

const log = createLogger("OfficeScene");

function isInputFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
}

export class OfficeScene extends Phaser.Scene {
  private player!: Player;
  private terminalZone: { x: number; y: number } | null = null;
  private promptText: Phaser.GameObjects.Text | null = null;
  private eKey!: Phaser.Input.Keyboard.Key;
  private terminalOpen = false;

  /** sessionKey -> seatId: when a character executes a task, that session binds to the character */
  private sessionBindings = new Map<string, string>();

  private cameraController!: CameraController;
  private workerManager!: WorkerManager;
  private interactionManager!: InteractionManager;
  private doorManager!: DoorManager;
  private cleanupEventBridge: (() => void) | null = null;
  private cleanupMotion: (() => void) | null = null;
  private ready = false;
  private disposed = false;

  constructor() {
    super({ key: "OfficeScene" });
  }

  init() {
    this.ready = false;
    this.disposed = false;
    this.terminalOpen = false;
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.dispose, this);
    this.events.once(Phaser.Scenes.Events.DESTROY, this.dispose, this);
  }

  preload() {
    this.load.tilemapTiledJSON("office", "/maps/office2.json");

    this.load.once("filecomplete-tilemapJSON-office", () => {
      const cached = this.cache.tilemap.get("office");
      if (!cached?.data?.tilesets) return;
      for (const ts of cached.data.tilesets) {
        const basename = (ts.image as string).split("/").pop()!;
        this.load.image(ts.name, `/tilesets/${basename}`);
      }
    });

    this.load.image(SPRITE_KEY, SPRITE_PATH);

    for (const ws of WORKER_SPRITES) {
      this.load.image(ws.key, ws.path);
    }

    this.load.spritesheet(EMOTE_SHEET_KEY, EMOTE_SHEET_PATH, {
      frameWidth: EMOTE_FRAME_SIZE,
      frameHeight: EMOTE_FRAME_SIZE,
    });

    this.load.spritesheet("boss-arrow", "/sprites/arrow_down_48x48.png", {
      frameWidth: 48,
      frameHeight: 48,
    });

    this.load.spritesheet("anim-cauldron", "/sprites/animated_witch_cauldron_48x48.png", {
      frameWidth: 96,
      frameHeight: 96,
    });

    this.load.spritesheet("anim-door", "/sprites/animated_door_big_4_48x48.png", {
      frameWidth: 48,
      frameHeight: 144,
    });
  }

  create() {
    if (this.disposed) return;
    if (!this.cache.tilemap.get("office")?.data) {
      gameEvents.emit("office-load-error", "The office map could not load. Refresh to try again.");
      return;
    }
    buildSpriteFrames(this, SPRITE_KEY);
    for (const ws of WORKER_SPRITES) {
      buildSpriteFrames(this, ws.key);
    }

    const map = this.make.tilemap({ key: "office" });

    const allTilesets: Phaser.Tilemaps.Tileset[] = [];
    for (const ts of map.tilesets) {
      const added = map.addTilesetImage(ts.name, ts.name);
      if (added) allTilesets.push(added);
    }
    if (allTilesets.length === 0) {
      log.error("No tilesets loaded");
      gameEvents.emit(
        "office-load-error",
        "The office artwork could not load. Refresh to try again.",
      );
      return;
    }

    map.createLayer("floor", allTilesets);
    map.createLayer("walls", allTilesets);
    map.createLayer("ground", allTilesets);
    map.createLayer("furniture", allTilesets);
    map.createLayer("objects", allTilesets);

    const animatedProps: AnimatedProp[] = [
      {
        tilesetName: "11_Halloween_48x48",
        anchorLocalId: 130,
        skipLocalIds: new Set([130, 131, 146, 147]),
        spriteKey: "anim-cauldron",
        frameWidth: 96,
        frameHeight: 96,
        endFrame: 11,
        frameRate: 8,
      },
    ];
    renderTileObjectLayer(this, map, "props", allTilesets, 5, animatedProps);
    renderTileObjectLayer(this, map, "props-over", allTilesets, 11);

    const overheadLayer = map.createLayer("overhead", allTilesets);
    if (overheadLayer) overheadLayer.setDepth(10);

    const collisionGroup = this.physics.add.staticGroup();
    const collisionRects = buildCollisionRects(map, collisionGroup);

    const pathfinder = new Pathfinder(
      map.widthInPixels,
      map.heightInPixels,
      collisionRects,
      NAV_CLEARANCE,
    );

    const { bossSpawn, workerSpawns } = parseSpawns(map);
    const pois = [...parsePOIs(map), ...AMBIENT_POIS];

    this.player = new Player(this, bossSpawn.x, bossSpawn.y, bossSpawn.facing);
    this.physics.add.collider(this.player.sprite, collisionGroup);

    this.physics.world.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.player.sprite.setCollideWorldBounds(true);

    this.input.keyboard?.disableGlobalCapture();

    // ── Systems ───────────────────────────────────────────
    this.cameraController = new CameraController(
      this,
      this.player.sprite,
      map.widthInPixels,
      map.heightInPixels,
    );
    this.cameraController.init();

    this.workerManager = new WorkerManager(this, workerSpawns, pois, pathfinder, collisionGroup);

    this.interactionManager = new InteractionManager(
      this,
      this.player,
      this.workerManager,
      this.cameraController,
    );
    this.interactionManager.initInteractionUI();

    this.doorManager = new DoorManager(this, this.player, () => this.workerManager.workers);
    this.doorManager.initDoors();

    resetWanderClock();
    this.initBossSeat(bossSpawn);

    this.cleanupEventBridge = initSceneEventBridge(
      this.workerManager,
      this.interactionManager,
      this.sessionBindings,
      (open) => {
        this.terminalOpen = open;
      },
    );

    gameEvents.emit("seats-discovered", workerSpawns);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const applyMotion = () => {
      for (const worker of this.workerManager.workers) worker.reducedMotion = motion.matches;
    };
    const offSeats = gameEvents.on("seat-configs-updated", applyMotion);
    applyMotion();
    motion.addEventListener("change", applyMotion);
    this.cleanupMotion = () => {
      offSeats();
      motion.removeEventListener("change", applyMotion);
    };
    this.ready = true;
  }

  /** Read-only adapter: Three.js never mutates task state, navigation or actor positions. */
  readOfficeFrame(): OfficeFrame | null {
    if (!this.ready) return null;
    return {
      seats: this.workerManager.seatDefs,
      doors: this.doorManager.presentation,
      actors: this.workerManager.workers.map((worker) => ({
        id: worker.seatId,
        label: worker.label,
        spriteKey: worker.spriteKey,
        x: worker.sprite.x,
        y: worker.sprite.y + 33.6,
        facing: worker.facing,
        moving: !!worker.moveTarget && (worker.sprite.body as Phaser.Physics.Arcade.Body).speed > 1,
        atDesk: worker.isAtHomePose(),
        status: worker.status,
        voice: worker.voice,
        connection: worker.connection,
        activity: activityLabel({
          status: worker.status,
          moving: !!worker.moveTarget,
          blocked: worker.navigationBlocked,
          connection: worker.connection,
          voice: worker.voice,
          role: worker.role,
          ambient: worker.routine.activity,
        }),
        ambient: worker.routine.activity,
        bubble: worker.bubble.displayText,
      })),
      player: {
        x: this.player.sprite.x,
        y: this.player.sprite.y + 33.6,
        moving: this.player.isMoving(),
        facing: this.player.facing,
      },
      prompt: this.interactionManager.workerPromptText?.visible
        ? `E · Talk to ${this.interactionManager.nearestWorker?.label ?? "worker"}`
        : this.promptText?.visible
          ? "E · Open your terminal"
          : "",
      menu: this.interactionManager.interactionMenu.presentation,
    };
  }

  chooseOfficeMenu(index: number) {
    if (!this.ready) return;
    this.interactionManager.interactionMenu.choose(index);
  }

  // ── Boss seat ──────────────────────────────────────────

  private initBossSeat(bossSpawn: { x: number; y: number }) {
    this.terminalZone = { x: bossSpawn.x, y: bossSpawn.y };

    this.promptText = this.add
      .text(
        bossSpawn.x + BOSS_PROMPT_OFFSET_X,
        bossSpawn.y - BOSS_PROMPT_OFFSET_Y,
        "Press E",
        PRESS_E_STYLE as Phaser.Types.GameObjects.Text.TextStyle,
      )
      .setResolution(window.devicePixelRatio * 2)
      .setOrigin(0, 0)
      .setDepth(20)
      .setVisible(false);
    this.promptText.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);

    const kb = this.input.keyboard;
    if (!kb) return;
    this.eKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E, false);
  }

  // ── Cleanup ────────────────────────────────────────────

  /** Disconnect React/document listeners before Phaser destroys physics and scene plugins. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.events.off(Phaser.Scenes.Events.SHUTDOWN, this.dispose, this);
    this.events.off(Phaser.Scenes.Events.DESTROY, this.dispose, this);
    this.cleanupEventBridge?.();
    this.cleanupEventBridge = null;
    this.cleanupMotion?.();
    this.cleanupMotion = null;
    this.sessionBindings.clear();
    this.workerManager?.destroyAll();
    this.interactionManager?.destroy();
  }

  // ── Update ─────────────────────────────────────────────

  update() {
    if (!this.ready) return;
    if (this.interactionManager.interactionMenu.visible) {
      this.interactionManager.interactionMenu.update();
      this.workerManager.updateAll();
      return;
    }

    if (this.terminalOpen || isInputFocused()) {
      this.workerManager.updateAll();
      this.doorManager.updateDoors();
      return;
    }

    this.player.update();
    if (!this.cameraController.cameraFollowing && this.player.isMoving()) {
      this.cameraController.resumeCameraFollow();
    }
    this.workerManager.updateAll();
    this.doorManager.updateDoors();

    // Worker proximity + E-key interaction
    if (this.interactionManager.updateProximity(this.eKey)) {
      return;
    }

    // Boss terminal interaction (only when no worker is nearby)
    if (!this.interactionManager.nearestWorker && this.terminalZone && this.promptText) {
      const dist = Phaser.Math.Distance.Between(
        this.player.sprite.x,
        this.player.sprite.y,
        this.terminalZone.x,
        this.terminalZone.y,
      );
      const near = dist < BOSS_INTERACT_DISTANCE;
      this.promptText.setVisible(near);

      if (near && Phaser.Input.Keyboard.JustDown(this.eKey)) {
        this.terminalOpen = true;
        this.promptText.setVisible(false);
        gameEvents.emit("open-terminal");
      }
    } else if (this.promptText) {
      this.promptText.setVisible(false);
    }
  }
}
