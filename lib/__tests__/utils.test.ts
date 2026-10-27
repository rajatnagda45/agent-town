import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDefaultGatewayUrl } from "../utils";

describe("getDefaultGatewayUrl", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    // Remove window to simulate server-side by default
    // @ts-expect-error -- deliberately removing window for tests
    delete globalThis.window;
  });

  afterEach(() => {
    if (originalWindow !== undefined) {
      globalThis.window = originalWindow;
    } else {
      // @ts-expect-error -- restoring original state
      delete globalThis.window;
    }
  });

  it("returns ws:// URL based on window.location for http", () => {
    globalThis.window = {
      location: { protocol: "http:", host: "myapp.local:3000" },
    } as unknown as Window & typeof globalThis;
    expect(getDefaultGatewayUrl()).toBe("ws://myapp.local:3000/api/gateway");
  });

  it("returns wss:// URL based on window.location for https", () => {
    globalThis.window = {
      location: { protocol: "https:", host: "myapp.local" },
    } as unknown as Window & typeof globalThis;
    expect(getDefaultGatewayUrl()).toBe("wss://myapp.local/api/gateway");
  });

  it("ignores browser-exposed gateway overrides and stays same-origin", () => {
    process.env.NEXT_PUBLIC_GATEWAY_URL = "ws://env-wins:1234/";
    globalThis.window = {
      location: { protocol: "https:", host: "app.local" },
    } as unknown as Window & typeof globalThis;
    expect(getDefaultGatewayUrl()).toBe("wss://app.local/api/gateway");
    delete process.env.NEXT_PUBLIC_GATEWAY_URL;
  });

  it("falls back to ws://localhost:3000/api/gateway on server side", () => {
    // No env var, no window
    expect(getDefaultGatewayUrl()).toBe("ws://localhost:3000/api/gateway");
  });
});
