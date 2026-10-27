import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { TaskDatabase } from "../server/task-db.mjs";
import { VoiceService } from "../server/voice.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";
import { classifyVoiceError, sanitizeDiagnostic, sanitizeUsage } from "../voice/diagnostics.mjs";

describe("voice diagnostic sanitization", () => {
  it.each([
    ["NotReadableError", "microphone_busy"],
    ["OverconstrainedError", "microphone_constraints"],
    ["SecurityError", "microphone_permission"],
    ["TimeoutError", "timeout"],
    ["Error", "media"],
  ])("distinguishes browser %s from provider/network errors", (name, code) => {
    expect(classifyVoiceError({ name, message: "private device detail" }, "browser")).toMatchObject(
      { code, phase: "browser" },
    );
  });

  it.each([
    ["RESOURCE_EXHAUSTED: quota exceeded", "quota"],
    ["PERMISSION_DENIED", "auth"],
    ["UNAUTHENTICATED: token expired", "auth"],
  ])("classifies a provider close reason without exposing it: %s", (message, code) => {
    const result = classifyVoiceError({ message: `${message} at https://private.test?key=secret` });
    expect(result.code).toBe(code);
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  });
  it("classifies errors without retaining provider messages, URLs, credentials or stacks", () => {
    const diagnostic = classifyVoiceError(
      {
        status: 404,
        message: "models/private not found at https://google.test?key=secret",
        stack: "private stack",
      },
      "provisioning",
    );
    expect(diagnostic).toMatchObject({
      code: "model_api_version",
      phase: "provisioning",
      httpStatus: 404,
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|google.test|private/);
    expect(
      sanitizeDiagnostic({ code: "__proto__", message: "secret", closeCode: 1008 }),
    ).toMatchObject({ code: "connection", closeCode: 1008 });
    expect(classifyVoiceError({ message: "unsupported API version v0?key=secret" }).code).toBe(
      "model_api_version",
    );
  });

  it("preserves missing usage as unknown, retaining only finite nonnegative provider counts", () => {
    expect(sanitizeUsage(undefined)).toBeUndefined();
    expect(sanitizeUsage({ totalTokenCount: -1, responseTokenCount: Infinity })).toBeUndefined();
    expect(
      sanitizeUsage({
        promptTokenCount: 0,
        responseTokenCount: 12,
        totalTokenCount: 1.5,
        cachedContentTokenCount: NaN,
        thoughtsTokenCount: Number.MAX_SAFE_INTEGER + 1,
        providerText: "key=secret",
      }),
    ).toEqual({ promptTokenCount: 0, responseTokenCount: 12 });
  });
});

describe("durable shared voice diagnostics", () => {
  let directory: string;
  let db: TaskDatabase;
  let voice: VoiceService;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "voice-diagnostics-"));
    db = new TaskDatabase(join(directory, "test.sqlite"));
    voice = new VoiceService({ db, gatewayId: "test-gateway" });
    voice.context = () => ({
      seatId: "alice",
      agentId: "main",
      sessionKey: "agent:main:main",
      bindingRevision: 1,
      name: "Alice",
      role: "Engineer",
      gatewayConnected: true,
      status: "idle",
      execution: {
        canSubmit: true,
        configurationPending: false,
        reviewRequired: false,
        activeTaskIds: [],
      },
      tasks: [],
      conversation: [],
    });
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes sanitized records to other devices and retains them after SQLite reopen", () => {
    const published: unknown[] = [];
    db.subscribe((event: unknown) => published.push(event));
    const callId = voice.createCall({});
    const input = {
      callId,
      sequence: 1,
      status: "connected",
      durationMs: 1200,
      usageSequence: 1,
      usage: { promptTokenCount: 7, totalTokenCount: 9, secret: "key" },
      diagnostic: { code: "quota", phase: "call", message: "secret", url: "private" },
    };
    const report = voice.report(input);
    expect(report).toMatchObject({
      model: "gemini-3.8-live",
      apiVersion: "v1beta",
      durationMs: 1200,
      usageSource: "provider_reported_client_relayed",
    });
    expect(report.usageReports[0].usage).toEqual({ promptTokenCount: 7, totalTokenCount: 9 });
    expect(JSON.stringify(published)).not.toMatch(/secret|private/);
    expect(published).toContainEqual(expect.objectContaining({ kind: "voiceCall", data: report }));
    expect(voice.report(input)).toEqual(report);
    const ended = voice.report({ ...input, sequence: 2, status: "ended", durationMs: 2400 });
    expect(ended.usageReports).toHaveLength(1);
    expect(voice.report({ ...input, sequence: 3, durationMs: 9999 })).toEqual(ended);
    db.close();
    db = new TaskDatabase(join(directory, "test.sqlite"));
    voice = new VoiceService({ db, gatewayId: "test-gateway" });
    expect(voice.snapshot().calls).toEqual([ended]);
    expect(voice.snapshot().billingNotice).toContain("not Google's actual bill");
  });

  it("stores zero connected duration on failure and rejects invalid or foreign reports", () => {
    const call = voice.recordFailure(
      {},
      { code: "model_api_version", phase: "provisioning", message: "secret" },
    );
    expect(call).toMatchObject({ status: "error", durationMs: 0, usageReports: [] });
    expect(call.endedAt).toBeTruthy();
    expect(() =>
      voice.report({ callId: call.id, sequence: 2, status: "ended", durationMs: -1 }),
    ).toThrow(/Invalid/);
    expect(() =>
      voice.report({ callId: "unknown", sequence: 1, status: "ended", durationMs: 0 }),
    ).toThrow(/not found/);
    expect(new VoiceService({ db, gatewayId: "other-gateway" }).snapshot().calls).toEqual([]);
  });

  it("bounds metadata history and retains decreasing reports without inventing a total", () => {
    const callId = voice.createCall({});
    for (let i = 1; i <= 105; i++)
      voice.report({
        callId,
        sequence: i,
        status: "connected",
        durationMs: i,
        usageSequence: i,
        usage: { totalTokenCount: 106 - i },
      });
    const call = voice.snapshot().calls[0];
    expect(call.usageReports).toHaveLength(100);
    expect(call.usageReports.at(-1).usage.totalTokenCount).toBe(1);
    expect(call).not.toHaveProperty("cost");
    expect(call).not.toHaveProperty("totalTokens");
  });

  it("serves shared records over HTTP and prevents cross-origin diagnostic writes", async () => {
    const handler = createRuntimeHandler({ voice });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const result = await fetch(`${origin}/api/runtime/voice/diagnostics`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ selection: {}, diagnostic: { code: "quota", message: "secret" } }),
      });
      expect(result.status).toBe(200);
      const otherDevice = await fetch(`${origin}/api/runtime/voice/diagnostics`);
      expect(otherDevice.headers.get("Cache-Control")).toBe("no-store");
      const snapshot = await otherDevice.json();
      expect(snapshot.calls).toHaveLength(1);
      expect(JSON.stringify(snapshot)).not.toContain("secret");
      const denied = await fetch(`${origin}/api/runtime/voice/diagnostics`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      });
      expect(denied.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
