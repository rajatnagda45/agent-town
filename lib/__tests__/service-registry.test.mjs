import { expect, it, vi } from "vitest";
import { ServiceRegistry } from "../server/service-registry.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";
import { createZetarisHttpTransport } from "../server/data-zetaris.mjs";
import { createWebSearchReader } from "../server/web-evidence.mjs";
import { DataEvidenceService } from "../server/data-integration.mjs";
import { classifyOfficeIntent } from "../server/office-intent.mjs";
import trace from "../__fixtures__/group-routing-failure.json" with { type: "json" };

const env = {
  ZETARIS_OPEN_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/start",
  ZETARIS_PAGE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
  ZETARIS_CLOSE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
  ZETARIS_PAGE_METHOD: "GET",
  ZETARIS_CLOSE_METHOD: "DELETE",
  ZETARIS_ORG_ID: "1",
  ZETARIS_ROWS_KEY: "records",
  ZETARIS_QUERY_TOKEN_KEY: "queryToken",
  ZETARIS_ALLOW_LOOPBACK_HTTP: "1",
  ZETARIS_BEARER_TOKEN: "private-zetaris-token",
  TAVILY_API_KEY: "private-search-token",
  NIGHTSHIFT_API_KEY: "private-reasoning-token",
};
const runtime = (provider, status = "connected") => ({
  agentsReady: true,
  gateway: {
    provider,
    status,
    stopped: false,
    capabilities: () => ({ "chat.send": { available: true } }),
  },
});

it("records the actual analytics routing gap without changing the failed turn or classifying it as an inventory request", () => {
  expect(classifyOfficeIntent(trace.request)).toEqual({ kind: "ordinary" });
  expect(trace.dispatch.completedTasks).toBe(7);
  expect(trace.dispatch.distinctBackendAgents).toBe(1);
  expect(trace.linkedRuntimeRecordsContainingTurnId).toBe(0);
});

it("registers four credential-free services without probing, distinguishing missing config from unchecked config", () => {
  const missing = new ServiceRegistry();
  expect(missing.snapshot().services).toHaveLength(4);
  expect(missing.snapshot().services.every((service) => service.status === "unconfigured")).toBe(
    true,
  );
  const registry = new ServiceRegistry({ env });
  expect(registry.get("zetaris").status).toBe("unverified");
  expect(registry.get("web-search").status).toBe("unverified");
  expect(registry.get("nightshift").reason).toBe("no_active_execution_adapter");
  expect(registry.snapshot().probesPerformed).toBe(false);
  const json = JSON.stringify(registry.snapshot());
  for (const value of [
    env.ZETARIS_OPEN_URL,
    env.ZETARIS_BEARER_TOKEN,
    env.TAVILY_API_KEY,
    env.NIGHTSHIFT_API_KEY,
  ])
    expect(json).not.toContain(value);
});

it("resolves available capabilities separately from unauthorized, unreachable and unconfigured services", () => {
  const registry = new ServiceRegistry({ env });
  registry.observe("zetaris", "unauthorized");
  registry.observe("web-search", "unreachable");
  expect(
    registry.resolve(["source_linked_evidence"]).blocked.map((service) => service.status),
  ).toEqual(["unauthorized", "unreachable"]);
  registry.observe("web-search", "available");
  expect(
    registry.resolve(["source_linked_evidence"]).available.map((service) => service.id),
  ).toEqual(["web-search"]);
  const missing = new ServiceRegistry();
  missing.observe("zetaris", "available");
  expect(missing.get("zetaris").status).toBe("unconfigured");
});

it("expires successful reads and cannot treat synthetic reads as proof of live access", () => {
  let now = 1000;
  const registry = new ServiceRegistry({ env, now: () => now });
  registry.observe("zetaris", "available");
  expect(registry.get("zetaris").available).toBe(true);
  now += 60001;
  expect(registry.get("zetaris").reason).toBe("observation_expired");
  registry.observe("synthetic", "available");
  expect(registry.get("zetaris").available).toBe(false);
});

it("reports authenticated execution separately from tool/permission verification and from failed authentication", () => {
  const openclaw = runtime("openclaw");
  const nightshift = runtime("nightshift");
  const registry = new ServiceRegistry({ env, runtimes: [openclaw, nightshift] });
  expect(registry.get("nightshift").capabilities).toEqual(["text_reasoning"]);
  expect(registry.get("nightshift").available).toBe(true);
  expect(registry.get("openclaw").capabilities).not.toContain("web_search");
  nightshift.gateway.status = "auth_failed";
  expect(registry.get("nightshift").status).toBe("unauthorized");
  openclaw.gateway.status = "disconnected";
  expect(registry.get("openclaw").status).toBe("unreachable");
  openclaw.gateway.status = "auth_failed";
  openclaw.gateway.connectionFailure = "unreachable";
  expect(registry.get("openclaw").status).toBe("unreachable");
  openclaw.gateway.status = "connected";
  openclaw.gateway.capabilities = () => ({
    "chat.send": { available: false, reason: "Missing operator.write scope" },
  });
  expect(registry.get("openclaw").status).toBe("unauthorized");
});

it("exposes only a sanitized same-origin service inventory", async () => {
  const services = new ServiceRegistry({ env });
  let status;
  let body;
  const response = {
    writeHead(code) {
      status = code;
    },
    end(value) {
      body = JSON.parse(value);
    },
  };
  await createRuntimeHandler({ services })(
    { url: "/api/runtime/services", method: "GET", headers: { host: "localhost:3000" } },
    response,
  );
  expect(status).toBe(200);
  expect(body.services).toHaveLength(4);
  expect(JSON.stringify(body)).not.toContain("private-");
  await createRuntimeHandler({ services })(
    {
      url: "/api/runtime/services",
      method: "GET",
      headers: { host: "localhost:3000", origin: "https://unrelated.invalid" },
    },
    response,
  );
  expect(status).toBe(403);
});

it.each([401, 403])(
  "preserves HTTP %i as unauthorized for Zetaris and web search without leaking credentials",
  async (status) => {
    const fetchImpl = vi.fn(async () => new Response("private-response", { status }));
    const transport = createZetarisHttpTransport({
      profile: "installed-sql-v1",
      openUrl: env.ZETARIS_OPEN_URL,
      pageUrl: env.ZETARIS_PAGE_URL,
      closeUrl: env.ZETARIS_CLOSE_URL,
      pageMethod: "GET",
      closeMethod: "DELETE",
      bearerToken: env.ZETARIS_BEARER_TOKEN,
      orgId: "1",
      allowLoopbackHttp: true,
      fetchImpl,
    });
    await expect(transport.open({ select: "SELECT 1", pageLimit: 1 })).rejects.toMatchObject({
      serviceId: "zetaris",
      serviceStatus: "unauthorized",
    });
    const reader = createWebSearchReader({ apiKey: env.TAVILY_API_KEY, fetchImpl });
    await expect(
      reader.read({ templateId: "web-search", parameters: { query: "pump manual" }, scope: {} }),
    ).rejects.toMatchObject({ serviceId: "web-search", serviceStatus: "unauthorized" });
  },
);

it("records an adapter failure at the shared evidence boundary without persisting evidence or raw provider errors", async () => {
  const scope = {
    incidentId: "incident",
    taskId: "task",
    seatId: "seat",
    agentId: "main",
    gatewayId: "gateway",
    sessionKey: "agent:main:main",
    bindingRevision: 1,
  };
  const services = new ServiceRegistry({ env });
  const records = {
    get: (kind) => ({
      value:
        kind === "incident"
          ? {}
          : { incidentId: scope.incidentId, assignment: { ...scope, runtimeTaskId: scope.taskId } },
    }),
    put: vi.fn(),
  };
  const runtime = {
    services,
    gatewayId: scope.gatewayId,
    db: { getTask: () => ({ ...scope, status: "completed" }) },
    resolve: () => ({
      seat: { seatId: scope.seatId, binding: { agentId: scope.agentId, revision: 1 } },
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    }),
  };
  const reader = {
    read: async () => {
      throw Object.assign(new Error("private-provider-text"), {
        serviceId: "zetaris",
        serviceStatus: "unauthorized",
      });
    },
  };
  await expect(
    new DataEvidenceService(runtime, records, reader).read({ ...scope, templateId: "sample" }),
  ).rejects.toThrow("private-provider-text");
  expect(services.get("zetaris").status).toBe("unauthorized");
  expect(JSON.stringify(services.snapshot())).not.toContain("private-provider-text");
  expect(records.put).not.toHaveBeenCalled();
});

it("classifies transport failures as unreachable without exposing the underlying exception", async () => {
  const fetchImpl = async () => {
    throw new Error("private-network-secret");
  };
  const reader = createWebSearchReader({ apiKey: env.TAVILY_API_KEY, fetchImpl });
  await expect(
    reader.read({ templateId: "web-search", parameters: { query: "pump manual" }, scope: {} }),
  ).rejects.toMatchObject({
    serviceStatus: "unreachable",
    message: "Web search request failed or timed out.",
  });
  const transport = createZetarisHttpTransport({
    profile: "installed-sql-v1",
    openUrl: env.ZETARIS_OPEN_URL,
    pageUrl: env.ZETARIS_PAGE_URL,
    closeUrl: env.ZETARIS_CLOSE_URL,
    pageMethod: "GET",
    closeMethod: "DELETE",
    bearerToken: env.ZETARIS_BEARER_TOKEN,
    orgId: "1",
    allowLoopbackHttp: true,
    fetchImpl,
  });
  await expect(transport.open({ select: "SELECT 1", pageLimit: 1 })).rejects.toMatchObject({
    serviceStatus: "unreachable",
    message: "Zetaris POST query request failed (network).",
  });
});

it.each(["zetaris", "web", "synthetic"])(
  "records only validated live %s reads as service availability",
  async (mode) => {
    const scope = {
      incidentId: "incident",
      taskId: "task",
      seatId: "seat",
      agentId: "main",
      gatewayId: "gateway",
      sessionKey: "agent:main:main",
      bindingRevision: 1,
    };
    const services = new ServiceRegistry({ env });
    const records = {
      get: (kind) => ({
        value:
          kind === "incident"
            ? {}
            : {
                incidentId: scope.incidentId,
                assignment: { ...scope, runtimeTaskId: scope.taskId },
              },
      }),
      put: vi.fn(),
    };
    const runtime = {
      services,
      gatewayId: scope.gatewayId,
      db: {
        getTask: () => ({ ...scope, status: "completed" }),
        record: () => null,
        saveRecord: vi.fn(),
      },
      resolve: () => ({
        seat: { seatId: scope.seatId, binding: { agentId: scope.agentId, revision: 1 } },
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
      }),
    };
    const reader = {
      serviceId: mode === "synthetic" ? null : mode === "web" ? "web-search" : "zetaris",
      read: async () => ({ scope, evidence: [], mode }),
    };
    const data = new DataEvidenceService(runtime, records, reader);
    await data.read({ ...scope, templateId: "sample" });
    expect(services.get("zetaris").available).toBe(mode === "zetaris");
    expect(services.get("web-search").available).toBe(mode === "web");
    reader.read = async () => {
      throw new Error("Invalid provider schema");
    };
    await expect(data.read({ ...scope, templateId: "sample" })).rejects.toThrow(
      "Invalid provider schema",
    );
    expect(services.get("zetaris").available).toBe(false);
    expect(services.get("web-search").available).toBe(false);
  },
);

it("keeps a malformed or insecure Zetaris profile unconfigured", () => {
  const registry = new ServiceRegistry({ env: { ...env, ZETARIS_ALLOW_LOOPBACK_HTTP: "0" } });
  expect(registry.get("zetaris")).toMatchObject({
    status: "unconfigured",
    reason: "invalid_configuration",
  });
});
