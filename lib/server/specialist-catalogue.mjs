import { assertOperationContract } from "../operations-contracts.mjs";

// Reviewed configuration only. These identifiers describe permitted capabilities; they
// do not install tools, grant credentials, or create a backend agent.
const entries = [
  {
    manifest: {
      id: "planner",
      version: "1.0.0",
      source: "builtin-template",
      provider: "openclaw",
      capabilities: ["decompose_task", "plan_dependencies"],
      skills: ["task-planning"],
      // No sessions_spawn: a spawned sub-agent's tools would escape the reviewed scope check.
      tools: ["agent.message", "openclaw.sessions.list", "openclaw.sessions.status"],
      permissions: { dataAccess: "none", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 2, maxRuntimeSeconds: 300, maxToolCalls: 4 },
    },
    mayMessage: ["data-steward-researcher", "executor", "critic"],
  },
  {
    manifest: {
      id: "data-steward-researcher",
      version: "1.0.0",
      source: "builtin-template",
      provider: "openclaw",
      capabilities: ["read_operational_records", "research_external_sources"],
      skills: ["source-checking"],
      tools: [
        "zetaris.read",
        "tavily.search",
        "tavily.extract",
        "openclaw.web_search",
        "openclaw.web_fetch",
        "openclaw.browser",
        "agent.message",
      ],
      permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 2, maxRuntimeSeconds: 300, maxToolCalls: 8 },
    },
    mayMessage: ["planner", "executor", "critic"],
  },
  {
    manifest: {
      id: "executor",
      version: "1.0.0",
      source: "builtin-template",
      provider: "openclaw",
      capabilities: ["execute_approved_action", "report_execution"],
      skills: ["controlled-execution"],
      tools: ["approval.gateway", "agent.message"],
      permissions: { dataAccess: "scoped_write", sensitiveWrites: "approval_required" },
      limits: { maxRetries: 0, maxParallelTasks: 1, maxRuntimeSeconds: 180, maxToolCalls: 2 },
    },
    mayMessage: ["planner", "data-steward-researcher", "critic"],
  },
  {
    manifest: {
      id: "critic",
      version: "1.0.0",
      source: "builtin-template",
      provider: "openclaw",
      capabilities: ["challenge_hypothesis", "verify_evidence"],
      skills: ["evidence-review"],
      tools: ["evidence.read", "openclaw.sessions.history", "agent.message"],
      permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 1, maxRuntimeSeconds: 240, maxToolCalls: 4 },
    },
    mayMessage: ["planner", "data-steward-researcher", "executor"],
  },
  {
    manifest: {
      id: "maintenance-specialist",
      version: "1.0.0",
      source: "builtin-template",
      provider: "openclaw",
      capabilities: ["review_maintenance_history"],
      skills: ["equipment-manual-review"],
      tools: [],
      permissions: { dataAccess: "none", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 1, maxRuntimeSeconds: 300, maxToolCalls: 0 },
    },
    mayMessage: [],
  },
  ...[
    ["nightshift-planner", "decompose_task", "task-planning"],
    ["nightshift-analyst", "analyze_evidence", "evidence-analysis"],
    ["nightshift-critic", "verify_evidence", "evidence-review"],
  ].map(([id, capability, skill]) => ({
    manifest: {
      id,
      version: "1.0.0",
      source: "builtin-template",
      provider: "meterless-nightshift",
      capabilities: [capability],
      skills: [skill],
      tools: [],
      permissions: { dataAccess: "none", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 1, maxRuntimeSeconds: 180, maxToolCalls: 0 },
    },
    mayMessage: [],
  })),
];

export function validateCatalogue(catalogue) {
  if (!Array.isArray(catalogue) || !catalogue.length || catalogue.length > 32)
    throw new Error("Invalid specialist catalogue.");
  const ids = new Set();
  const validated = catalogue.map((entry) => {
    if (!entry || Object.keys(entry).some((key) => !["manifest", "mayMessage"].includes(key)))
      throw new Error("Invalid specialist entry.");
    const manifest = assertOperationContract("agentManifest", entry.manifest);
    if (ids.has(manifest.id)) throw new Error("Duplicate specialist manifest ID.");
    ids.add(manifest.id);
    if (
      !Array.isArray(entry.mayMessage) ||
      entry.mayMessage.some((id) => typeof id !== "string" || id === manifest.id) ||
      (entry.mayMessage.length && !manifest.tools.includes("agent.message"))
    )
      throw new Error("Invalid specialist communication policy.");
    return {
      manifest: structuredClone(manifest),
      mayMessage: [...new Set(entry.mayMessage)],
    };
  });
  if (validated.some((entry) => entry.mayMessage.some((id) => !ids.has(id))))
    throw new Error("Specialist communication target is not reviewed.");
  return validated;
}

export const SPECIALIST_CATALOGUE = validateCatalogue(entries);
