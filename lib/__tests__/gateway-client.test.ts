import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../gateway";
import { classifyTaskSendError, resolveExecutionSessionKey } from "../hooks/useTaskRouter";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

async function connectClient(socket = FakeWebSocket.instances.at(-1)) {
  if (!socket) throw new Error("Missing fake socket");
  socket.open();
  socket.message({ type: "event", event: "connect.challenge", payload: {} });
  const connectFrame = JSON.parse(socket.sent.at(-1) ?? "{}");
  socket.message({
    type: "res",
    id: connectFrame.id,
    ok: true,
    payload: { type: "hello-ok", scopes: ["operator.read", "operator.write"] },
  });
  await Promise.resolve();
}

describe("GatewayClient recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects pending work on disconnect and reconnects without replaying it", async () => {
    const client = new GatewayClient("ws://localhost/api/gateway", "device-1");
    const connected = client.connect();
    await connectClient(FakeWebSocket.instances[0]);
    await connected;

    const firstSocket = FakeWebSocket.instances[0];
    const pending = client.request("chat.send", { message: "do once" });
    expect(firstSocket.sent.filter((raw) => JSON.parse(raw).method === "chat.send")).toHaveLength(
      1,
    );

    firstSocket.close();
    await expect(pending).rejects.toThrow("Connection closed");
    expect(client.status).toBe("disconnected");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const reconnectSocket = FakeWebSocket.instances[1];
    await connectClient(reconnectSocket);
    expect(client.status).toBe("connected");
    expect(reconnectSocket.sent.filter((raw) => JSON.parse(raw).method === "chat.send")).toEqual(
      [],
    );
  });

  it("times out a request without retaining it for replay", async () => {
    const client = new GatewayClient("ws://localhost/api/gateway", "device-1");
    const connected = client.connect();
    await connectClient(FakeWebSocket.instances[0]);
    await connected;

    const pending = client.request("chat.send", { message: "slow" }, 50);
    const rejection = expect(pending).rejects.toThrow("Timeout: chat.send");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(classifyTaskSendError(new Error("Timeout: chat.send"))).toBe("outcome_unknown");
  });

  it("stops reconnecting after an unrecoverable authentication failure", async () => {
    const client = new GatewayClient("ws://localhost/api/gateway", "device-1");
    const connected = client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ type: "event", event: "connect.challenge", payload: {} });
    const connectFrame = JSON.parse(socket.sent.at(-1) ?? "{}");
    socket.message({
      type: "res",
      id: connectFrame.id,
      ok: false,
      error: { message: "authentication failed" },
    });

    await expect(connected).rejects.toThrow("authentication failed");
    expect(client.status).toBe("auth_failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(classifyTaskSendError(new Error("permission denied"))).toBe("failed");
  });

  it("routes independent agent seats to isolated execution sessions", () => {
    const seats = [
      {
        seatId: "seat-a",
        label: "A",
        seatType: "agent" as const,
        status: "empty" as const,
        agentConfig: { agentId: "researcher" },
      },
      {
        seatId: "seat-b",
        label: "B",
        seatType: "agent" as const,
        status: "empty" as const,
        agentConfig: { agentId: "builder" },
      },
    ];
    expect(resolveExecutionSessionKey(seats, "seat-a", "agent:main:ui")).toBe(
      "agent:researcher:main",
    );
    expect(resolveExecutionSessionKey(seats, "seat-b", "agent:main:ui")).toBe("agent:builder:main");
  });
});
