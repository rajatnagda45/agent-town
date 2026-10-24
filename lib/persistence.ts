/**
 * localStorage persistence helpers.
 *
 * Centralizes all read/write operations so the store
 * doesn't need to know about serialization details.
 */

import type {
  TaskItem,
  ChatMessage,
  GatewayConfig,
  SessionRecord,
  SeatType,
  AgentConfig,
} from "@/types/game";
import { createLogger } from "./logger";
import {
  LS_CONFIG,
  LS_TASKS,
  LS_CHAT,
  LS_SESSIONS,
  LS_ACTIVE_KEY,
  LS_SEAT_CONFIG,
  LS_SEAT_SESSION_BINDINGS,
  LS_BGM_VOLUME,
  LS_ONBOARDING_DONE,
  LS_DEVICE_ID,
  DEFAULT_BGM_VOLUME,
  MAX_SESSIONS,
} from "./constants";

const log = createLogger("Persistence");

export interface PersistedSeatConfig {
  seatId: string;
  label?: string;
  seatType?: SeatType;
  roleTitle?: string;
  assigned?: boolean;
  spriteKey?: string;
  spritePath?: string;
  agentConfig?: AgentConfig;
}

// ── Generic helpers ────────────────────────────────────

export function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    log.warn(`failed to write "${key}":`, err);
  }
}

// ── Domain-specific loaders ────────────────────────────

export function loadGatewayConfig(): GatewayConfig | null {
  const stored = lsGet<(GatewayConfig & { token?: string }) | null>(LS_CONFIG, null);
  if (!stored?.url) return null;
  // Deliberately drop legacy browser-stored gateway credentials.
  return { url: stored.url, provider: stored.provider };
}

export function saveGatewayConfig(config: GatewayConfig) {
  lsSet(LS_CONFIG, { url: config.url, provider: config.provider });
}

export function loadActiveSessionKey(): string | null {
  return lsGet<string | null>(LS_ACTIVE_KEY, null);
}

export function saveActiveSessionKey(key: string | undefined) {
  lsSet(LS_ACTIVE_KEY, key ?? null);
}

export function loadTasks(fallbackSessionKey: string): TaskItem[] {
  return lsGet<TaskItem[]>(LS_TASKS, []).map((task) => ({
    ...task,
    sessionKey: task.sessionKey ?? fallbackSessionKey,
  }));
}

export function saveTasks(tasks: TaskItem[]) {
  lsSet(LS_TASKS, tasks.slice(0, 200));
}

export function loadChat(fallbackSessionKey: string): ChatMessage[] {
  return lsGet<ChatMessage[]>(LS_CHAT, []).map((msg) => ({
    ...msg,
    sessionKey: msg.sessionKey ?? fallbackSessionKey,
  }));
}

export function saveChat(messages: ChatMessage[]) {
  // Audio is never recorded. Only finalized transcript text joins saved chat history.
  lsSet(
    LS_CHAT,
    messages
      .filter(
        (message) => message.source !== "voice" || !("streaming" in message && message.streaming),
      )
      .slice(-400),
  );
}

export function loadSessions(): SessionRecord[] {
  return lsGet<SessionRecord[]>(LS_SESSIONS, []);
}

export function saveSessions(sessions: SessionRecord[]) {
  lsSet(LS_SESSIONS, sessions.slice(0, MAX_SESSIONS));
}

export function loadSeatConfigs(): PersistedSeatConfig[] {
  return lsGet<PersistedSeatConfig[]>(LS_SEAT_CONFIG, []);
}

export function saveSeatConfigs(configs: PersistedSeatConfig[]) {
  lsSet(LS_SEAT_CONFIG, configs);
}

export function loadSeatSessionBindings(): Map<string, string> {
  const stored = lsGet<Record<string, unknown>>(LS_SEAT_SESSION_BINDINGS, {});
  const entries = Object.entries(stored)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 &&
        entry[0].length <= 256 &&
        typeof entry[1] === "string" &&
        entry[1].length > 0 &&
        entry[1].length <= 256,
    )
    .slice(0, 64);
  return new Map(entries);
}

export function saveSeatSessionBindings(bindings: Map<string, string>) {
  lsSet(LS_SEAT_SESSION_BINDINGS, Object.fromEntries([...bindings.entries()].slice(0, 64)));
}

export function loadBgmVolume(): number {
  return lsGet<number>(LS_BGM_VOLUME, DEFAULT_BGM_VOLUME);
}

export function saveBgmVolume(volume: number) {
  lsSet(LS_BGM_VOLUME, volume);
}

export function loadOnboardingDone(): boolean {
  return lsGet<boolean>(LS_ONBOARDING_DONE, false);
}

export function saveOnboardingDone() {
  lsSet(LS_ONBOARDING_DONE, true);
}

/** Returns a stable per-browser device ID, generating one on first call. */
export function loadDeviceId(): string {
  const existing = lsGet<string | null>(LS_DEVICE_ID, null);
  if (existing) return existing;
  const id = `aw-${crypto.randomUUID()}`;
  lsSet(LS_DEVICE_ID, id);
  return id;
}
