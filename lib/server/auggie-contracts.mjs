import { ContractAudit } from "./contracts.mjs";
import { randomBytes } from "node:crypto";
export const SERVER_BRIDGE_TOKEN = randomBytes(32).toString("hex");

export const BRIDGE_VERSION = "agent-town-bridge-1";
export const BRIDGE_METHODS = [
  "agents.list",
  "chat.send",
  "chat.abort",
  "sessions.list",
  "sessions.preview",
  "models.list",
];
const string = { type: "string", minLength: 1 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
/** Contracts for the bridge implemented here; they do not claim OpenClaw compatibility. */
export function localBridgeContracts() {
  return new ContractAudit({
    version: BRIDGE_VERSION,
    protocol: 3,
    source: "Agent Town Auggie bridge",
    schemas: {
      AgentsListParamsSchema: object({}),
      SessionsListParamsSchema: object({}),
      ChatSendParamsSchema: object(
        {
          sessionKey: string,
          message: string,
          idempotencyKey: string,
          seatLabel: string,
          seatRole: { type: "string" },
        },
        ["sessionKey", "message", "idempotencyKey"],
      ),
      ChatAbortParamsSchema: object({ sessionKey: string, runId: string }, ["sessionKey", "runId"]),
      SessionsPreviewParamsSchema: object(
        {
          keys: { type: "array", items: string },
          limit: { type: "number" },
          maxChars: { type: "number" },
        },
        ["keys"],
      ),
      ChatEventSchema: {
        type: "object",
        required: ["runId", "sessionKey", "state"],
        properties: {
          runId: string,
          sessionKey: string,
          state: { enum: ["final", "error", "aborted"] },
        },
      },
      AgentEventSchema: {
        type: "object",
        required: ["runId", "sessionKey", "stream"],
        properties: { runId: string, sessionKey: string, stream: string },
      },
    },
  });
}
