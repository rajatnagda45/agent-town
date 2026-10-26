import * as Phaser from "phaser";
import { FRAME_WIDTH, FRAME_HEIGHT, MOVE_SPEED } from "../../config/animations";
import {
  WORKER_SPEED_FACTOR,
  STUCK_FRAME_LIMIT,
  STUCK_MOVE_THRESHOLD,
  BODY_SIZE_RATIO_W,
  BODY_SIZE_RATIO_H,
  BODY_OFFSET_RATIO_X,
  BODY_OFFSET_RATIO_Y,
} from "@/lib/constants";
import type { WorkerCtx } from "./types";

const WORKER_SPEED = MOVE_SPEED * WORKER_SPEED_FACTOR;
export const BODY_WIDTH = FRAME_WIDTH * BODY_SIZE_RATIO_W;
export const BODY_HEIGHT = FRAME_HEIGHT * BODY_SIZE_RATIO_H;
export const BODY_OFFSET_X = FRAME_WIDTH * BODY_OFFSET_RATIO_X;
export const BODY_OFFSET_Y = FRAME_HEIGHT * BODY_OFFSET_RATIO_Y;
const HOME_NAV_OFFSET_X = BODY_OFFSET_X + BODY_WIDTH / 2 - FRAME_WIDTH / 2;
const HOME_NAV_OFFSET_Y = BODY_OFFSET_Y + BODY_HEIGHT / 2 - FRAME_HEIGHT / 2;

export function navPoint(ctx: WorkerCtx) {
  const body = ctx.sprite.body as Phaser.Physics.Arcade.Body;
  return {
    x: body.center.x + (body.width ? body.width / 2 - body.halfWidth : 0),
    y: body.center.y + (body.height ? body.height / 2 - body.halfHeight : 0),
  };
}

export function homeNavPoint(ctx: WorkerCtx) {
  return {
    x: ctx.homeX + HOME_NAV_OFFSET_X,
    y: ctx.homeY + HOME_NAV_OFFSET_Y,
  };
}

export function isAtHomePose(ctx: WorkerCtx) {
  return Phaser.Math.Distance.Between(ctx.sprite.x, ctx.sprite.y, ctx.homeX, ctx.homeY) <= 2;
}

export function faceToward(ctx: WorkerCtx, tx: number, ty: number) {
  const nav = navPoint(ctx);
  const dx = tx - nav.x;
  const dy = ty - nav.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    ctx.facing = dx > 0 ? "right" : "left";
  } else {
    ctx.facing = dy > 0 ? "down" : "up";
  }
}

export function resetToHomePose(ctx: WorkerCtx) {
  const body = ctx.sprite.body as Phaser.Physics.Arcade.Body;
  ctx.sprite.setPosition(ctx.homeX, ctx.homeY);
  body.reset(ctx.homeX, ctx.homeY);
  ctx.facing = ctx.initialFacing;
}

function arriveAndStop(ctx: WorkerCtx) {
  const body = ctx.sprite.body as Phaser.Physics.Arcade.Body;
  body.setVelocity(0, 0);
  ctx.moveTarget = null;
  ctx.currentPath = [];
  ctx.pathIndex = 0;
  const returningHome = ctx.isReturningHome;
  ctx.isReturningHome = false;
  ctx.stuckFrames = 0;

  if (returningHome) {
    if (isAtHomePose(ctx)) resetToHomePose(ctx);
    ctx.facing = ctx.initialFacing;
    ctx.faceTarget = null;
    ctx.arrivalFacing = null;
  } else if (ctx.arrivalFacing) {
    ctx.facing = ctx.arrivalFacing;
    ctx.arrivalFacing = null;
    ctx.faceTarget = null;
  } else if (ctx.faceTarget) {
    faceToward(ctx, ctx.faceTarget.x, ctx.faceTarget.y);
    ctx.faceTarget = null;
  }

  const idleKey = `${ctx.spriteKey}:idle-${ctx.facing}`;
  if (ctx.sprite.anims.currentAnim?.key !== idleKey) {
    ctx.sprite.anims.play(idleKey);
  }

  if (ctx.onArrival) {
    const cb = ctx.onArrival;
    ctx.onArrival = null;
    cb();
  }
}

export function updateMovement(ctx: WorkerCtx) {
  if (!ctx.moveTarget) return;

  const nav = navPoint(ctx);
  const dx = ctx.moveTarget.x - nav.x;
  const dy = ctx.moveTarget.y - nav.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 0.8) {
    if (ctx.currentPath.length > 0 && ctx.pathIndex < ctx.currentPath.length - 1) {
      ctx.pathIndex++;
      ctx.moveTarget = ctx.currentPath[ctx.pathIndex];
      ctx.stuckFrames = 0;
      return;
    }
    arriveAndStop(ctx);
    return;
  }

  const movedX = Math.abs(nav.x - ctx.lastX);
  const movedY = Math.abs(nav.y - ctx.lastY);
  if (movedX < STUCK_MOVE_THRESHOLD && movedY < STUCK_MOVE_THRESHOLD) {
    ctx.stuckFrames++;
  } else {
    ctx.stuckFrames = 0;
  }
  ctx.lastX = nav.x;
  ctx.lastY = nav.y;

  if (ctx.stuckFrames > STUCK_FRAME_LIMIT) {
    stopBlocked(ctx, "stuck");
    return;
  }

  const speed = Math.min(WORKER_SPEED, dist * 30);
  const vx = (dx / dist) * speed;
  const vy = (dy / dist) * speed;
  (ctx.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(vx, vy);

  faceToward(ctx, ctx.moveTarget.x, ctx.moveTarget.y);

  const walkKey = `${ctx.spriteKey}:walk-${ctx.facing}`;
  if (ctx.sprite.anims.currentAnim?.key !== walkKey) {
    ctx.sprite.anims.play(walkKey);
  }
}

export function navigateTo(
  ctx: WorkerCtx,
  x: number,
  y: number,
  facePoi?: { x: number; y: number },
) {
  ctx.navigationBlocked = false;
  ctx.faceTarget = facePoi ?? null;
  if (ctx.pathfinder) {
    const start = navPoint(ctx);
    const path = ctx.pathfinder.findPath(start.x, start.y, x, y);
    if (path && path.length > 1) {
      ctx.currentPath = path;
      ctx.pathIndex = 1;
      ctx.moveTarget = ctx.currentPath[1];
      return;
    }
  }
  stopBlocked(ctx);
}

export function navigateHome(ctx: WorkerCtx) {
  ctx.navigationBlocked = false;
  ctx.isReturningHome = true;
  if (isAtHomePose(ctx)) {
    arriveAndStop(ctx);
    return;
  }
  ctx.faceTarget = null;
  ctx.arrivalFacing = null;
  const home = homeNavPoint(ctx);
  if (ctx.pathfinder) {
    const start = navPoint(ctx);
    const path = ctx.pathfinder.findPath(start.x, start.y, home.x, home.y);
    if (path && path.length > 1) {
      // Keep the safe endpoint chosen by A*. Never append a route through furniture.
      ctx.currentPath = path;
      ctx.pathIndex = 1;
      ctx.moveTarget = ctx.currentPath[1];
      return;
    }
  }
  ctx.currentPath = [];
  ctx.pathIndex = 0;
  stopBlocked(ctx);
}

/** A failed route is not an arrival. Work can proceed in place without teleporting. */
export function stopBlocked(ctx: WorkerCtx, reason = "route") {
  const ready = ctx._status === "working" ? ctx.onArrival : null;
  ctx.stopIdleActivity();
  ctx.navigationBlocked = reason !== "traffic";
  if (process.env.NODE_ENV === "development")
    console.debug(
      reason === "traffic"
        ? "Office traffic yield; activity deferred"
        : "Office route unavailable; activity released",
      JSON.stringify({
        reason,
        x: ctx.sprite.x,
        y: ctx.sprite.y,
        nav: navPoint(ctx),
        target: ctx.moveTarget,
        goal: ctx.currentPath.at(-1),
      }),
    );
  ctx.moveTarget = null;
  ctx.currentPath = [];
  ctx.isReturningHome = false;
  ctx.arrivalFacing = null;
  (ctx.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
  ctx.sprite.anims.play(`${ctx.spriteKey}:idle-${ctx.facing}`);
  if (ready) ready();
  if (ctx._status === "idle") ctx.scheduleWander();
}
