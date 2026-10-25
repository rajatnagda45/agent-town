/**
 * Shared WebSocket proxy logic used by both dev (server.ts) and prod (server.prod.mjs) servers.
 *
 * Proxies a client WebSocket connection to an upstream gateway,
 * buffering messages during upstream connection and forwarding close codes.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { type IncomingMessage } from "http";
import type { Duplex } from "stream";
import { RawData, WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./logger";
import { isAllowedWebSocketOrigin } from "./server-security.mjs";
import {
  buildGatewayConnection,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  sanitizeGatewayClientMessage,
} from "./ws-proxy-shared.mjs";

const proxyLog = createLogger("WS Proxy");

const MAX_BUFFERED_MESSAGES = 100;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** Read the gateway auth token directly from the OpenClaw config file. */
export function readOpenClawToken(): string | undefined {
  const candidates = [
    path.join(homedir(), ".openclaw", "openclaw.json"),
    path.join(homedir(), ".openclaw-dev", "openclaw.json"),
  ];
  for (const p of candidates) {
    try {
      // Owner credentials are runtime inputs outside the release, never build assets.
      const raw = readFileSync(/* turbopackIgnore: true */ p, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const token = (cfg?.gateway as Record<string, unknown> | undefined)?.auth as
        Record<string, unknown> | undefined;
      const value = token?.token;
      if (typeof value === "string" && value.length > 0) {
        proxyLog.info("Loaded gateway token from OpenClaw config");
        return value;
      }
    } catch {
      // file not found or not readable — try next
    }
  }
  return undefined;
}

function isForwardableCloseCode(code: number) {
  return (
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

function proxyWebSocket(clientWs: WebSocket, gatewayUrl: string, serverToken?: string) {
  const connection = buildGatewayConnection(gatewayUrl, serverToken);
  const upstream = new WebSocket(connection.url, {
    headers: connection.headers,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });
  const bufferedMessages: Array<{ data: RawData; isBinary: boolean }> = [];

  const connectTimeout = setTimeout(() => {
    if (upstream.readyState === WebSocket.CONNECTING) {
      proxyLog.error("upstream connection timeout");
      bufferedMessages.length = 0;
      upstream.terminate();
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, "Gateway connection timeout");
      }
    }
  }, UPSTREAM_CONNECT_TIMEOUT_MS);

  upstream.on("open", () => {
    clearTimeout(connectTimeout);
    for (const message of bufferedMessages) {
      upstream.send(message.data, { binary: message.isBinary });
    }
    bufferedMessages.length = 0;
  });

  upstream.on("message", (data, isBinary) => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary });
      }
    } catch (err) {
      proxyLog.error("send to client failed:", (err as Error).message);
    }
  });

  upstream.on("close", (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      const textReason = reason.toString();
      if (isForwardableCloseCode(code)) {
        clientWs.close(code, textReason);
      } else {
        clientWs.close();
      }
    }
  });

  upstream.on("error", (err) => {
    proxyLog.error("upstream error:", err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, "Gateway connection error");
    }
  });

  clientWs.on("message", (data, isBinary) => {
    const forwarded: RawData = sanitizeGatewayClientMessage(data, isBinary, serverToken);

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(forwarded, { binary: isBinary });
      return;
    }
    if (
      upstream.readyState === WebSocket.CONNECTING &&
      bufferedMessages.length < MAX_BUFFERED_MESSAGES
    ) {
      bufferedMessages.push({ data: forwarded, isBinary });
    }
  });

  clientWs.on("close", () => {
    clearTimeout(connectTimeout);
    bufferedMessages.length = 0;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  clientWs.on("error", (err) => {
    proxyLog.error("client error:", err.message);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });
}

/** Validate WebSocket upgrade origin against host header. */
function checkOrigin(req: IncomingMessage, socket: Duplex): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!isAllowedWebSocketOrigin(origin, host)) {
    proxyLog.warn("Rejected WS upgrade: missing or cross-origin Origin header");
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return false;
  }
  return true;
}

/**
 * Attach a WebSocket proxy to an HTTP server.
 * Intercepts upgrade requests to `path` and proxies them to `gatewayUrl`.
 * If `serverToken` is provided it is used for gateway auth (injected into the
 * connect frame and the upstream URL) regardless of what the browser sends.
 */
export function attachWsProxy(
  server: import("http").Server,
  gatewayUrl: string,
  serverToken?: string,
  path = "/api/gateway",
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    const reqPath = req.url?.split("?")[0];
    if (reqPath === path) {
      if (!checkOrigin(req, socket)) return;
      wss.handleUpgrade(req, socket as Duplex, head, (clientWs) => {
        proxyWebSocket(clientWs, gatewayUrl, serverToken);
      });
    }
  });

  wss.on("error", (err) => {
    proxyLog.error("server error:", err.message);
  });
}
