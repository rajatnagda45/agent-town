import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createInternalApiHandler, MAX_INTERNAL_BODY_BYTES } from "../internal-api.mjs";
import { buildGatewayConnection, sanitizeGatewayClientMessage } from "../ws-proxy-shared.mjs";

class FakeRequest extends EventEmitter {
  url: string;
  method = "POST";
  socket = { remoteAddress: "127.0.0.1" };
  headers: Record<string, string> = {};

  constructor(url: string) {
    super();
    this.url = url;
  }
}

class FakeResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  done: Promise<void>;
  private finish!: () => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  writeHead(status: number, headers: Record<string, string> = {}) {
    this.status = status;
    this.headers = headers;
  }

  end(body = "") {
    this.body = body;
    this.finish();
  }
}

async function invoke(
  handler: ReturnType<typeof createInternalApiHandler>,
  url: string,
  body: string,
  headers: Record<string, string> = {},
) {
  const req = new FakeRequest(url);
  req.headers = headers;
  const res = new FakeResponse();
  const handled = handler(req, res);
  req.emit("data", Buffer.from(body));
  req.emit("end");
  await Promise.all([handled, res.done]);
  return { status: res.status, json: JSON.parse(res.body) };
}

describe("packaged production WebSocket proxy primitives", () => {
  it("injects only the server token into the upstream URL, header, and connect frame", () => {
    const connection = buildGatewayConnection(
      "ws://127.0.0.1:18789/gateway?existing=1",
      "server-secret",
    );
    const upstream = new URL(connection.url);
    expect(upstream.searchParams.get("existing")).toBe("1");
    expect(upstream.searchParams.get("token")).toBe("server-secret");
    expect(connection.headers.Authorization).toBe("Bearer server-secret");

    const browserFrame = Buffer.from(
      JSON.stringify({
        type: "req",
        method: "connect",
        params: { auth: { token: "browser-secret" } },
      }),
    );
    const sanitized = JSON.parse(
      sanitizeGatewayClientMessage(browserFrame, false, "server-secret").toString(),
    );
    expect(sanitized).toMatchObject({
      method: "connect",
      params: { auth: { token: "server-secret" } },
    });
    expect(JSON.stringify(sanitized)).not.toContain("browser-secret");
  });

  it("removes browser auth when the server has no gateway token", () => {
    const input = Buffer.from(
      JSON.stringify({ type: "req", method: "connect", params: { auth: { token: "leak" } } }),
    );
    const sanitized = JSON.parse(sanitizeGatewayClientMessage(input, false).toString());
    expect(sanitized.params.auth).toEqual({});
  });
});

describe("shared production Auggie HTTP handlers", () => {
  it("serves seat sync and dispatch with validation", async () => {
    const setWorkerRoster = vi.fn();
    const dispatchToWorker = vi.fn(async () => ({ result: "done" }));
    const handler = createInternalApiHandler({
      setWorkerRoster,
      dispatchToWorker,
      validateDispatchSecret: (secret: string) => secret === "dispatch-secret",
    });

    const sync = await invoke(
      handler,
      "/api/internal/seat-sync",
      JSON.stringify({
        seats: [{ seatId: "seat-1", label: "Alice", roleTitle: "Engineer", assigned: true }],
      }),
    );
    expect(sync.status).toBe(200);
    expect(setWorkerRoster).toHaveBeenCalledWith([
      { seatId: "seat-1", label: "Alice", roleTitle: "Engineer" },
    ]);

    const unauthorized = await invoke(
      handler,
      "/api/internal/dispatch",
      JSON.stringify({ seatId: "seat-1", task: "work" }),
      { "x-dispatch-secret": "wrong" },
    );
    expect(unauthorized.status).toBe(401);

    const dispatched = await invoke(
      handler,
      "/api/internal/dispatch",
      JSON.stringify({ seatId: "seat-1", task: "work" }),
      { "x-dispatch-secret": "dispatch-secret" },
    );
    expect(dispatched.status).toBe(200);
    expect(dispatchToWorker).toHaveBeenCalledWith("seat-1", "work");
  });

  it("rejects oversized internal request bodies", async () => {
    const handler = createInternalApiHandler({
      setWorkerRoster: vi.fn(),
      dispatchToWorker: vi.fn(),
      validateDispatchSecret: () => true,
    });
    const response = await invoke(
      handler,
      "/api/internal/seat-sync",
      "x".repeat(MAX_INTERNAL_BODY_BYTES + 1),
    );
    expect(response.status).toBe(413);
  });

  it("rejects cross-origin browser requests to localhost-only handlers", async () => {
    const handler = createInternalApiHandler({
      setWorkerRoster: vi.fn(),
      dispatchToWorker: vi.fn(),
      validateDispatchSecret: () => true,
    });
    const response = await invoke(
      handler,
      "/api/internal/seat-sync",
      JSON.stringify({ seats: [] }),
      { origin: "https://evil.example", host: "127.0.0.1:3000" },
    );
    expect(response.status).toBe(403);
  });
});
