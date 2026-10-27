import { describe, expect, it } from "vitest";
import { activityLabel } from "@/components/game/entities/worker/visual";
import { Pathfinder } from "@/components/game/utils/Pathfinder";

const idle = {
  status: "idle" as const,
  moving: false,
  blocked: false,
  connection: "connected" as const,
  voice: "idle" as const,
  role: "Worker",
};

describe("office presentation derives honest state", () => {
  it("distinguishes initialization, speech and muted calls", () => {
    expect(activityLabel({ ...idle, voice: "connecting" })).toBe("Connecting call");
    expect(activityLabel({ ...idle, voice: "speaking" })).toBe("Speaking");
    expect(activityLabel({ ...idle, voice: "muted" })).toBe("Call · muted");
  });
  it("does not claim execution over a disconnected gateway", () => {
    expect(activityLabel({ ...idle, status: "working", connection: "disconnected" })).toBe(
      "Offline",
    );
  });
  it("preserves outcome and route failure feedback", () => {
    expect(activityLabel({ ...idle, status: "done" })).toBe("Complete");
    expect(activityLabel({ ...idle, status: "failed" })).toBe("Task failed");
    expect(activityLabel({ ...idle, status: "working", blocked: true })).toBe("Working");
  });
  it("uses configured roles only while real work is active", () => {
    expect(activityLabel({ ...idle, role: "Researcher" })).toBe("");
    expect(activityLabel({ ...idle, status: "working", role: "Researcher" })).toBe("Researching");
    expect(activityLabel({ ...idle, status: "working", role: "QA" })).toBe("Reviewing");
    expect(activityLabel({ ...idle, status: "working", moving: true })).toBe("Returning to desk");
  });
});

describe("office routes", () => {
  it("cannot cross a wall spanning the map", () => {
    const pf = new Pathfinder(160, 160, [{ x: 64, y: 0, width: 16, height: 160 }]);
    expect(pf.findPath(24, 24, 120, 24)).toBeNull();
  });
  it("routes through a doorway instead of cutting corners", () => {
    const pf = new Pathfinder(160, 160, [{ x: 64, y: 0, width: 16, height: 96 }]);
    const path = pf.findPath(24, 24, 120, 24)!;
    expect(path).not.toBeNull();
    expect(path.some((point) => point.y >= 100)).toBe(true);
  });
  it("snaps blocked destinations to the interior of a safe cell", () => {
    const pf = new Pathfinder(160, 160, [{ x: 64, y: 64, width: 32, height: 32 }]);
    const path = pf.findPath(24, 24, 70, 70)!;
    const end = path.at(-1)!;
    expect(end).not.toEqual({ x: 70, y: 70 });
    expect(end.x % 8).toBe(4);
    expect(end.y % 8).toBe(4);
  });
});
