import { isAllowedWebSocketOrigin, isLoopbackAddress } from "./server-security.mjs";

export const MAX_INTERNAL_BODY_BYTES = 64 * 1024;
const MAX_TASK_CHARS = 32_000;
const MAX_SEATS = 64;
const MAX_FIELD_CHARS = 256;

function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, res) {
  return new Promise((resolve) => {
    let body = "";
    let bytes = 0;
    let finished = false;

    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      writeJson(res, status, { error: message });
      resolve(null);
    };

    req.on("data", (chunk) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > MAX_INTERNAL_BODY_BYTES) {
        fail(413, "Request body too large");
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (finished) return;
      try {
        const parsed = JSON.parse(body);
        finished = true;
        resolve(parsed);
      } catch {
        fail(400, "Invalid JSON body");
      }
    });
    req.on("error", () => fail(400, "Failed to read request body"));
  });
}

function isShortString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_CHARS;
}

function normalizeRoster(value) {
  if (!Array.isArray(value) || value.length > MAX_SEATS) return null;
  const seats = [];
  for (const seat of value) {
    if (!seat || typeof seat !== "object" || !seat.assigned) continue;
    if (!isShortString(seat.seatId) || !isShortString(seat.label)) return null;
    if (seat.roleTitle !== undefined && !isShortString(seat.roleTitle)) return null;
    seats.push({ seatId: seat.seatId, label: seat.label, roleTitle: seat.roleTitle });
  }
  return seats;
}

/**
 * Creates the two localhost-only HTTP endpoints used by the Auggie MCP bridge.
 * Returns true when the request path was handled.
 */
export function createInternalApiHandler({
  dispatchToWorker,
  validateDispatchSecret,
  setWorkerRoster,
}) {
  return async function handleInternalApi(req, res) {
    const pathname = req.url?.split("?")[0];
    if (pathname !== "/api/internal/dispatch" && pathname !== "/api/internal/seat-sync") {
      return false;
    }

    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      writeJson(res, 403, { error: "Forbidden" });
      return true;
    }
    const origin = req.headers.origin;
    if (origin && !isAllowedWebSocketOrigin(origin, req.headers.host)) {
      writeJson(res, 403, { error: "Forbidden origin" });
      return true;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" });
      return true;
    }

    if (pathname === "/api/internal/dispatch") {
      const secret = req.headers["x-dispatch-secret"];
      if (typeof secret !== "string" || !validateDispatchSecret(secret)) {
        writeJson(res, 401, { error: "Invalid dispatch secret" });
        return true;
      }
      const body = await readJsonBody(req, res);
      if (!body) return true;
      const { seatId, task } = body;
      if (!isShortString(seatId) || typeof task !== "string" || !task.trim()) {
        writeJson(res, 400, { error: "Valid seatId and task are required" });
        return true;
      }
      if (task.length > MAX_TASK_CHARS) {
        writeJson(res, 413, { error: "Task is too large" });
        return true;
      }
      try {
        const result = await dispatchToWorker(seatId, task);
        writeJson(res, result.error ? 500 : 200, result);
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : "Dispatch failed" });
      }
      return true;
    }

    const body = await readJsonBody(req, res);
    if (!body) return true;
    const roster = normalizeRoster(body.seats);
    if (!roster) {
      writeJson(res, 400, { error: "Invalid seat roster" });
      return true;
    }
    setWorkerRoster(roster);
    writeJson(res, 200, { ok: true });
    return true;
  };
}
