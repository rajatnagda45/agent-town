import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createToken, resolveContext, createCall } = vi.hoisted(() => ({
  createToken: vi.fn(),
  resolveContext: vi.fn(),
  createCall: vi.fn(),
}));
vi.mock("../server/runtime-access.mjs", () => ({
  getServerRuntime: () => ({
    voice: { context: resolveContext, retrieveContext: resolveContext, createCall },
  }),
}));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    authTokens = { create: createToken };
  },
}));

function request(origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/voice/session", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({ seatId: "alice", bindingRevision: 1 }),
  });
}

beforeEach(() => {
  vi.resetModules();
  createToken.mockReset();
  resolveContext.mockReset().mockReturnValue({
    seatId: "alice",
    name: "Verified Alice",
    role: "Writer",
    status: "idle",
    gatewayConnected: true,
    tasks: [],
    conversation: [],
    bindingRevision: 1,
    sessionKey: "agent:main:main",
  });
  createCall.mockReset().mockReturnValue("voice_server-call");
  vi.stubEnv("GEMINI_API_KEY", "server-secret-test-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("voice session provisioning", () => {
  it("reports configuration without revealing the key", async () => {
    const { GET } = await import("../../app/api/voice/session/route");
    const response = await GET();
    expect(await response.json()).toEqual({
      configured: true,
      model: "gemini-3.8-live",
      maxSeconds: 600,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses cross-origin provisioning before calling Google", async () => {
    const { POST } = await import("../../app/api/voice/session/route");
    expect((await POST(request("https://evil.example"))).status).toBe(403);
    expect(createToken).not.toHaveBeenCalled();
  });

  it("uses the browser Host when Next normalizes its internal URL to localhost", async () => {
    createToken.mockResolvedValue({ name: "ephemeral-test" });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(
      new Request("http://localhost:3000/api/voice/session", {
        method: "POST",
        headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a remote Host even with a matching Origin", async () => {
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(
      new Request("http://localhost:3000/api/voice/session", {
        method: "POST",
        headers: { host: "evil.example", origin: "http://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect(createToken).not.toHaveBeenCalled();
  });

  it("keeps permanent credentials private for an explicitly allowed public origin", async () => {
    vi.stubEnv("AGENT_TOWN_PUBLIC_ORIGINS", "https://office.example.test");
    createToken.mockResolvedValue({ name: "ephemeral-public-test" });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(
      new Request("https://office.example.test/api/voice/session", {
        method: "POST",
        headers: { host: "office.example.test", origin: "https://office.example.test" },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.token).toBe("ephemeral-public-test");
    expect(body).not.toHaveProperty("key");
    expect(JSON.stringify(body)).not.toContain("server-secret-test-key");
  });

  it("explains missing credentials", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      diagnostic: { code: "configuration", phase: "provisioning", httpStatus: 503 },
    });
    expect(createToken).not.toHaveBeenCalled();
  });

  it("issues one-use model-constrained tokens with a bounded lifetime", async () => {
    createToken.mockResolvedValue({ name: "ephemeral-test" });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.token).toBe("ephemeral-test");
    expect(JSON.stringify(body)).not.toContain("server-secret-test-key");
    const options = createToken.mock.calls[0][0].config;
    expect(options.uses).toBe(1);
    expect(options.liveConnectConstraints.model).toBe("gemini-3.8-live");
    expect(options.liveConnectConstraints.config.systemInstruction).toContain("Verified Alice");
    expect(body.callId).toBe("voice_server-call");
    expect(Date.parse(options.expireTime) - Date.parse(options.newSessionExpireTime)).toBe(540000);
  });

  it("does not leak provider error messages or key values", async () => {
    createToken.mockRejectedValue({ status: 403, message: "url?key=server-secret-test-key" });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("server-secret-test-key");
  });

  it("sanitizes SDK Error instances even when their status matches a runtime error", async () => {
    createToken.mockRejectedValue(
      Object.assign(new Error("url?key=server-secret-test-key"), { status: 503 }),
    );
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("server-secret-test-key");
  });

  it("limits repeated token creation", async () => {
    createToken.mockResolvedValue({ name: "ephemeral-test" });
    const { POST } = await import("../../app/api/voice/session/route");
    for (let i = 0; i < 6; i++) expect((await POST(request())).status).toBe(200);
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(await response.json()).toMatchObject({ diagnostic: { code: "rate_limit" } });
    expect(createToken).toHaveBeenCalledTimes(6);
  });

  it("rejects stale selection before minting a paid token", async () => {
    resolveContext.mockImplementation(() => {
      throw Object.assign(new Error("Binding changed"), { status: 409 });
    });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ diagnostic: { code: "selection" } });
    expect(createToken).not.toHaveBeenCalled();
  });

  it("rejects a rebind during token provisioning without returning the token", async () => {
    createToken.mockResolvedValue({ name: "ephemeral-stale" });
    createCall.mockImplementation(() => {
      throw Object.assign(new Error("Binding changed"), { status: 409 });
    });
    const { POST } = await import("../../app/api/voice/session/route");
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("ephemeral-stale");
  });
});
