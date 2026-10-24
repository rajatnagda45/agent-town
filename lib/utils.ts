import type { AgentProvider } from "@/types/game";

/**
 * Returns the configured agent provider.
 * Set via NEXT_PUBLIC_AGENT_PROVIDER env var (available client-side).
 */
export function getAgentProvider(): AgentProvider {
  const val = process.env.NEXT_PUBLIC_AGENT_PROVIDER;
  if (val === "auggie") return "auggie";
  if (val === "nightshift") return "nightshift";
  return "openclaw";
}

export function getDefaultGatewayUrl() {
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/api/gateway`;
  }

  return "ws://localhost:3000/api/gateway";
}
