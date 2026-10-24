import type { SeatState } from "@/types/game";

/** Resolve the conversation once for text, voice, terminals, and session switches. */
export function boundConversationSession(
  seat: SeatState | undefined,
  active?: string,
  preferred?: string,
) {
  const binding = seat?.binding;
  if (!binding?.agentId) return undefined;
  if (active?.split(":")[1] === binding.agentId && active.startsWith("agent:")) return active;
  if (preferred?.split(":")[1] === binding.agentId && preferred.startsWith("agent:"))
    return preferred;
  return binding.sessionKey ?? undefined;
}
