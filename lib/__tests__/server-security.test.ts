import { describe, expect, it } from "vitest";
import {
  isAllowedWebSocketOrigin,
  isAllowedAppOrigin,
  isLoopbackAddress,
  resolveBindHost,
  validateGatewayTarget,
} from "../server-security.mjs";

describe("server security policy", () => {
  it("binds to IPv4 loopback by default", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
  });

  it("refuses non-loopback HTTP binding", () => {
    expect(() => resolveBindHost({ HOST: "0.0.0.0" })).toThrow(/refusing to bind/i);
  });

  it("allows local ws gateway targets", () => {
    expect(validateGatewayTarget("ws://127.0.0.1:18789", {})).toBe("ws://127.0.0.1:18789/");
  });

  it("requires explicit opt-in and TLS for remote gateways", () => {
    expect(() => validateGatewayTarget("wss://gateway.example.test", {})).toThrow(
      /disabled by default/i,
    );
    expect(() =>
      validateGatewayTarget("ws://gateway.example.test", { ALLOW_REMOTE_GATEWAY: "true" }),
    ).toThrow(/must use wss/i);
    expect(
      validateGatewayTarget("wss://gateway.example.test", { ALLOW_REMOTE_GATEWAY: "true" }),
    ).toBe("wss://gateway.example.test/");
  });

  it("requires a same-origin browser WebSocket handshake", () => {
    expect(isAllowedWebSocketOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(isAllowedWebSocketOrigin("https://evil.example", "127.0.0.1:3000")).toBe(false);
    expect(isAllowedWebSocketOrigin(undefined, "127.0.0.1:3000")).toBe(false);
  });

  it("recognizes Node loopback address forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.5")).toBe(false);
  });
});

it("requires an explicit HTTPS public origin for cross-device access", () => {
  const env = { AGENT_TOWN_PUBLIC_ORIGINS: "https://town.example.test" };
  expect(isAllowedAppOrigin("https://town.example.test", "town.example.test", env)).toBe(true);
  expect(isAllowedAppOrigin("http://town.example.test", "town.example.test", env)).toBe(false);
  expect(isAllowedAppOrigin("https://town.example.test", "other.example.test", env)).toBe(false);
  expect(isAllowedAppOrigin("https://town.example.test", "town.example.test", {})).toBe(false);
});
