import type { WorkerCtx } from "./types";
import { navPoint, isAtHomePose } from "./movement";
import { activityNames } from "../../systems/AmbientRoutine";

export function resetWanderClock() {
  /* Each worker now owns a reproducible schedule. */
}
export function stopIdleActivity(ctx: WorkerCtx) {
  ctx.wanderTimer?.destroy();
  ctx.wanderTimer = null;
  ctx.activityTimer?.destroy();
  ctx.activityTimer = null;
  if (ctx.reservedPOI) ctx.reservations.delete(ctx.reservedPOI);
  ctx.reservedPOI = null;
  ctx.onArrival = null;
  ctx.isWandering = false;
  ctx.interactionLocked = false;
  ctx.routine?.reset(ctx.scene.time.now, "off");
  ctx.hideEmote();
  ctx.bubble.hide();
}
export function scheduleWander(ctx: WorkerCtx) {
  stopIdleActivity(ctx);
  if (ctx.canWander && ctx.ambientAllowed && ctx._status === "idle")
    ctx.routine.reset(ctx.scene.time.now, ctx.ambientIntensity);
}
/** Runs on the scene clock, which pauses when the document is hidden. */
export function updateAmbient(ctx: WorkerCtx) {
  if (
    !ctx.canWander ||
    !ctx.ambientAllowed ||
    ctx._status !== "idle" ||
    ctx.interactionLocked ||
    ctx.ambientIntensity === "off"
  )
    return;
  const now = ctx.scene.time.now,
    routine = ctx.routine;
  if (ctx.moveTarget) return;
  if (now >= routine.until) {
    routine.until = Infinity;
    if (!isAtHomePose(ctx)) {
      routine.activity = "returning_to_desk";
      ctx.onArrival = () => scheduleWander(ctx);
      ctx.navigateHome();
    } else scheduleWander(ctx);
    return;
  }
  if (now < routine.nextAt) return;
  const nav = navPoint(ctx);
  const wantsTrip =
    routine.random() < (ctx.ambientIntensity === "calm" ? 0.35 : 0.55) * routine.tripBias;
  if (wantsTrip) {
    const candidates = ctx.pois.filter(
      (p) =>
        p !== ctx.lastPOI &&
        !ctx.reservations.has(p) &&
        now - (routine.visits.get(p.name) ?? -Infinity) > 90000,
    );
    // Deterministic shuffle prevents every worker preferring the first location.
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(routine.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const poi of candidates) {
      const route = ctx.pathfinder?.findPath(nav.x, nav.y, poi.x, poi.y);
      routine.visits.set(poi.name, now);
      if (!route || route.length < 2) continue;
      const end = route.at(-1)!;
      // Different props can resolve to the same standing position.
      if ([...ctx.reservations].some((p) => Math.hypot(p.x - end.x, p.y - end.y) < 36)) continue;
      ctx.reservations.add(poi);
      ctx.reservedPOI = poi;
      ctx.lastPOI = poi;
      ctx.isWandering = true;
      ctx.arrivalFacing = poi.facing;
      routine.activity = "walking";
      routine.nextAt = Infinity;
      ctx.onArrival = () => {
        if (ctx._status !== "idle" || !ctx.ambientAllowed) return;
        routine.begin(routine.destinationActivity(poi.name), ctx.scene.time.now);
        ctx.showBubble(activityNames[routine.activity], 2600);
      };
      ctx.navigateTo(end.x, end.y, { x: poi.x, y: poi.y });
      return;
    }
  }
  if (!isAtHomePose(ctx)) {
    routine.activity = "returning_to_desk";
    routine.nextAt = Infinity;
    ctx.onArrival = () => scheduleWander(ctx);
    ctx.navigateHome();
  } else routine.begin(routine.deskActivity(), now);
}
