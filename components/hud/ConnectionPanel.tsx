"use client";

import { useEffect, useState } from "react";
import { useStudio } from "@/lib/store";
import { STATUS_LABELS } from "@/lib/constants";
import { getDefaultGatewayUrl, getAgentProvider } from "@/lib/utils";
import { gameEvents } from "@/lib/events";
import HudFlyout from "./HudFlyout";

// The proxy URL routes through the Next.js server, which injects the
// server-side gateway token automatically. Prefer this over a direct
// ws://127.0.0.1:18789 address so users never need to paste a token.
const PROXY_GATEWAY = getDefaultGatewayUrl();
const IS_AUGGIE = getAgentProvider() === "auggie";
const IS_NIGHTSHIFT = getAgentProvider() === "nightshift";

export default function ConnectionPanel() {
  const { state, connect, disconnect } = useStudio();
  const [serverHasToken, setServerHasToken] = useState<boolean | null>(null);
  const isConnected = state.connection === "connected";
  const isConnecting = state.connection === "connecting";
  const isAuthFailed = state.connection === "auth_failed";
  const isDevicePairing = state.connection === ("device_pairing" as typeof state.connection);
  const isUnreachable = state.connection === "unreachable";
  const isRateLimited = state.connection === "rate_limited";
  const isProtocolMismatch = state.connection === "protocol_mismatch";

  const [configFailed, setConfigFailed] = useState(false);
  const [error, setError] = useState("");
  const [scopeWarning, setScopeWarning] = useState(false);

  // Fetch server config to know whether the server has a gateway token.
  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw new Error("Configuration unavailable");
        return r.json();
      })
      .then((data: { hasToken?: boolean }) => {
        setServerHasToken(!!data.hasToken);
      })
      .catch(() => setConfigFailed(true));
  }, []);

  useEffect(() => {
    return gameEvents.on("scope-denied", () => {
      setScopeWarning(true);
    });
  }, []);

  const handleDisconnectAndReconfigure = () => {
    disconnect();
    setScopeWarning(false);
  };

  const handleConnect = () => {
    setError("");
    setScopeWarning(false);
    connect({ url: PROXY_GATEWAY });
  };

  return (
    <HudFlyout
      title="Connection"
      subtitle={`${STATUS_LABELS[state.connection] ?? state.connection}${IS_AUGGIE ? " (Auggie)" : IS_NIGHTSHIFT ? " (Nightshift)" : " gateway link"}`}
    >
      <div className="hud-panel__stack">
        {state.connection === "connected" &&
          state.capabilities?.["chat.send"]?.available === false && (
            <div className="workspace-setup-note" role="status">
              <strong>Connected · setup required</strong>
              <p>The gateway is reachable, but task execution is not available yet.</p>
              <details>
                <summary>Setup details</summary>
                <p>{state.capabilities["chat.send"].reason}</p>
              </details>
            </div>
          )}
        {IS_NIGHTSHIFT && (
          <>
            <div className="hud-panel__label">Nightshift runtime</div>
            <p style={{ color: isConnected ? "#6fcf97" : "#f0c040", fontSize: "8px", margin: 0 }}>
              {configFailed
                ? "Could not check Nightshift configuration. Try connecting again."
                : serverHasToken === null
                  ? "Checking Nightshift configuration…"
                  : !serverHasToken
                    ? "Set the server-only NIGHTSHIFT_API_KEY from your runtime's proxy-token file, then restart Agent Town."
                    : isConnected
                      ? "Nightshift is connected. Model discovery succeeded."
                      : "Nightshift token is configured, but the runtime is not connected. Start a supported Meterless runtime and check NIGHTSHIFT_BASE_URL, then connect again."}
            </p>
          </>
        )}
        {!IS_AUGGIE && !IS_NIGHTSHIFT && (
          <>
            <div className="hud-panel__label">Server-managed gateway</div>
            {configFailed ? (
              <p role="status">
                Could not check gateway configuration. You can still try connecting.
              </p>
            ) : serverHasToken === null ? (
              <p role="status">Checking gateway configuration…</p>
            ) : serverHasToken ? (
              <p style={{ color: "#6fcf97", margin: 0 }}>
                Gateway authentication is configured securely on the server.
              </p>
            ) : (
              <p style={{ color: "#f0c040", margin: 0 }}>
                No server-side gateway token was found. Configure OpenClaw locally or set the
                server-only <code>GATEWAY_TOKEN</code> environment variable, then restart Agent
                Town.
              </p>
            )}
          </>
        )}

        {IS_AUGGIE && !isConnected && !isConnecting && (
          <p style={{ color: "var(--pixel-muted)" }}>
            Using Auggie CLI as agent provider. Make sure <code>auggie</code> is installed and
            authenticated.
          </p>
        )}

        {/* Scope warning — shown while still connected so user knows what to do */}
        {scopeWarning && isConnected && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <p style={{ color: "#f0c040", margin: 0 }}>
              Connected read-only — write access denied. Configure a full-access token on the
              server, then reconnect.
              <br />
              Gateway credentials are never accepted or stored by the browser.
            </p>
            <button
              type="button"
              className="pixel-button"
              style={{}}
              onClick={handleDisconnectAndReconfigure}
            >
              Disconnect
            </button>
          </div>
        )}

        {isAuthFailed && !error && (
          <p style={{ color: "var(--pixel-red)", fontSize: "8px" }}>
            {IS_NIGHTSHIFT
              ? "Nightshift rejected or is missing the server token. Check NIGHTSHIFT_API_KEY and reconnect."
              : "Authentication failed. Check the server-side gateway configuration and reconnect."}
          </p>
        )}
        {isDevicePairing && !error && (
          <p style={{ color: "#f0c040" }}>
            Gateway requires device approval. Open your OpenClaw app and approve the connection
            request, then click Connect again.
          </p>
        )}
        {isUnreachable && !error && (
          <p style={{ color: "var(--pixel-red)" }}>
            Gateway is unreachable. Check if your gateway is running.
          </p>
        )}
        {isRateLimited && !error && (
          <p style={{ color: "var(--pixel-red)" }}>
            Too many failed attempts. Please wait a moment before retrying.
          </p>
        )}
        {isProtocolMismatch && !error && (
          <p style={{ color: "var(--pixel-red)" }}>
            Gateway protocol version is not supported. Please update Agent Town or your gateway.
          </p>
        )}
        {error && <p style={{ color: "var(--pixel-red)" }}>{error}</p>}

        {!isConnected && !isConnecting ? (
          <button
            type="button"
            className="pixel-button pixel-button--primary"
            onClick={handleConnect}
          >
            Connect
          </button>
        ) : null}
        {isConnected ? (
          <button type="button" className="pixel-button" onClick={disconnect}>
            Disconnect
          </button>
        ) : null}
        {isConnecting ? (
          <button type="button" className="pixel-button" onClick={disconnect}>
            Cancel
          </button>
        ) : null}
      </div>
    </HudFlyout>
  );
}
