import type { Direction } from "../config/animations";
import type { WorkerStatus } from "../entities/worker/types";
import type { VoiceStatus } from "@/lib/voice/client";
import type { ConnectionStatus } from "@/types/game";
import type { SeatDef } from "../utils/MapHelpers";

export interface OfficeActor {
  id: string;
  label: string;
  spriteKey: string;
  x: number;
  y: number;
  facing: Direction;
  moving: boolean;
  atDesk: boolean;
  status: WorkerStatus;
  voice: VoiceStatus;
  connection: ConnectionStatus;
  activity: string;
  ambient?: import("../systems/AmbientRoutine").OfficeActivity;
  bubble: string;
}
export interface OfficeFrame {
  actors: OfficeActor[];
  seats: SeatDef[];
  doors: Array<{ x: number; y: number; open: boolean }>;
  player: { x: number; y: number; moving: boolean; facing: Direction };
  prompt: string;
  menu: { visible: boolean; selected: number; options: { label: string; enabled: boolean }[] };
}
export interface OfficeSource {
  read(): OfficeFrame | null;
  inspect(seatId: string): void;
  chooseMenu(index: number): void;
}
export const WORLD_SCALE = 48;
export const WORLD_CENTER = { x: 680, y: 500 };
export function worldPosition(x: number, y: number) {
  return { x: (x - WORLD_CENTER.x) / WORLD_SCALE, z: (y - WORLD_CENTER.y) / WORLD_SCALE };
}
export const facingAngle: Record<Direction, number> = {
  down: 0,
  right: Math.PI / 2,
  up: Math.PI,
  left: -Math.PI / 2,
};
export function shortestAngle(current: number, target: number) {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}
