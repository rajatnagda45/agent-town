/**
 * Production server for Agent Town (npx / standalone).
 *
 * Reads the Next.js config from the standalone build output and creates
 * an HTTP server with Next.js request handler + WebSocket proxy.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readOpenClawToken } from "./lib/ws-proxy.mjs";
import {
  attachAuggieBridge,
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
} from "./lib/auggie-bridge.mjs";
import { createInternalApiHandler } from "./lib/internal-api.mjs";
import { resolveBindHost, validateGatewayTarget } from "./lib/server-security.mjs";
import { createTaskService } from "./lib/server/runtime-api.mjs";
import { createInventoryStartupReader } from "./lib/server/inventory-startup.mjs";
import { APPROVED_INVENTORY_ZETARIS_TEMPLATES } from "./lib/server/inventory-zetaris-mapping.mjs";
import { setServerRuntime } from "./lib/server/runtime-access.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isProd = process.env.NODE_ENV === "production";
const prefix = "[Server]";
const log = {
  info: isProd ? () => {} : console.info.bind(console, prefix),
  error: console.error.bind(console, prefix),
};

// Load standalone config before importing next
const requiredServerFiles = JSON.parse(
  readFileSync(join(__dirname, ".next", "required-server-files.json"), "utf-8"),
);
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredServerFiles.config);

const { default: next } = await import("next");
const { WebSocket, WebSocketServer } = await import("ws");

const port = parseInt(process.env.PORT ?? "3000", 10);
const host = resolveBindHost();
const handleInternalApi = createInternalApiHandler({
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
});

process.chdir(__dirname);
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(async () => {
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
      attachAuggieBridge(server, WebSocket, WebSocketServer);
    } else {
      server.on("upgrade", (req, socket) => {
        if (req.url?.split("?")[0] === "/api/gateway")
          socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n");
      });
    }

    server.listen(port, host, () => {
      tasks.start();
      log.info("");
      log.info("  \x1b[36m\x1b[1mAgent Town\x1b[0m is running!");
      log.info("");
      log.info(`  > Local:   \x1b[4mhttp://${host}:${port}\x1b[0m`);
      if (AGENT_PROVIDER === "auggie") {
        log.info("  > Provider: Auggie (bridging via auggie CLI)");
      } else if (AGENT_PROVIDER === "nightshift") {
        log.info("  > Provider: Nightshift (server-owned HTTP adapter)");
      } else {
        log.info(`  > Gateway: ${GATEWAY_URL}`);
      }
      log.info("");
    });
    server.on("close", () => tasks.close());
  })
  .catch((err) => {
    log.error("Failed to start Agent Town:", err);
    process.exit(1);
  });
