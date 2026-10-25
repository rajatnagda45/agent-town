import Ajv from "ajv";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// These are application adapters, not declarations that a gateway supports them.
// Every adapter must also pass the installed schema and live permission checks.
export const CONTRACTS = {
  "agents.list": ["AgentsListParamsSchema", {}, "operator.read"],
  "agents.create": [
    "AgentsCreateParamsSchema",
    { name: "contract-audit", workspace: "/audit" },
    "operator.admin",
  ],
  "agents.update": [
    "AgentsUpdateParamsSchema",
    { agentId: "main", name: "contract-audit" },
    "operator.admin",
  ],
  "agents.delete": ["AgentsDeleteParamsSchema", { agentId: "contract-audit" }, "operator.admin"],
  "agents.files.get": [
    "AgentsFilesGetParamsSchema",
    { agentId: "main", name: "SOUL.md" },
    "operator.read",
  ],
  "agents.files.set": [
    "AgentsFilesSetParamsSchema",
    { agentId: "main", name: "SOUL.md", content: "audit" },
    "operator.admin",
  ],
  "chat.send": [
    "ChatSendParamsSchema",
    { sessionKey: "agent:main:main", message: "audit", idempotencyKey: "audit" },
    "operator.write",
  ],
  "chat.abort": [
    "ChatAbortParamsSchema",
    { sessionKey: "agent:main:main", runId: "audit" },
    "operator.write",
  ],
  "chat.history": [
    "ChatHistoryParamsSchema",
    { sessionKey: "agent:main:main", limit: 100 },
    "operator.read",
  ],
  "agent.wait": ["AgentWaitParamsSchema", { runId: "audit", timeoutMs: 1 }, "operator.read"],
  "sessions.list": ["SessionsListParamsSchema", {}, "operator.read"],
  "sessions.preview": [
    "SessionsPreviewParamsSchema",
    { keys: ["agent:main:main"], limit: 50, maxChars: 2000 },
    "operator.read",
  ],
  "exec.approval.list": ["ExecApprovalListParamsSchema", {}, "operator.approvals"],
  "exec.approval.resolve": [
    "ExecApprovalResolveParamsSchema",
    { id: "audit", decision: "deny" },
    "operator.approvals",
  ],
  "approval.get": ["ApprovalGetParamsSchema", { id: "audit" }, "operator.approvals"],
  "approval.resolve": [
    "ApprovalResolveParamsSchema",
    { id: "audit", kind: "exec", decision: "deny" },
    "operator.approvals",
  ],
  "sessions.messages.subscribe": [
    "SessionsMessagesSubscribeParamsSchema",
    { key: "agent:main:main", includeApprovals: true },
    "operator.read",
  ],
  "models.list": ["ModelsListParamsSchema", {}, "operator.read"],
  // Read-only effective tool inventory for one session (installed 2026.10.7 handler).
  "tools.effective": [
    "ToolsEffectiveParamsSchema",
    { sessionKey: "agent:audit:main" },
    "operator.read",
  ],
  "sessions.patch": [
    "SessionsPatchParamsSchema",
    { key: "agent:main:main", model: null },
    "operator.write",
  ],
  "question.get": ["QuestionGetParamsSchema", { id: "audit" }, "operator.questions"],
  "question.list": ["QuestionListParamsSchema", {}, "operator.questions"],
  "question.resolve": [
    "QuestionResolveParamsSchema",
    { id: "audit", cancel: true },
    "operator.questions",
  ],
};

export const REVIEW_SCHEMAS = [
  "SessionApprovalEventSchema",
  "SessionApprovalReplaySchema",
  "ApprovalSnapshotSchema",
  "ApprovalGetResultSchema",
  "ApprovalResolveResultSchema",
  "ExecApprovalListResultSchema",
  "QuestionRequestedEventSchema",
  "QuestionResolvedEventSchema",
  "QuestionRecordSchema",
  "QuestionListResultSchema",
  "QuestionGetResultSchema",
  "QuestionResolveResultSchema",
  "AgentsCreateResultSchema",
  "AgentsUpdateResultSchema",
  "SessionsPatchResultSchema",
  "ModelsListResultSchema",
];

export class ContractAudit {
  /** @param {{ schemas?: Record<string, any>, version?: string|null, protocol?: number|null, source?: string|null, reason?: string }} [options] */
  constructor({
    schemas = {},
    version = null,
    protocol = null,
    source = null,
    reason = "Installed gateway schemas have not been located.",
  } = {}) {
    this.version = version;
    this.protocol = protocol;
    this.source = source;
    this.reason = reason;
    this.validators = new Map();
    this.schemas = new Map();
    this.roleCompareAndSet = !!schemas.AgentsFilesSetParamsSchema?.properties?.expectedHash;
    /** @type {Record<string, {available: boolean, reason: string}>} */
    this.results = {};
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    for (const [method, [name, sample]] of Object.entries(CONTRACTS)) {
      const schema = schemas[name] ?? schemas[`validate${name.replace(/Schema$/, "")}`]?.schema;
      let available = false;
      let explanation = schema
        ? "Installed schema is incompatible with this adapter."
        : `Installed ${name} is unavailable.`;
      if (schema) {
        try {
          const validate = ajv.compile(schema);
          this.validators.set(method, validate);
          this.schemas.set(method, schema);
          available = validate(sample) === true;
          if (available)
            explanation = "Installed request schema verified; live negotiation is still required.";
        } catch {
          explanation = "Installed schema could not be compiled.";
        }
      }
      this.results[method] = { available, reason: source ? explanation : reason };
    }
    for (const name of [
      "ChatEventSchema",
      "AgentEventSchema",
      "HelloOkSchema",
      "AgentsListResultSchema",
      "AgentsFilesGetResultSchema",
      "AgentsFilesSetResultSchema",
      "QuestionRequestedEventSchema",
      "QuestionResolvedEventSchema",
      ...REVIEW_SCHEMAS,
    ]) {
      const schema = schemas[name] ?? schemas[`validate${name.replace(/Schema$/, "")}`]?.schema;
      if (schema) {
        try {
          this.validators.set(name, ajv.compile(schema));
        } catch {
          /* unsupported schema */
        }
      }
    }
    this.digest = createHash("sha256").update(JSON.stringify(schemas)).digest("hex");
  }

  validate(method, params) {
    const validator = this.validators.get(method);
    return !!validator && validator(params) === true;
  }

  capabilities(hello, connected) {
    const methods = new Set(hello?.features?.methods ?? []);
    const scopes = new Set(hello?.auth?.scopes ?? hello?.scopes ?? []);
    const versionMatches = !!this.version && hello?.server?.version === this.version;
    /** @type {Record<string, {available: boolean, reason: string}>} */
    const result = {};
    for (const [method, [, , scope]] of Object.entries(CONTRACTS)) {
      let reason = this.results[method].reason;
      let available = this.results[method].available;
      if (available && !versionMatches) {
        available = false;
        reason = "Gateway version does not match the audited installation.";
      }
      if (available && !connected) {
        available = false;
        reason = "Gateway is disconnected.";
      }
      if (available && !methods.has(method)) {
        available = false;
        reason = "The connected gateway does not advertise this method.";
      }
      if (available && !scopes.has(scope) && !scopes.has("operator.admin")) {
        available = false;
        reason = `Requires ${scope} permission.`;
      }
      if (
        available &&
        method === "chat.send" &&
        (!this.validators.has("ChatEventSchema") || !this.validators.has("AgentEventSchema"))
      ) {
        available = false;
        reason = "Installed execution event schemas could not be verified.";
      }
      result[method] = { available, reason: available ? "Available" : reason };
    }
    result.questions = {
      available:
        !!result["question.resolve"]?.available &&
        this.validators.has("QuestionResolveResultSchema") &&
        (this.validators.has("QuestionRequestedEventSchema") ||
          this.validators.has("QuestionListResultSchema")),
      reason: result["question.resolve"]?.available
        ? "Question resolution requires verified question event/list and result schemas."
        : result["question.resolve"].reason,
    };
    const events = new Set(hello?.features?.events ?? []);
    const eventCapability = (event, schema, scope) => ({
      available:
        connected &&
        versionMatches &&
        events.has(event) &&
        this.validators.has(schema) &&
        (scopes.has(scope) || scopes.has("operator.admin")),
      reason: !this.validators.has(schema)
        ? `Installed ${schema} is unavailable.`
        : !events.has(event)
          ? `Gateway does not advertise ${event}.`
          : !connected
            ? "Gateway is disconnected."
            : !versionMatches
              ? "Gateway version differs from audited installation."
              : `Requires ${scope} permission.`,
    });
    result["approval.events"] = eventCapability(
      "session.approval",
      "SessionApprovalEventSchema",
      "operator.approvals",
    );
    result["question.events"] = eventCapability(
      "question.requested",
      "QuestionRequestedEventSchema",
      "operator.questions",
    );
    result["question.resolvedEvents"] = eventCapability(
      "question.resolved",
      "QuestionResolvedEventSchema",
      "operator.questions",
    );
    result.approvals = {
      available:
        !!result["approval.resolve"]?.available &&
        this.validators.has("ApprovalResolveResultSchema") &&
        this.validators.has("ApprovalSnapshotSchema"),
      reason: result["approval.resolve"]?.available
        ? "Approval resolution requires verified snapshot and result schemas."
        : result["approval.resolve"].reason,
    };
    result["agent.model"] = {
      available:
        !!result["agents.update"]?.available &&
        this.validate("agents.update", { agentId: "audit", model: "audit/model" }),
      reason: "Requires a verified agents.update model field and permission.",
    };
    result["session.model"] = {
      available:
        !!result["sessions.patch"]?.available &&
        this.validate("sessions.patch", {
          key: "agent:main:main",
          agentId: "main",
          model: "audit/model",
        }),
      reason: "Requires a verified sessions.patch model field and permission.",
    };
    for (const key of ["agent.model", "session.model"])
      if (result[key].available) result[key].reason = "Available";
    for (const key of [
      "questions",
      "approvals",
      "approval.events",
      "question.events",
      "question.resolvedEvents",
    ])
      if (result[key].available) result[key].reason = "Available";
    result.roleApply = {
      available:
        this.roleCompareAndSet &&
        !!result["agents.files.get"]?.available &&
        !!result["agents.files.set"]?.available,
      reason: !this.roleCompareAndSet
        ? "Installed backend does not expose a verified conditional instruction update; existing instructions are protected."
        : result["agents.files.set"]?.available
          ? result["agents.files.get"].reason
          : result["agents.files.set"].reason,
    };
    return result;
  }

  report() {
    return {
      version: this.version,
      protocol: this.protocol,
      source: this.source,
      digest: this.digest,
      methods: this.results,
      roleCompareAndSet: this.roleCompareAndSet,
    };
  }
}

/** @param {Record<string, string|undefined>} [env] */
export async function loadInstalledContracts(env = process.env) {
  try {
    const require = createRequire(import.meta.url);
    let modulePath = env.OPENCLAW_PROTOCOL_MODULE ? resolve(env.OPENCLAW_PROTOCOL_MODULE) : null;
    if (!modulePath && env.OPENCLAW_PACKAGE_DIR)
      modulePath = join(resolve(env.OPENCLAW_PACKAGE_DIR), "dist/gateway/protocol/index.js");
    if (!modulePath) {
      try {
        // Resolve an optional host installation at runtime, outside Next's dependency graph.
        modulePath = Reflect.apply(require.resolve, require, ["@openclaw/gateway-protocol"]);
      } catch {
        /* npx installations are also supported */
      }
    }
    if (!modulePath) {
      let expectedVersion;
      try {
        expectedVersion = JSON.parse(
          await readFile(join(homedir(), ".openclaw/openclaw.json"), "utf8"),
        )?.meta?.lastTouchedVersion;
      } catch {
        /* no installation metadata */
      }
      const cache =
        env.npm_config_cache ??
        (process.platform === "win32"
          ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "npm-cache")
          : join(homedir(), ".npm"));
      const entries = await readdir(join(cache, "_npx"), { withFileTypes: true });
      const matches = [];
      for (const entry of entries.filter((entry) => entry.isDirectory()).slice(0, 500)) {
        const pkgPath = join(cache, "_npx", entry.name, "node_modules/openclaw");
        try {
          const pkg = JSON.parse(await readFile(join(pkgPath, "package.json"), "utf8"));
          if (pkg.name === "openclaw" && pkg.version === expectedVersion)
            matches.push(join(pkgPath, "dist/gateway/protocol/index.js"));
        } catch {
          /* another npx package */
        }
      }
      if (matches.length) modulePath = matches.sort()[0];
    }
    if (!modulePath) throw new Error("No installed protocol module");
    let packageDir = dirname(modulePath);
    let version;
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
        if (["openclaw", "@openclaw/gateway-protocol"].includes(pkg.name)) {
          version = pkg.version;
          break;
        }
      } catch {
        /* walk to package root */
      }
      packageDir = dirname(packageDir);
    }
    if (!version) throw new Error("No installed OpenClaw package version found");
    const schemas = await import(/* webpackIgnore: true */ pathToFileURL(modulePath).href);
    return new ContractAudit({
      schemas,
      version,
      protocol: schemas.PROTOCOL_VERSION ?? null,
      source: modulePath,
    });
  } catch {
    return new ContractAudit({
      reason:
        "Installed OpenClaw schemas unavailable. Set OPENCLAW_PROTOCOL_MODULE to the installed gateway protocol JavaScript module, then restart.",
    });
  }
}
