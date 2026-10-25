import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Explicit external origins require an authenticated TLS reverse proxy. */
/** @param {Record<string, string | undefined>} [env] */
export function isAllowedAppOrigin(origin, host, env = process.env) {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    if (url.host !== host || !["http:", "https:"].includes(url.protocol)) return false;
    if (isLoopbackHost(url.hostname)) return true;
    const origins = (env.AGENT_TOWN_PUBLIC_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return url.protocol === "https:" && origins.includes(url.origin);
  } catch {
    return false;
  }
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Agent Town is a local control surface. Remote HTTP binding needs a separate authenticated proxy. */
/** @param {Record<string, string | undefined>} env */
export function resolveBindHost(env = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to bind Agent Town to non-loopback host "${host}". ` +
        "Run it on 127.0.0.1 and place an authenticated TLS reverse proxy in front of it for remote access.",
    );
  }
  return host;
}

/** Remote gateways are opt-in and must use TLS. Local loopback ws:// targets remain supported. */
/** @param {string} rawUrl @param {Record<string, string | undefined>} env */
export function validateGatewayTarget(rawUrl, env = process.env) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid GATEWAY_URL: ${rawUrl}`);
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("GATEWAY_URL must use ws:// or wss://");
  }

  if (isLoopbackHost(url.hostname)) return url.toString();

  if (env.ALLOW_REMOTE_GATEWAY !== "true") {
    throw new Error(
      "Remote GATEWAY_URL values are disabled by default. Set ALLOW_REMOTE_GATEWAY=true explicitly.",
    );
  }
  if (url.protocol !== "wss:") {
    throw new Error("Remote gateways must use wss://");
  }
  return url.toString();
}

/** Browser WebSocket upgrades must come from the same HTTP(S) origin as Agent Town. */
export function isAllowedWebSocketOrigin(origin, host) {
  return isAllowedAppOrigin(origin, host);
}

export function safeSecretEqual(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
