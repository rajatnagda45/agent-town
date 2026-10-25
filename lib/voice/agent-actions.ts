export const VOICE_ACTIONS = new Set([
  "assign_task",
  "get_agent_context",
  "get_task_progress",
  "cancel_task",
  "open_pending_review",
]);

/** All routing, permissions, task state and review scope are resolved by the server. */
export async function runVoiceAgentTool(
  tool: string,
  args: Record<string, unknown>,
  invoke: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!VOICE_ACTIONS.has(tool))
    return {
      error:
        "Unsupported voice action. Approvals and answers require explicit user action in the review dialog.",
    };
  return invoke(tool, args);
}
