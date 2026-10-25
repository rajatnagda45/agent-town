import { createHash } from "node:crypto";
import { SPECIALIST_CATALOGUE } from "./specialist-catalogue.mjs";
import { SpecialistJournal } from "./specialist-journal.mjs";
import { SpecialistRegistry } from "./specialist-registry.mjs";

const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const toolId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
const known = new Set(SPECIALIST_CATALOGUE.map((entry) => entry.manifest.id));
const REFRESH_MS = 20000;

/** Reviewed Agent Town tool names for OpenClaw's built-in browser, web and session tools
 * (docs.openclaw.ai/gateway/config-tools). A name counts only when `tools.effective` reports
 * the mapped OpenClaw tool for that session; mapping never grants or enables a tool. */
export const OPENCLAW_TOOL_MAP = Object.freeze({
  "openclaw.browser": ["browser"],
  "openclaw.web_search": ["web_search"],
  "openclaw.web_fetch": ["web_fetch"],
  "agent.message": ["sessions_send"],
  "openclaw.sessions.spawn": ["sessions_spawn"],
  "openclaw.sessions.list": ["sessions_list"],
  "openclaw.sessions.history": ["sessions_history"],
  "openclaw.sessions.status": ["session_status"],
});

/** Reviewed server configuration. Tokens are referenced by environment variable name only.
 * @param {Record<string, string|undefined>} env */
export function loadExecutionConfig(env = process.env) {
  const parse = (key, fallback) => {
    if (!env[key]) return fallback;
    try {
      return JSON.parse(env[key]);
    } catch {
      throw new Error(`Invalid ${key} JSON.`);
    }
  };
  const options = parse("AGENT_TOWN_EXECUTION_OPTIONS", []);
  const preference = parse("AGENT_TOWN_EXECUTION_PREFERENCE", []);
  if (
    !Array.isArray(preference) ||
    preference.length > 8 ||
    !preference.every(
      (item) => typeof item === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(item),
    )
  )
    throw new Error("Invalid AGENT_TOWN_EXECUTION_PREFERENCE.");
  if (
    !Array.isArray(options) ||
    options.length > 4 ||
    options.some(
      (row) =>
        !row ||
        Object.keys(row).some(
          (key) =>
            ![
              "id",
              "provider",
              "gatewayUrl",
              "tokenEnv",
              "sharedAgent",
              "grants",
              "toolMap",
            ].includes(key),
        ) ||
        !id(row.id) ||
        row.provider !== "openclaw" ||
        typeof row.gatewayUrl !== "string" ||
        !/^wss?:\/\//.test(row.gatewayUrl) ||
        (row.tokenEnv !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(row.tokenEnv)) ||
        (row.sharedAgent !== undefined && !id(row.sharedAgent)) ||
        !Array.isArray(row.grants ?? []) ||
        (row.grants ?? []).some(
          (grant) =>
            !grant ||
            Object.keys(grant).some(
              (key) => !["manifestId", "seatId", "sessionKey"].includes(key),
            ) ||
            !known.has(grant.manifestId) ||
            !id(grant.seatId) ||
            (grant.sessionKey !== undefined && typeof grant.sessionKey !== "string"),
        ) ||
        (row.toolMap !== undefined &&
          (typeof row.toolMap !== "object" ||
            Array.isArray(row.toolMap) ||
            Object.entries(row.toolMap).some(
              ([name, ids]) => !toolId(name) || !Array.isArray(ids) || !ids.every(toolId),
            ))),
    ) ||
    new Set(options.map((row) => row.id)).size !== options.length
  )
    throw new Error("Invalid AGENT_TOWN_EXECUTION_OPTIONS.");
  return { options, preference };
}

export const secondaryGatewayId = (row) =>
  createHash("sha256").update(`openclaw:${row.gatewayUrl}:${row.id}`).digest("hex");

/** Nightshift exposes no tools; its gateway enforces zero tool calls in server code.
 * The upstream model provider behind a Nightshift route is not verified at selection time. */
export function nightshiftOption(registry, enforcement) {
  const runtime = registry.runtime;
  return {
    id: "nightshift",
    registry,
    snapshot: (assignment, manifest) => ({
      gatewayId: runtime.gatewayId,
      sessionKey: assignment?.sessionKey,
      authenticated: runtime.gateway.status === "connected" && !!runtime.gateway.verifiedAt,
      checkedAt: runtime.gateway.verifiedAt ?? null,
      modelProvider: "unknown",
      model: runtime.gateway.model ?? null,
      tools: [],
      capabilities: manifest?.capabilities ?? [],
      permissions: { dataAccess: "none", sensitiveWrites: "denied" },
      outputSchemas: [],
    }),
    authorize: (input) => enforcement?.authorizeSync?.(input) === true,
    refresh: () => runtime.gateway.rediscover?.(),
  };
}

/** OpenClaw evidence comes only from fields the installed schemas define:
 * `tools.effective` → groups[].tools[].id; `agents.list` → agents[].model.primary.
 * Permissions, output schemas and budgets have no verified source, so they stay absent. */
export function openclawOption({
  id: optionId,
  registry,
  toolMap = OPENCLAW_TOOL_MAP,
  now = () => Date.now(),
}) {
  const runtime = registry.runtime;
  const inventory = new Map();
  const failures = new Map();
  const sessions = new Set(
    registry.grants.map((grant) => grant.sessionKey).filter((key) => typeof key === "string"),
  );
  // OpenClaw tool policy is the enforcement: fresh session discovery must show no tool outside
  // the manifest's reviewed names. Tool-call counts and deadlines stay with the registry.
  const scoped = (found, assignment, manifest) => {
    if (!found || !Array.isArray(manifest?.tools) || now() - found.checkedAt > 30000) return false;
    if (found.agentId !== undefined && found.agentId !== assignment?.agentId) return false;
    const allowed = new Set(manifest.tools.flatMap((name) => toolMap[name] ?? []));
    return [...found.tools].every((tool) => allowed.has(tool));
  };
  const discover = async (sessionKey) => {
    try {
      const result = await runtime.gateway.request("tools.effective", { sessionKey }, 10000);
      const ids = (Array.isArray(result?.groups) ? result.groups : []).flatMap((group) =>
        Array.isArray(group?.tools)
          ? group.tools.map((tool) => tool?.id).filter((value) => typeof value === "string")
          : [],
      );
      if (!Array.isArray(result?.groups)) throw new Error("Invalid tools.effective response");
      inventory.set(sessionKey, { checkedAt: now(), agentId: result.agentId, tools: new Set(ids) });
      failures.delete(sessionKey);
    } catch (error) {
      // Leave the prior evidence to expire; a timeout is not evidence of capability. The
      // reason is kept so a rejection can say why discovery failed, never to grant anything.
      failures.set(sessionKey, {
        at: now(),
        reason: String(error?.message ?? "discovery failed").slice(0, 160),
      });
    }
  };
  return {
    id: optionId,
    registry,
    snapshot: (assignment, manifest) => {
      const key = assignment?.sessionKey;
      if (typeof key === "string" && !sessions.has(key)) {
        sessions.add(key);
        void discover(key);
      }
      const found = inventory.get(key);
      const agent = runtime.agents.find((row) => row.agentId === assignment?.agentId);
      const model = typeof agent?.model === "string" && agent.model ? agent.model : null;
      return {
        gatewayId: runtime.gatewayId,
        sessionKey: key,
        authenticated: runtime.gateway.status === "connected" && runtime.agentsReady,
        checkedAt: found?.checkedAt ?? null,
        discoveryError: found ? undefined : failures.get(key)?.reason,
        modelProvider: model?.includes("/") ? model.split("/")[0].toLowerCase() : "unknown",
        model,
        // Reviewed Agent Town tool names count only when a mapped OpenClaw tool is effective.
        tools: found
          ? Object.entries(toolMap)
              .filter(([, ids]) => ids.some((item) => found.tools.has(item)))
              .map(([name]) => name)
          : [],
        capabilities: found ? (manifest?.capabilities ?? []) : [],
        // Manifest permissions hold only while the session can call nothing beyond its review.
        ...(scoped(found, assignment, manifest) ? { permissions: manifest.permissions } : {}),
      };
    },
    authorize: ({ manifest, assignment, task }) =>
      runtime.gateway.status === "connected" &&
      runtime.gateway.capabilities?.()["chat.abort"]?.available === true &&
      manifest?.provider === "openclaw" &&
      manifest.permissions?.sensitiveWrites === "denied" &&
      assignment?.gatewayId === runtime.gatewayId &&
      typeof task?.message === "string" &&
      task.message.length <= 8000 &&
      Number.isSafeInteger(task.retryCount ?? 0) &&
      (task.retryCount ?? 0) <= manifest.limits.maxRetries &&
      scoped(inventory.get(assignment.sessionKey), assignment, manifest),
    refresh: () => Promise.all([...sessions].map(discover)),
  };
}

/** Build server-owned options. Returns [] when no secondary runtime is configured,
 * preserving single-provider behaviour. */
export function createExecutionOptions({ config, primaryProvider, enforcement, secondaries = [] }) {
  const timers = [];
  const owned = [];
  const factory = (primaryRegistry) => {
    if (!config.options.length) return [];
    const options = [];
    if (primaryProvider === "nightshift")
      options.push(nightshiftOption(primaryRegistry, enforcement));
    else if (primaryProvider === "openclaw")
      options.push(openclawOption({ id: "openclaw-primary", registry: primaryRegistry }));
    for (const { row, runtime } of secondaries) {
      const registry = new SpecialistRegistry({
        runtime,
        journal: new SpecialistJournal(runtime.db, runtime.gatewayId),
        grants: row.grants ?? [],
      });
      owned.push(registry);
      options.push(
        openclawOption({ id: row.id, registry, toolMap: { ...OPENCLAW_TOOL_MAP, ...row.toolMap } }),
      );
    }
    for (const option of options) {
      void option.refresh?.();
      const timer = setInterval(() => void option.refresh?.(), REFRESH_MS);
      timer.unref?.();
      timers.push(timer);
    }
    return options;
  };
  return {
    factory,
    preference: config.preference,
    // The primary registry is owned by OfficeOperations; only secondary registries close here.
    close: () => {
      for (const timer of timers.splice(0)) clearInterval(timer);
      for (const registry of owned.splice(0)) registry.close();
    },
  };
}
