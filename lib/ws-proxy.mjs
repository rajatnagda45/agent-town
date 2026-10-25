/**
 * Shared WebSocket proxy logic (ESM version for production server).
 * This is a JS mirror of ws-proxy.ts for use in server.prod.mjs
 * where TypeScript is not available.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isAllowedWebSocketOrigin } from "./server-security.mjs";
import {
  buildGatewayConnection,
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  sanitizeGatewayClientMessage,
} from "./ws-proxy-shared.mjs";

const MAX_BUFFERED_MESSAGES = 100;
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

const isProd = process.env.NODE_ENV === "production";
const prefix = "[WS Proxy]";
const proxyLog = {
  debug: isProd ? () => {} : console.debug.bind(console, prefix),
  info: isProd ? () => {} : console.info.bind(console, prefix),
  warn: console.warn.bind(console, prefix),
  error: console.error.bind(console, prefix),
};

function isForwardableCloseCode(code) {
  return (
    code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
  );
}

export function readOpenClawToken() {
  const candidates = [
    path.join(homedir(), ".openclaw", "openclaw.json"),
    path.join(homedir(), ".openclaw-dev", "openclaw.json"),
  ];
  for (const candidate of candidates) {
    try {
      const config = JSON.parse(readFileSync(candidate, "utf8"));
      const token = config?.gateway?.auth?.token;
      if (typeof token === "string" && token.length > 0) return token;
    } catch {
      // Try the next local config path.
    }
  }
  return undefined;
}

function proxyWebSocket(WebSocket, clientWs, gatewayUrl, serverToken) {
  const connection = buildGatewayConnection(gatewayUrl, serverToken);
  const upstream = new WebSocket(connection.url, {
    headers: connection.headers,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });
  const bufferedMessages = [];

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
      proxyLog.error("send to client failed:", err.message);
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
    const forwarded = sanitizeGatewayClientMessage(data, isBinary, serverToken);
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

function checkOrigin(req, socket) {
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
 * @param {import("http").Server} server
 * @param {typeof import("ws").WebSocket} WebSocket - WebSocket constructor
 * @param {typeof import("ws").WebSocketServer} WebSocketServer - WebSocketServer constructor
 * @param {string} gatewayUrl
 * @param {string} [serverToken]
 * @param {string} [path="/api/gateway"]
 */
export function attachWsProxy(
  server,
  WebSocket,
  WebSocketServer,
  gatewayUrl,
  serverToken,
  path = "/api/gateway",
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === path) {
      if (!checkOrigin(req, socket)) return;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        proxyWebSocket(WebSocket, clientWs, gatewayUrl, serverToken);
      });
    }
  });

  wss.on("error", (err) => {
    proxyLog.error("server error:", err.message);
  });
}
