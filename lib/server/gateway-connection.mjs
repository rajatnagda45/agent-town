import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

/** One upstream connection owned by the server, never by a browser. */
export class ServerGateway {
  constructor({ url, token, audit, origin, provider = "openclaw", headers = {} }) {
    this.url = url;
    this.token = token;
    this.audit = audit;
    this.origin = origin;
    this.provider = provider;
    this.headers = headers;
    this.status = "disconnected";
    this.hello = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.stopped = true;
    this.ws = null;
    this.timer = null;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(kind, data) {
    for (const fn of this.listeners) fn(kind, data);
  }
  capabilities() {
    return this.audit.capabilities(this.hello, this.status === "connected");
  }
  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }
  start() {
    this.stopped = false;
    if (!this.ws) this.connect();
  }
  connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    this.lastSeq = null;
    const ws = new WebSocket(this.url, {
      origin: this.origin,
      maxPayload: 1024 * 1024,
      headers: {
        ...this.headers,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    this.ws = ws;
    const deadline = setTimeout(() => ws.terminate(), 15000);
    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === "event" && frame.event === "connect.challenge") {
        try {
          const hello = await this.rawRequest("connect", {
            minProtocol: this.audit.protocol ?? 3,
            maxProtocol: this.audit.protocol ?? 4,
            client: {
              id: "gateway-client",
              displayName: "Agent Town server",
              version: "0.5.0",
              platform: process.platform,
              mode: "backend",
              instanceId: "agent-town-server",
            },
            auth: this.token ? { token: this.token } : {},
            role: "operator",
            scopes: [
              "operator.read",
              "operator.write",
              "operator.admin",
              "operator.approvals",
              "operator.questions",
            ],
          });
          if (hello?.type !== "hello-ok") throw new Error("Invalid gateway handshake");
          if (
            this.audit.validators.has("HelloOkSchema") &&
            !this.audit.validate("HelloOkSchema", hello)
          )
            throw new Error("Incompatible gateway handshake");
          this.hello = hello;
          this.connectionFailure = null;
          clearTimeout(deadline);
          this.setStatus("connected");
        } catch (error) {
          this.connectionFailure = error?.rejected
            ? "unauthorized"
            : /Invalid gateway handshake|Incompatible gateway handshake/.test(error?.message ?? "")
              ? "protocol"
              : "unreachable";
          this.setStatus("auth_failed");
          ws.close();
        }
        return;
      }
      if (frame.type === "res") {
        const pending = this.pending.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else {
            const error = new Error("Gateway rejected request");
            error.rejected = true;
            pending.reject(error);
          }
        }
        return;
      }
      if (frame.type === "event") {
        if (Number.isInteger(frame.seq)) {
          if (this.lastSeq !== null && frame.seq <= this.lastSeq) return;
          if (this.lastSeq !== null && frame.seq !== this.lastSeq + 1) {
            if (
              frame.event === "chat" &&
              ["final", "error", "aborted"].includes(frame.payload?.state)
            )
              this.emit("event", frame);
            ws.close();
            return;
          }
          this.lastSeq = frame.seq;
        }
        this.emit("event", frame);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(deadline);
      this.ws = null;
      const terminalAuth = this.status === "auth_failed";
      if (!terminalAuth) this.setStatus("disconnected");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Gateway connection closed; outcome unknown"));
      }
      this.pending.clear();
      if (!this.stopped && !terminalAuth) {
        this.timer = setTimeout(() => this.connect(), 2000);
        this.timer.unref();
      }
    });
  }
  rawRequest(method, params, timeoutMs = 30000) {
    if (this.ws?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Gateway disconnected"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Gateway request timed out; outcome unknown"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  request(method, params, timeoutMs) {
    const capability = this.capabilities()[method];
    if (!capability?.available)
      return Promise.reject(new Error(capability?.reason ?? "Unsupported gateway capability"));
    if (!this.audit.validate(method, params))
      return Promise.reject(new Error("Request does not match installed gateway schema"));
    return this.rawRequest(method, params, timeoutMs);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }
}
