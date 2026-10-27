import { Server } from "node:http";

// Test-only Node preload: exercise real provisioning and SQLite without paid traffic.
if (
  process.env.AGENT_TOWN_MOCK_VOICE !== "1" ||
  process.env.GEMINI_API_KEY !== "fixture-never-used"
)
  throw new Error("Mock voice preload requires an isolated fixture server.");
if (!process.env.AGENT_TOWN_MOCK_VOICE_NONCE) throw new Error("Missing mocked-server proof nonce.");
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === "request" && args[0].url === "/api/__test/mock-voice") {
    args[1].writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    args[1].end(JSON.stringify({ mocked: true, nonce: process.env.AGENT_TOWN_MOCK_VOICE_NONCE }));
    return true;
  }
  return emit.call(this, event, ...args);
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "generativelanguage.googleapis.com" && /\/auth_tokens$/.test(url.pathname)) {
    const body = options?.body ?? (input instanceof Request ? await input.clone().text() : "");
    const name = /You are ([^,]+),/.exec(String(body))?.[1] ?? "Alice";
    return Response.json({ name: `auth_tokens/test-${encodeURIComponent(name)}` });
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Mocked release checks forbid external HTTP requests.");
  return nativeFetch(input, options);
};
