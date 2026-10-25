const reasoningOnly = { dataAccess: "none", sensitiveWrites: "denied" };
const readOnly = { dataAccess: "read_only", sensitiveWrites: "denied" };

/** Reviewed capability requirements per reasoning stage. Alternatives cover the reviewed
 * Nightshift and OpenClaw templates; the router picks among eligible, authorized options. */
export const STAGE_REQUIREMENTS = {
  planner: {
    anyOf: [{ capabilities: ["decompose_task"], tools: [], permissions: reasoningOnly }],
  },
  analyst: {
    anyOf: [
      { capabilities: ["analyze_evidence"], tools: [], permissions: reasoningOnly },
      { capabilities: ["read_operational_records"], tools: [], permissions: readOnly },
    ],
  },
  critic: {
    anyOf: [
      { capabilities: ["verify_evidence"], tools: [], permissions: reasoningOnly },
      { capabilities: ["verify_evidence"], tools: [], permissions: readOnly },
    ],
  },
};

/** Resolve a stage to one concrete role and requirement alternative, routed or not.
 * Routed mode checks per-task enforcement with the real message; unrouted mode keeps the
 * primary registry's reviewed selection. Returns null when nothing is eligible. */
export function resolveStage(operations, stage, message, policy = null) {
  const rejected = [];
  for (const reviewed of STAGE_REQUIREMENTS[stage].anyOf) {
    // A provider policy (e.g. allowedRuntimes for a transfer) only narrows routed selection.
    const requirements = policy && operations.routed ? { ...reviewed, ...policy } : reviewed;
    const selection = operations.routed
      ? operations.routing.selectTask({ requirements, task: { message, retryCount: 0 } })
      : operations.registry.selectTask({ requirements });
    if (selection.status === "assigned")
      return {
        role: selection.manifest.id,
        requirements,
        executionDecision: selection.executionDecision,
      };
    rejected.push(selection.reason ?? selection.status);
  }
  return { role: null, reason: [...new Set(rejected)].join("; ") };
}
