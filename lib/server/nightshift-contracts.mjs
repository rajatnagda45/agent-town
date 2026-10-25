import { ContractAudit } from "./contracts.mjs";

export const NIGHTSHIFT_BRIDGE_VERSION = "agent-town-nightshift-1";
const string = { type: "string", minLength: 1 };
const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

// These are contracts for Agent Town's own HTTP adapter, not OpenClaw claims.
export function nightshiftContracts() {
  return new ContractAudit({
    version: NIGHTSHIFT_BRIDGE_VERSION,
    protocol: 1,
    source: "Agent Town Nightshift adapter",
    schemas: {
      AgentsListParamsSchema: object({}),
      SessionsListParamsSchema: object({}),
      ChatSendParamsSchema: object(
        {
          sessionKey: string,
          message: string,
          originalMessage: string,
          idempotencyKey: string,
          agentId: string,
          seatId: string,
          bindingRevision: { type: "integer", minimum: 1 },
          seatLabel: string,
          seatRole: string,
        },
        ["sessionKey", "message", "idempotencyKey"],
      ),
      ChatAbortParamsSchema: object({ sessionKey: string, runId: string, agentId: string }, [
        "sessionKey",
        "runId",
      ]),
      ChatHistoryParamsSchema: object(
        { sessionKey: string, limit: { type: "integer", minimum: 1, maximum: 100 } },
        ["sessionKey"],
      ),
      ChatEventSchema: {
        type: "object",
        required: ["runId", "sessionKey", "agentId", "state"],
        properties: {
          runId: string,
          sessionKey: string,
          agentId: string,
          state: { enum: ["final", "error", "aborted", "uncertain"] },
          message: { type: "object" },
        },
      },
      AgentEventSchema: object(
        { runId: string, sessionKey: string, agentId: string, stream: string },
        ["runId", "sessionKey", "agentId", "stream"],
      ),
    },
  });
}
