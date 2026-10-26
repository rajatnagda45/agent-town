import type { SeatDef } from "../utils/MapHelpers";
export const NAV_CLEARANCE = { x: 13, y: 10.6 };
export type Rect = { x: number; y: number; width: number; height: number };
export const DESK = {
  width: 1.75 * 1.35 * 48,
  depth: 0.85 * 48,
  offset: 0.72 * 48,
  feetOffset: 33.6,
};
export const PLANTS = [
  [158, 270, 1.2],
  [171, 550, 1.3],
  [651, 219, 0.95],
  [743, 550, 1.15],
  [1217, 210, 1.1],
  [1219, 553, 1.15],
  [1040, 375, 0.95],
  [246, 848, 1],
  [742, 850, 1.1],
  [827, 697, 0.8],
  [1140, 866, 0.85],
  [402, 628, 0.7],
  [713, 630, 0.75],
  [830, 125, 0.65],
];
export const DIVIDERS: Rect[] = [
  { x: 188, y: 418, width: 436, height: 4 },
  ...[190, 336, 480, 623].map((x) => ({ x: x - 2, y: 366, width: 4, height: 108 })),
];
export const SOFA = { x: 289, y: 690, width: 1.6 * 48, height: 0.83 * 48 };
export const WINDOWS = [
  { x: 122, y: 285, width: 100, facing: "left" as const, observation: { x: 168, y: 335 } },
  { x: 1259, y: 420, width: 100, facing: "right" as const, observation: { x: 1210, y: 465 } },
];
export const AMBIENT_POIS = [
  ...WINDOWS.map((w, i) => ({ name: `Window ${i + 1}`, ...w.observation, facing: w.facing })),
  { name: "Coffee station", x: 360, y: 754, facing: "left" as const },
  { name: "Meeting area", x: 947, y: 537, facing: "up" as const },
  { name: "Meeting area north", x: 947, y: 490, facing: "down" as const },
];
export function deskFootprint(seat: SeatDef): Rect {
  const horizontal = seat.facing === "left" || seat.facing === "right";
  const x =
    seat.x + (seat.facing === "right" ? DESK.offset : seat.facing === "left" ? -DESK.offset : 0);
  const y =
    seat.y +
    DESK.feetOffset +
    (seat.facing === "down" ? DESK.offset : seat.facing === "up" ? -DESK.offset : 0);
  const width = horizontal ? DESK.depth : DESK.width;
  const height = horizontal ? DESK.width : DESK.depth;
  return { x: x - width / 2, y: y - height / 2, width, height };
}
/** Replace the legacy painted desk cluster (which included occupied chairs) with solid desktops. */
export function officeCollisions(rects: Rect[], seats: SeatDef[]): Rect[] {
  return [
    ...rects.filter(
      (r) =>
        !(Math.abs(r.x - 187.688) < 1 && r.width > 430) &&
        !(Math.abs(r.x - 431.601) < 1 && Math.abs(r.y - 650.019) < 1),
    ),
    ...seats.map(deskFootprint),
    ...DIVIDERS,
    ...PLANTS.map(([x, y, scale]) => ({
      x: x - 11 * scale,
      y: y - 11 * scale,
      width: 22 * scale,
      height: 22 * scale,
    })),
    {
      x: SOFA.x - SOFA.width / 2,
      y: SOFA.y - SOFA.height / 2,
      width: SOFA.width,
      height: SOFA.height,
    },
    ...WINDOWS.map((w) => ({ x: w.x, y: w.y, width: 9, height: w.width })),
  ];
}
