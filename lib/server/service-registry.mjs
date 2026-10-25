import { zetarisDeadlines } from "./zetaris-deadlines.mjs";
import { createZetarisHttpTransport, MAX_ZETARIS_RESPONSE_BYTES } from "./data-zetaris.mjs";
import { ZETARIS_REQUIRED_SETTINGS } from "./inventory-startup.mjs";
import { nightshiftBaseUrl } from "./nightshift-gateway.mjs";
import { webSearchConfigured } from "./web-evidence.mjs";

const TTL = 60000;
const observedStates = new Set(["available", "unauthorized", "unreachable", "unverified"]);

/** Server-owned service inventory. Registration never performs a query or provider request.
 * Only snapshots cross the HTTP boundary; URLs, tokens and provider errors never do. */
export class ServiceRegistry {
  constructor({ env = {}, runtimes = [], now = () => Date.now() } = {}) {
    this.now = now;
    this.runtimes = runtimes;
    this.observations = new Map();
    const missing = (keys) => keys.filter((key) => !env[key]?.trim());
    const zetarisMissing = missing(ZETARIS_REQUIRED_SETTINGS);
    let zetarisValid = false;
    if (!zetarisMissing.length) {
      try {
        createZetarisHttpTransport({
          ...zetarisDeadlines(env),
          profile: "installed-sql-v1",
          openUrl: env.ZETARIS_OPEN_URL,
          pageUrl: env.ZETARIS_PAGE_URL,
          closeUrl: env.ZETARIS_CLOSE_URL,
          pageMethod: env.ZETARIS_PAGE_METHOD,
          closeMethod: env.ZETARIS_CLOSE_METHOD,
          bearerToken: env.ZETARIS_BEARER_TOKEN,
          orgId: env.ZETARIS_ORG_ID,
          allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
        });
        zetarisValid =
          env.ZETARIS_ROWS_KEY === "records" && env.ZETARIS_QUERY_TOKEN_KEY === "queryToken";
      } catch {
        /* Invalid profile is configuration failure, not a network observation. */
      }
    }
    const nightshiftMissing = missing(["NIGHTSHIFT_API_KEY"]);
    let nightshiftValid = false;
    try {
      nightshiftBaseUrl(env.NIGHTSHIFT_BASE_URL ?? "http://127.0.0.1:8088/v1");
      nightshiftValid = !nightshiftMissing.length && env.NIGHTSHIFT_API_KEY !== "rt-local";
    } catch {}
    const openclawConfigured = runtimes.some((runtime) => runtime.gateway.provider === "openclaw");
    this.definitions = [
      {
        id: "zetaris",
        kind: "data",
        capabilities: ["approved_sql_read", "source_linked_evidence"],
        configuration: {
          configured: zetarisValid,
          missing: zetarisMissing,
          adapterRegistered: true,
        },
        permissions: {
          dataAccess: "read_only",
          writes: "denied",
          scope:
            "Server-approved query templates only; source mappings and task scope are checked separately.",
        },
        limits: {
          open: {
            baselineMs: Number(env.ZETARIS_OPEN_TIMEOUT_MS ?? 10000),
            maximumMs: Number(env.ZETARIS_OPEN_MAX_TIMEOUT_MS ?? 120000),
            policy: "successful exact-SQL observations with bounded headroom",
          },
          pageTimeoutMs: Number(env.ZETARIS_PAGE_TIMEOUT_MS ?? 10000),
          cleanupTimeoutMs: Number(env.ZETARIS_CLEANUP_TIMEOUT_MS ?? 10000),
          pageLimit: 50,
          maxPages: 3,
          maxEvidenceRows: 100,
          maxResponseBytes: MAX_ZETARIS_RESPONSE_BYTES,
        },
      },
      {
        id: "web-search",
        kind: "data",
        capabilities: ["web_search", "web_extract", "source_linked_evidence"],
        configuration: {
          configured: webSearchConfigured(env),
          missing: webSearchConfigured(env) ? [] : ["TAVILY_API_KEY or TAVILY_KEYLESS=1"],
          adapterRegistered: true,
        },
        permissions: {
          dataAccess: "public_web",
          writes: "denied",
          scope:
            "Reviewed Tavily search and extraction of its own result URLs only; retrieved text is untrusted evidence.",
        },
        limits: {
          timeoutMs: 15000,
          maxResults: 4,
          maxQueryChars: 400,
          maxExtractUrls: 2,
          maxExtractChars: 500,
          maxSnippetChars: 300,
        },
      },
      {
        id: "nightshift",
        kind: "reasoning",
        capabilities: ["text_reasoning"],
        configuration: {
          configured: nightshiftValid,
          missing: nightshiftMissing,
          adapterRegistered: runtimes.some((runtime) => runtime.gateway.provider === "nightshift"),
        },
        permissions: {
          dataAccess: "supplied_context_only",
          writes: "denied",
          scope: "Reasoning does not imply SQL, search or external tool access.",
        },
        limits: {
          maxRuntimeSeconds: 180,
          maxRequestChars: 16000,
          maxResponseBytes: 32768,
          maxOutputTokens: 1024,
          maxToolCalls: 0,
        },
      },
      {
        id: "openclaw",
        kind: "execution",
        capabilities: ["agent_execution", "session_messaging"],
        configuration: {
          configured: openclawConfigured,
          missing: openclawConfigured ? [] : ["OpenClaw runtime registration"],
          adapterRegistered: openclawConfigured,
        },
        permissions: {
          dataAccess: "reviewed_grants_only",
          writes: "approval_required",
          scope:
            "Audited RPC and per-task specialist authorization; tool availability is not inferred from a connection.",
        },
        limits: {
          policy:
            "Reviewed specialist manifest and verified provider enforcement; no global tool grant.",
        },
      },
    ];
  }

  observe(serviceId, status, reason) {
    if (!["zetaris", "web-search"].includes(serviceId) || !observedStates.has(status)) return;
    this.observations.set(serviceId, {
      status,
      checkedAt: this.now(),
      ...(reason === "query_timeout" ? { reason } : {}),
    });
  }

  executionState(serviceId) {
    const candidates = this.runtimes.filter((runtime) => runtime.gateway.provider === serviceId);
    const results = candidates.map((runtime) => {
      const gateway = runtime.gateway;
      if (gateway.status === "auth_failed") {
        if (gateway.connectionFailure === "unreachable")
          return { status: "unreachable", reason: "connection_failed" };
        if (gateway.connectionFailure === "protocol")
          return { status: "unverified", reason: "protocol_not_verified" };
        return { status: "unauthorized", reason: "authentication_rejected" };
      }
      if (gateway.status === "connected") {
        const send = gateway.capabilities()["chat.send"];
        if (!send?.available)
          return {
            status: /scope|permission/i.test(send?.reason ?? "") ? "unauthorized" : "unverified",
            reason: "execution_capability_not_verified",
          };
        if (!runtime.agentsReady)
          return { status: "unverified", reason: "agent_discovery_pending" };
        return { status: "available", reason: "authenticated_execution_connection" };
      }
      if (gateway.lastError === "model_unavailable")
        return { status: "unverified", reason: "configured_model_not_advertised" };
      if (gateway.status === "disconnected" && gateway.stopped !== false && !gateway.lastError)
        return { status: "unverified", reason: "adapter_not_started" };
      if (gateway.status === "connecting")
        return { status: "unverified", reason: "connection_pending" };
      return { status: "unreachable", reason: "connection_unavailable" };
    });
    return (
      ["available", "unauthorized", "unreachable", "unverified"]
        .map((status) => results.find((item) => item.status === status))
        .find(Boolean) ?? { status: "unverified", reason: "no_active_execution_adapter" }
    );
  }

  get(serviceId) {
    const definition = this.definitions.find((service) => service.id === serviceId);
    if (!definition) return null;
    let state;
    if (!definition.configuration.configured)
      state = {
        status: "unconfigured",
        reason: definition.configuration.missing.length
          ? "missing_configuration"
          : "invalid_configuration",
      };
    else if (["nightshift", "openclaw"].includes(serviceId)) state = this.executionState(serviceId);
    else {
      const observation = this.observations.get(serviceId);
      state =
        observation && this.now() - observation.checkedAt <= TTL
          ? {
              ...observation,
              reason:
                observation.reason ??
                (observation.status === "available"
                  ? "validated_read"
                  : observation.status === "unauthorized"
                    ? "authentication_rejected"
                    : observation.status === "unreachable"
                      ? "request_unreachable"
                      : "read_pending_or_not_validated"),
            }
          : {
              status: "unverified",
              reason: observation ? "observation_expired" : "no_live_observation",
            };
    }
    return structuredClone({
      ...definition,
      ...state,
      available: state.status === "available",
      availabilityScope:
        "Service access only. Does not prove task authorization, source freshness, correct mappings or a verified outcome.",
    });
  }

  snapshot() {
    return {
      services: this.definitions.map(({ id }) => this.get(id)),
      observationTtlMs: TTL,
      probesPerformed: false,
    };
  }

  /** Capability lookup for routing; never turns a configured but unchecked service into a candidate. */
  resolve(capabilities) {
    if (
      !Array.isArray(capabilities) ||
      !capabilities.length ||
      !capabilities.every((item) => typeof item === "string")
    )
      throw new Error("Service lookup requires capability names.");
    const matching = this.snapshot().services.filter((service) =>
      capabilities.every((item) => service.capabilities.includes(item)),
    );
    return {
      available: matching.filter((service) => service.available),
      blocked: matching.filter((service) => !service.available),
    };
  }
}
