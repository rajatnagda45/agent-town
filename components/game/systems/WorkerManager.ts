import { navPoint } from "../entities/worker/movement";
import { gameEvents } from "@/lib/events";
import { activityNames } from "./AmbientRoutine";
import * as Phaser from "phaser";
import { Worker, type POI } from "../entities/Worker";
import type { Direction } from "../config/animations";
import type { Pathfinder } from "../utils/Pathfinder";
import type { SeatDef } from "../utils/MapHelpers";
import type { SeatState } from "@/types/game";

export class WorkerManager {
  private scene: Phaser.Scene;
  private pois: POI[];
  private pathfinder: Pathfinder;
  private activitySignature = "";
  private retryAt = new Map<string, number>();
  private reservations = new Set<POI>();

  workers: Worker[] = [];
  runWorkerMap = new Map<string, Worker>();
  seatDefs: SeatDef[] = [];

  constructor(
    scene: Phaser.Scene,
    seatDefs: SeatDef[],
    pois: POI[],
    pathfinder: Pathfinder,
    private obstacles?: Phaser.Physics.Arcade.StaticGroup,
  ) {
    this.scene = scene;
    this.seatDefs = seatDefs;
    this.pois = pois;
    this.pathfinder = pathfinder;
  }

  spawnWorker(seatDef: SeatDef, seat: SeatState): Worker | null {
    if (!seat.spriteKey) return null;
    const initialFacing: Direction = seatDef.facing;
    const worker = new Worker(
      this.scene,
      seatDef.x,
      seatDef.y,
      seat.spriteKey,
      seatDef.seatId,
      seat.label,
      initialFacing,
    );
    worker.reservations = this.reservations;
    worker.role = seat.roleTitle ?? "Worker";
    worker.runtimeBusy = seat.status === "running" || seat.status === "returning";
    worker.setPOIs(this.pois);
    worker.setPathfinder(this.pathfinder);
    worker.sprite.setCollideWorldBounds(true);
    if (this.obstacles) {
      const collider = this.scene.physics.add.collider(worker.sprite, this.obstacles);
      worker.sprite.once("destroy", () => collider.destroy());
    }
    return worker;
  }

  syncWorkers(seats: SeatState[], clearNearest: (worker: Worker) => void) {
    const nextBySeatId = new Map(
      seats.filter((seat) => seat.assigned && seat.spriteKey).map((seat) => [seat.seatId, seat]),
    );
    const existingBySeatId = new Map(this.workers.map((worker) => [worker.seatId, worker]));
    const nextWorkers: Worker[] = [];

    for (const seatDef of this.seatDefs) {
      const seat = nextBySeatId.get(seatDef.seatId);
      const existing = existingBySeatId.get(seatDef.seatId);

      if (!seat) {
        if (existing) {
          this.cleanupWorkerRunIds(existing);
          clearNearest(existing);
          existing.destroy();
          existingBySeatId.delete(seatDef.seatId);
        }
        continue;
      }

      if (!existing) {
        const created = this.spawnWorker(seatDef, seat);
        if (created) nextWorkers.push(created);
        continue;
      }

      existing.updateAppearance(seat.label, seat.spriteKey!);
      existing.role = seat.roleTitle ?? "Worker";
      existing.runtimeBusy = seat.status === "running" || seat.status === "returning";
      nextWorkers.push(existing);
      existingBySeatId.delete(seatDef.seatId);
    }

    for (const stale of existingBySeatId.values()) {
      this.cleanupWorkerRunIds(stale);
      clearNearest(stale);
      stale.destroy();
    }

    this.workers = nextWorkers;
  }

  cleanupWorkerRunIds(worker: Worker) {
    if (worker.assignedRunId) this.runWorkerMap.delete(worker.assignedRunId);
    for (const task of worker.taskQueue) {
      this.runWorkerMap.delete(task.runId);
    }
  }

  findBySeatId(seatId?: string): Worker | null {
    if (!seatId) return null;
    return this.workers.find((worker) => worker.seatId === seatId) ?? null;
  }

  findIdle(): Worker | null {
    return this.workers.find((worker) => worker.status === "idle" && !worker.runtimeBusy) ?? null;
  }

  updateAll() {
    // Reserve a short look-ahead footprint. Stable seat order resolves competing moves.
    const claims: Array<{ x: number; y: number }> = [];
    for (const worker of this.workers) {
      worker.trafficBlocked = false;
      const body = worker.sprite.body as Phaser.Physics.Arcade.Body;
      const center = navPoint(worker);
      if (worker.moveTarget) {
        const dx = worker.moveTarget.x - center.x;
        const dy = worker.moveTarget.y - center.y;
        const distance = Math.hypot(dx, dy);
        const step = Math.min(12, distance);
        const point = {
          x: center.x + (dx / (distance || 1)) * step,
          y: center.y + (dy / (distance || 1)) * step,
        };
        worker.trafficBlocked =
          this.workers.some((other) => {
            if (other === worker) return false;
            const otherBody = other.sprite.body as Phaser.Physics.Arcade.Body;
            const otherCenter = navPoint(other);
            return (
              Math.abs(point.x - otherCenter.x) < body.halfWidth + otherBody.halfWidth &&
              Math.abs(point.y - otherCenter.y) < body.halfHeight + otherBody.halfHeight
            );
          }) ||
          claims.some(
            (p) => Math.abs(point.x - p.x) < body.width && Math.abs(point.y - p.y) < body.height,
          );
        if (!worker.trafficBlocked) claims.push(point);
      }
      if (
        worker.trafficBlocked &&
        worker.moveTarget &&
        this.scene.time.now > (this.retryAt.get(worker.seatId) ?? 0)
      ) {
        this.retryAt.set(worker.seatId, this.scene.time.now + 3000);
        const goal = worker.currentPath.at(-1);
        const obstacles = this.workers
          .filter((w) => w !== worker)
          .map((w) => {
            const b = w.sprite.body as Phaser.Physics.Arcade.Body;
            return { x: b.x, y: b.y, width: b.width, height: b.height };
          });
        const route =
          goal && this.pathfinder.avoiding(obstacles).findPath(center.x, center.y, goal.x, goal.y);
        if (route && route.length > 1) {
          worker.currentPath = route;
          worker.pathIndex = 1;
          worker.moveTarget = route[1];
        }
      }
      worker.update();
    }
    this.publishActivities();
  }

  publishActivities(force = false) {
    const rows = this.workers.map((w) => ({
      seatId: w.seatId,
      activity: activityNames[w.routine.activity],
      location: w.isAtHomePose() ? "Assigned workstation" : (w.reservedPOI?.name ?? "Office floor"),
    }));
    const signature = JSON.stringify(rows);
    if (force || signature !== this.activitySignature) {
      this.activitySignature = signature;
      gameEvents.emit("office-activities", rows);
    }
  }

  destroyAll() {
    for (const worker of this.workers) worker.destroy();
    this.workers = [];
    this.runWorkerMap.clear();
  }
}
