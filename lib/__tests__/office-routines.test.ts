import { describe, expect, it } from "vitest";
import map from "../../public/maps/office2.json";
import { Pathfinder } from "@/components/game/utils/Pathfinder";
import {
  officeCollisions,
  AMBIENT_POIS,
  NAV_CLEARANCE,
} from "@/components/game/config/office-layout";
import { AmbientRoutine } from "@/components/game/systems/AmbientRoutine";
import type { SeatDef } from "@/components/game/utils/MapHelpers";
const objects = (name: string) =>
  map.layers.find((l) => l.name === name)!.objects! as Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    name: string;
    properties?: Array<{ name: string; value: string }>;
  }>;
const seats = objects("spawns")
  .slice(1)
  .map((s, i) => ({
    ...s,
    index: i,
    seatId: `seat-${i}`,
    facing: s.properties?.find((p) => p.name === "facing")?.value ?? "down",
  })) as SeatDef[];
const rects = officeCollisions(objects("collisions"), seats);
const pf = new Pathfinder(
  map.width * map.tilewidth,
  map.height * map.tileheight,
  rects,
  NAV_CLEARANCE,
);
describe("actual office layout navigation", () => {
  for (const seat of seats)
    it(
      `${seat.seatId} can reach every room interaction and return safely`,
      () => {
        const start = { x: seat.x, y: seat.y + 33.6 };
        expect(pf.segmentClear(start.x, start.y, start.x, start.y)).toBe(true);
        for (const poi of [...objects("pois"), ...AMBIENT_POIS]) {
          const route = pf.findPath(start.x, start.y, poi.x, poi.y);
          expect(route, poi.name).not.toBeNull();
          for (let i = 1; i < route!.length; i++)
            expect(
              pf.segmentClear(route![i - 1].x, route![i - 1].y, route![i].x, route![i].y),
              poi.name,
            ).toBe(true);
          const end = route!.at(-1)!;
          expect(
            pf.findPath(end.x, end.y, start.x, start.y)?.at(-1),
            `return from ${poi.name}`,
          ).toEqual(start);
        }
      },
      // This exhaustive route check passes alone, but takes 5.8–6.2s under full-suite contention.
      seat.seatId === "seat-0" ? 10_000 : undefined,
    );
  it("reroutes around a temporary occupant instead of walking through them", () => {
    const route = pf
      .avoiding([{ x: 520, y: 500, width: 24, height: 19.2 }])
      .findPath(450, 520, 650, 520);
    expect(route).not.toBeNull();
  });
});
describe("deterministic ambient routines", () => {
  it("replays choices for a stable seat and staggers different seats", () => {
    const a = new AmbientRoutine("alice"),
      b = new AmbientRoutine("alice"),
      c = new AmbientRoutine("bob");
    for (let i = 0; i < 20; i++) expect(a.deskActivity()).toBe(b.deskActivity());
    a.reset(0, "calm");
    c.reset(0, "calm");
    expect(a.nextAt).not.toBe(c.nextAt);
  });
  it("off disables scheduling and trips have bounded dwell times", () => {
    const a = new AmbientRoutine("alice");
    a.reset(0, "off");
    expect(a.nextAt).toBe(Infinity);
    a.begin("reading", 100);
    expect(a.until).toBeGreaterThanOrEqual(12100);
    expect(a.until).toBeLessThanOrEqual(30100);
    expect(a.destinationActivity("Window 1")).toBe("looking_out_window");
  });
});
