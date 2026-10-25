/** Server-side policy for text-only Nightshift specialists.
 * Registry still owns reviewed grants, concurrency, retries and deadline timers. */
export function createNightshiftEnforcement(runtime) {
  return {
    authorizeSync({ manifest, assignment, task }) {
      const limits = runtime.gateway.reasoningLimits?.();
      if (
        runtime.gateway.provider !== "nightshift" ||
        runtime.gateway.status !== "connected" ||
        manifest?.provider !== "meterless-nightshift" ||
        manifest.permissions?.sensitiveWrites !== "denied" ||
        manifest.permissions?.dataAccess !== "none" ||
        manifest.tools?.length !== 0 ||
        manifest.limits?.maxToolCalls !== 0 ||
        manifest.limits?.maxParallelTasks !== 1 ||
        !limits ||
        limits.maxToolCalls !== 0 ||
        !Number.isSafeInteger(limits.maxRuntimeSeconds) ||
        !Number.isSafeInteger(limits.maxRequestChars) ||
        !Number.isSafeInteger(limits.maxResponseBytes) ||
        !Number.isSafeInteger(limits.maxOutputTokens) ||
        limits.maxRuntimeSeconds > 180 ||
        limits.maxRequestChars > 16000 ||
        limits.maxResponseBytes > 32768 ||
        limits.maxOutputTokens > 1024 ||
        !Number.isSafeInteger(manifest.limits?.maxRuntimeSeconds) ||
        manifest.limits.maxRuntimeSeconds < 1 ||
        manifest.limits.maxRuntimeSeconds > limits.maxRuntimeSeconds ||
        typeof task?.message !== "string" ||
        task.message.length > 8000 ||
        !Number.isSafeInteger(task?.retryCount ?? 0) ||
        (task.retryCount ?? 0) > manifest.limits.maxRetries
      )
        return false;
      let context;
      try {
        context = runtime.gateway.verifiedReasoningContext?.(assignment.sessionKey, assignment);
      } catch {
        return false;
      }
      const expectedRole = {
        "nightshift-planner": "planner",
        "nightshift-analyst": "analyst",
        "nightshift-critic": "critic",
      }[manifest.id];
      return (
        !!context &&
        context.role === expectedRole &&
        context.seatId === assignment.seatId &&
        context.sessionKey === assignment.sessionKey &&
        context.bindingRevision === assignment.bindingRevision &&
        context.agentId === assignment.agentId &&
        assignment.gatewayId === runtime.gatewayId
      );
    },
  };
}
