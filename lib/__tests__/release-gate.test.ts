import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("paid live checks are explicitly opt-in", () => {
  it("refuses to run mocked browser checks against a personal server", () => {
    const result = spawnSync(process.execPath, [resolve("scripts/check-chat-voice.mjs")], {
      env: {
        ...process.env,
        AGENT_TOWN_MOCK_VOICE: "0",
        AGENT_TOWN_TEST_ORIGIN: "http://127.0.0.1:1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refuses personal/live servers");
    expect(result.stderr).not.toContain("fetch failed");
  });
  it("refuses before connecting to a server or provider", () => {
    const result = spawnSync(process.execPath, [resolve("scripts/check-voice.mjs")], {
      env: {
        ...process.env,
        AGENT_TOWN_ALLOW_PAID_VOICE_TESTS: "0",
        AGENT_TOWN_TEST_ORIGIN: "http://127.0.0.1:1",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("AGENT_TOWN_ALLOW_PAID_VOICE_TESTS=1");
    expect(result.stderr).not.toContain("fetch failed");
  });
});
