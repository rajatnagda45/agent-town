/**
 * Custom Next.js dev server with WebSocket proxy.
 *
 * Proxies ws://localhost:3000/api/gateway → ws://GATEWAY_URL
 * so the browser never needs to connect to the gateway directly.
 */

import { createServer } from "http";
import next from "next";
import { createLogger } from "./lib/logger";
import { readOpenClawToken } from "./lib/ws-proxy";
import {
  attachAuggieBridge,
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
} from "./lib/auggie-bridge";
import { createInternalApiHandler } from "./lib/internal-api.mjs";
import { resolveBindHost, validateGatewayTarget } from "./lib/server-security.mjs";
import { createTaskService } from "./lib/server/runtime-api.mjs";
import { createInventoryStartupReader } from "./lib/server/inventory-startup.mjs";
import { APPROVED_INVENTORY_ZETARIS_TEMPLATES } from "./lib/server/inventory-zetaris-mapping.mjs";
import { setServerRuntime } from "./lib/server/runtime-access.mjs";

const log = createLogger("Server");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "3000", 10);
const host = resolveBindHost();
const app = next({ dev });
const handle = app.getRequestHandler();

const handleInternalApi = createInternalApiHandler({
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
});

app
  .prepare()
  .then(async () => {
    // Next loads .env.local during prepare; resolve provider settings afterwards.
    const AGENT_PROVIDER = process.env.AGENT_PROVIDER ?? "openclaw";
    const GATEWAY_URL = validateGatewayTarget(process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789/");
    const serverToken =
      AGENT_PROVIDER === "openclaw" ? process.env.GATEWAY_TOKEN || readOpenClawToken() : undefined;
    const tasks = await createTaskService({
      gatewayUrl: GATEWAY_URL,
      token: serverToken,
      provider: AGENT_PROVIDER,
      syncSeats: AGENT_PROVIDER === "auggie" ? setWorkerRoster : undefined,
      dataReader: createInventoryStartupReader(process.env, {
        approvedLiveTemplates: APPROVED_INVENTORY_ZETARIS_TEMPLATES,
      }),
    });
    setServerRuntime(tasks.runtime);
    const server = createServer((req, res) => {
      if (
        req.url?.startsWith("/api/runtime/") ||
        req.url?.split("?")[0] === "/api/agents/discover"
      ) {
        void tasks.handler(req, res);
        return;
      }
      // Intercept internal API routes before Next.js
      const pathname = req.url?.split("?")[0];
      if (
        AGENT_PROVIDER === "auggie" &&
        (pathname === "/api/internal/dispatch" || pathname === "/api/internal/seat-sync")
      ) {
        void handleInternalApi(req, res);
        return;
      }
      handle(req, res);
    });

    if (AGENT_PROVIDER === "auggie") {
      attachAuggieBridge(server);
      log.info(`Ready on http://localhost:${port}`);
      log.info(`Provider: Auggie (bridging via auggie CLI)`);
    } else {
      server.on("upgrade", (req, socket) => {
        if (req.url?.split("?")[0] === "/api/gateway") {
          socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
        }
      });
      log.info(`Ready on http://localhost:${port}`);
      log.info(
        AGENT_PROVIDER === "nightshift"
          ? "Provider: Nightshift (server-owned HTTP adapter)"
          : `Server-owned gateway connection: ${GATEWAY_URL}`,
      );
      if (AGENT_PROVIDER === "nightshift") {
        log.info("Nightshift discovery: check /api/runtime/state for connection status");
      } else if (serverToken) {
        log.info("Gateway auth: configured server-side");
      } else {
        log.info("Gateway auth: no server-side token found");
      }
    }

    server.listen(port, host, () => tasks.start());
    server.on("close", () => tasks.close());
  })
  .catch((err) => {
    log.error("Failed to prepare Next.js:", err);
    process.exit(1);
  });
