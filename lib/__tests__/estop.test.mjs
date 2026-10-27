import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmergencyStop } from "../server/estop.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-town-estop-"));
  dirs.push(dir);
  return dir;
};

it("engages, reports and releases, and blocks new work while engaged", () => {
  const stop = new EmergencyStop(join(temp(), "ESTOP"));
  expect(stop.status()).toEqual({ engaged: false });
  expect(() => stop.assertClear()).not.toThrow();
  expect(stop.engage("pump room flooding")).toMatchObject({
    engaged: true,
    reason: "pump room flooding",
  });
  expect(() => stop.assertClear()).toThrow(/Emergency stop is engaged: pump room flooding/);
  try {
    stop.assertClear();
  } catch (error) {
    expect(error.status).toBe(423);
  }
  expect(stop.release()).toEqual({ engaged: false });
  expect(stop.release()).toEqual({ engaged: false });
});

it("fails safe: a corrupt or unreadable sentinel still counts as engaged", () => {
  const dir = temp();
  writeFileSync(join(dir, "ESTOP"), "not json");
  expect(new EmergencyStop(join(dir, "ESTOP")).status()).toMatchObject({ engaged: true });
  // A sentinel that is a directory cannot be read, so it is treated as engaged.
  mkdirSync(join(dir, "DIR_ESTOP"));
  expect(new EmergencyStop(join(dir, "DIR_ESTOP")).engaged()).toBe(true);
});
