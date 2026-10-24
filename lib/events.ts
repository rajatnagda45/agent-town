import type { SeatState } from "@/types/game";
import type { SeatDef } from "@/components/game/utils/MapHelpers";
import { createLogger } from "./logger";

const log = createLogger("GameEventBus");

export interface GameEventMap {
  "office-load-error": [message: string];
  "office-activities-request": [];
  "office-settings": [
    intensity: import("@/components/game/systems/AmbientRoutine").AmbientIntensity,
  ];
  "office-activities": [rows: Array<{ seatId: string; activity: string; location: string }>];
  "office-inspect": [seatId: string];
  "office-focus": [seatId: string];
  "office-runtime-request": [];
  "office-runtime": [
    connection: import("@/types/game").ConnectionStatus,
    voiceSeatId: string | undefined,
    voice: import("@/lib/voice/client").VoiceStatus,
  ];
  "seats-discovered": [seats: SeatDef[]];
  "seat-configs-updated": [seats: SeatState[]];
  "task-assigned": [taskId: string, message: string, seatId?: string, sessionKey?: string];
  "task-routed": [taskId: string, seatId: string, actorName: string];
  "task-ready": [taskId: string, message: string, seatId?: string];
  "task-bound": [taskId: string, runId: string];
  "task-staged": [taskId: string, stage: "queued" | "returning", seatId?: string];
  "task-bubble": [runId: string, text: string, ttl: number];
  "task-aborted": [runId: string];
  "task-completed": [runId: string];
  "task-failed": [runId: string];
  "subagent-assigned": [runId: string, parentRunId: string, label: string, seatId?: string];
  "open-terminal": [seatId?: string];
  "open-voice": [seatId: string];
  "open-review": [id?: string];
  "open-terminal-queue": [seatId: string];
  "stop-task": [runId: string, seatId: string];
  "terminal-closed": [];
  "new-session-for-seat": [seatId: string];
  "open-session-history": [seatId: string];
  "scope-denied": [];
  "gateway-disconnected": [taskIds: string[]];
}

type Listener<T extends unknown[]> = (...args: T) => void;

class GameEventBus {
  private listeners = new Map<string, Set<Listener<unknown[]>>>();

  on<K extends keyof GameEventMap>(event: K, fn: Listener<GameEventMap[K]>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn as Listener<unknown[]>);
    return () => this.off(event, fn);
  }

  off<K extends keyof GameEventMap>(event: K, fn: Listener<GameEventMap[K]>) {
    this.listeners.get(event)?.delete(fn as Listener<unknown[]>);
  }

  emit<K extends keyof GameEventMap>(event: K, ...args: GameEventMap[K]) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (err) {
        log.error(`listener error on "${event}":`, err);
      }
    });
  }
}

export const gameEvents = new GameEventBus();
