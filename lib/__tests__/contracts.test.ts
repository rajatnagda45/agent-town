import { describe, expect, it } from "vitest";
import { ContractAudit, loadInstalledContracts } from "../server/contracts.mjs";

// Synthetic versioned fixtures exercise compatibility, not a claim about OpenClaw.
const send = {
  type: "object",
  required: ["sessionKey", "message", "idempotencyKey"],
  additionalProperties: false,
  properties: {
    sessionKey: { type: "string" },
    message: { type: "string" },
    idempotencyKey: { type: "string" },
  },
};
const fixture = () =>
  new ContractAudit({
    version: "fixture-1",
    source: "synthetic fixture",
    schemas: {
      ChatSendParamsSchema: send,
      ChatEventSchema: { type: "object" },
      AgentEventSchema: { type: "object" },
    },
  });
const hello = {
  server: { version: "fixture-1" },
  features: { methods: ["chat.send"] },
  auth: { scopes: ["operator.write"] },
};

describe("installed gateway contract gate", () => {
  it("requires schema, exact version, method and granted scope", () => {
    const audit = fixture();
    expect(audit.capabilities(hello, true)["chat.send"].available).toBe(true);
    expect(
      audit.capabilities({ ...hello, auth: { scopes: [] } }, true)["chat.send"].available,
    ).toBe(false);
    expect(
      audit.capabilities({ ...hello, server: { version: "other" } }, true)["chat.send"].available,
    ).toBe(false);
    expect(audit.capabilities(hello, false)["chat.send"].available).toBe(false);
    expect(new ContractAudit().capabilities(hello, true)["chat.send"].available).toBe(false);
    expect(audit.capabilities(hello, true).questions.available).toBe(false);
  });
  it("rejects incompatible installed request formats and invalid runtime parameters", () => {
    const audit = new ContractAudit({
      source: "fixture",
      schemas: { ChatSendParamsSchema: { ...send, required: ["newField"] } },
    });
    expect(audit.results["chat.send"].available).toBe(false);
    expect(
      fixture().validate("chat.send", {
        sessionKey: "x",
        message: "x",
        idempotencyKey: "x",
        forged: true,
      }),
    ).toBe(false);
  });
  it("fails closed for a missing installation", async () => {
    const audit = await loadInstalledContracts({
      OPENCLAW_PROTOCOL_MODULE: "missing-protocol-module.js",
    });
    expect(audit.report().source).toBeNull();
    expect(audit.capabilities(hello, true)["agents.list"].available).toBe(false);
  });
});
