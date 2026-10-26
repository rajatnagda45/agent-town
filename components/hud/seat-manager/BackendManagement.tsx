"use client";

import { useRef, useState } from "react";
import type { AgentConfig, ManagementOperation, SeatState } from "@/types/game";
import { runtimeRequest, useStudio } from "@/lib/store";
import "../execution-controls.css";

interface SessionConfig {
  key: string;
  agentId: string;
  configRevision: string;
  effectiveModel: string | null;
  modelOverride?: string;
  overrideKnown: boolean;
}

export default function BackendManagement({
  seat,
  agentId,
  onRefresh,
}: {
  seat: SeatState;
  agentId?: string;
  onRefresh: () => Promise<void>;
}) {
  const { state, reconcile } = useStudio();
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const agent = state.management?.agents.find((agent) => agent.agentId === agentId);
  const sessionKey = state.activeSessionKey?.startsWith(`agent:${agentId}:`)
    ? state.activeSessionKey
    : seat.binding?.agentId === agentId
      ? seat.binding?.sessionKey
      : undefined;
  // Every assigned seat bound to this backend agent runs as the same execution identity.
  const sharing = (state.seats ?? []).filter(
    (item) => item.assigned && item.binding?.agentId === agentId,
  );
  return (
    <section className="backend-management" aria-label="Backend agent configuration">
      <h3>Backend agents and models</h3>
      {sharing.length > 1 && (
        <p className="control-note" role="alert">
          Shared backend agent <strong>{agentId}</strong>:{" "}
          {sharing.map((item) => item.label).join(", ")} are one execution identity. Changing its
          model or settings below affects all {sharing.length} seats, not only {seat.label}.
          Separate sessions are separate contexts, not independent agents.
        </p>
      )}
      <p className="control-note">
        Workers share backend agent <strong>{state.sharedAgentId ?? "main"}</strong>. Their names,
        portraits and local roles do not create separate agents. Independent seats bind to distinct
        discovered agents.
      </p>
      <AgentEditor
        key={`${seat.seatId}:${agent?.agentId}:${agent?.configRevision}`}
        agent={agent}
        sessionKey={sessionKey ?? undefined}
        onRefresh={async () => {
          await reconcile();
          await onRefresh();
        }}
      />
      <details>
        <summary>Create a backend agent</summary>
        <CreateAgent
          onRefresh={async () => {
            await reconcile();
            await onRefresh();
          }}
        />
      </details>
      <button
        type="button"
        className="pixel-button"
        disabled={refreshing}
        onClick={async () => {
          setRefreshing(true);
          setRefreshError("");
          try {
            await reconcile();
            await onRefresh();
          } catch (error) {
            setRefreshError(error instanceof Error ? error.message : "Backend refresh failed.");
          } finally {
            setRefreshing(false);
          }
        }}
      >
        Refresh backend state
      </button>
      {refreshError && <p role="alert">{refreshError}</p>}
      {(state.management?.operations ?? [])
        .slice(-8)
        .reverse()
        .map((op) => (
          <p key={op.id} role="status">
            {op.method} · {op.agentId ?? "new agent"} · {op.status}
            {op.error ? `: ${op.error}` : ""}
          </p>
        ))}
    </section>
  );
}

function useMutation(onRefresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const mutate = async (
    method: string,
    params: Record<string, unknown>,
    configRevision?: string,
  ) => {
    if (busy) return;
    const fingerprint = JSON.stringify({ method, params, configRevision });
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, id: crypto.randomUUID() };
    setBusy(true);
    setMessage("");
    try {
      const { operation } = await runtimeRequest<{ operation: ManagementOperation }>("management", {
        method,
        params,
        configRevision,
        operationId: attempt.current.id,
      });
      setMessage(
        operation.status === "confirmed"
          ? "Backend change confirmed. Refreshed from gateway state."
          : (operation.error ?? "Change is pending backend confirmation."),
      );
      if (["confirmed", "rejected"].includes(operation.status)) attempt.current = null;
      await onRefresh();
      return operation;
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Backend change could not be confirmed. Refresh before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, message, mutate };
}

function CreateAgent({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { state } = useStudio();
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState("");
  const { busy, message, mutate } = useMutation(onRefresh);
  const cap = state.capabilities?.["agents.create"];
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutate("agents.create", {
          name: name.trim(),
          ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
        });
      }}
    >
      <p>
        Creates a real backend agent only when you press Create. Bind it to an independent seat
        afterward.
      </p>
      <label>
        Backend agent name
        <input
          aria-label="New backend agent name"
          required
          maxLength={256}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Workspace (optional)
        <input
          aria-label="New agent workspace"
          maxLength={4096}
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
        />
      </label>
      {!cap?.available && <p>{cap?.reason ?? "Agent creation has not been verified."}</p>}
      <div className="control-actions">
        <button
          type="submit"
          className="pixel-button"
          disabled={busy || !cap?.available || !name.trim()}
        >
          Create backend agent
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </form>
  );
}

function AgentEditor({
  agent,
  sessionKey,
  onRefresh,
}: {
  agent?: AgentConfig;
  sessionKey?: string;
  onRefresh: () => Promise<void>;
}) {
  const { state } = useStudio();
  const [name, setName] = useState(agent?.name ?? "");
  const [workspace, setWorkspace] = useState(agent?.workspace ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [models, setModels] = useState<Array<{ id: string; name: string; verification: string }>>(
    [],
  );
  const [note, setNote] = useState("");
  const [session, setSession] = useState<SessionConfig>();
  const [sessionModel, setSessionModel] = useState("");
  const [loading, setLoading] = useState(false);
  const { busy, message, mutate } = useMutation(onRefresh);
  if (!agent) return <p>Select a discovered agent to edit its backend settings.</p>;
  const outstanding = state.tasks.some(
    (task) =>
      task.agentId === agent.agentId &&
      !["completed", "failed", "stopped", "interrupted"].includes(task.status),
  );
  const unresolved = state.management?.operations.some(
    (op) => op.agentId === agent.agentId && ["sending", "outcome_unknown"].includes(op.status),
  );
  const disabled = busy || loading || outstanding || unresolved;
  const updateCap = state.capabilities?.["agents.update"];
  const loadModels = async () => {
    setLoading(true);
    setNote("");
    try {
      const result = await runtimeRequest<{ models: typeof models; note: string }>(
        `models?agentId=${encodeURIComponent(agent.agentId)}`,
      );
      setModels(result.models);
      setNote(result.note);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Model listing unavailable.");
    } finally {
      setLoading(false);
    }
  };
  const modelOptions = (
    <>
      <option value="">Use gateway / agent default</option>
      {agent.model && !models.some((m) => m.id === agent.model) && (
        <option value={agent.model}>{agent.model} · current, unverified</option>
      )}
      {models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.id} · listed, unverified
        </option>
      ))}
    </>
  );
  return (
    <>
      <p>
        <strong>Backend agent:</strong> {agent.agentId}{" "}
        {agent.agentId === state.sharedAgentId && "· Changes affect all shared workers."}
      </p>
      {(outstanding || unresolved) && (
        <p>
          Editing is blocked while this agent has outstanding work or an unresolved configuration
          change.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const params: Record<string, unknown> = { agentId: agent.agentId };
          if (name.trim() && name.trim() !== agent.name) params.name = name.trim();
          if (workspace.trim() && workspace.trim() !== agent.workspace)
            params.workspace = workspace.trim();
          if (model !== (agent.model ?? "")) params.model = model || null;
          void mutate("agents.update", params, agent.configRevision);
        }}
      >
        <label>
          Backend name
          <input
            aria-label="Backend agent name"
            maxLength={256}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          Backend workspace
          <input
            aria-label="Backend agent workspace"
            maxLength={4096}
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          Agent-default model
          <select
            aria-label="Agent default model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={disabled || !state.capabilities?.["agent.model"]?.available}
          >
            {modelOptions}
          </select>
        </label>
        {!state.capabilities?.["agent.model"]?.available && (
          <p>{state.capabilities?.["agent.model"]?.reason}</p>
        )}
        {!updateCap?.available && <p>{updateCap?.reason ?? "Agent editing unavailable."}</p>}
        <div className="control-actions">
          <button
            className="pixel-button"
            type="submit"
            disabled={disabled || !updateCap?.available}
          >
            Save backend agent
          </button>
          <button
            className="pixel-button"
            type="button"
            disabled={loading || !state.capabilities?.["models.list"]?.available}
            onClick={() => void loadModels()}
          >
            Load gateway models
          </button>
        </div>
      </form>
      <p className="control-note">
        Model listings and saved defaults do not prove authentication, billing or execution works.
        No paid model probe is run.
      </p>
      {note && <p role="status">{note}</p>}
      {sessionKey && (
        <details>
          <summary>Session model override</summary>
          <p>
            This changes only <strong>{sessionKey}</strong>. The agent default is separate.
          </p>
          <button
            type="button"
            className="pixel-button"
            disabled={loading || !state.capabilities?.["sessions.list"]?.available}
            onClick={async () => {
              setLoading(true);
              setNote("");
              try {
                const result = await runtimeRequest<SessionConfig>(
                  `session-config?key=${encodeURIComponent(sessionKey)}&agentId=${encodeURIComponent(agent.agentId)}`,
                );
                setSession(result);
                setSessionModel(result.overrideKnown ? (result.modelOverride ?? "") : "__choose__");
              } catch (error) {
                setNote(error instanceof Error ? error.message : "Session state unavailable.");
              } finally {
                setLoading(false);
              }
            }}
          >
            Load session configuration
          </button>
          {session && session.key === sessionKey && (
            <>
              <p>Effective model: {session.effectiveModel ?? "Not exposed by gateway"}</p>
              {!session.overrideKnown && (
                <p className="control-note">
                  The backend listing does not expose the current override. Choose a model or
                  explicitly clear the override; the effective model alone does not identify its
                  source.
                </p>
              )}
              <label>
                Session override
                <select
                  aria-label="Session model override"
                  value={sessionModel}
                  disabled={disabled || !state.capabilities?.["session.model"]?.available}
                  onChange={(event) => setSessionModel(event.target.value)}
                >
                  {modelOptions}
                  {!session.overrideKnown && (
                    <option value="__choose__" disabled>
                      Choose an override or clear it explicitly
                    </option>
                  )}
                  {session.modelOverride &&
                    session.modelOverride !== agent.model &&
                    !models.some((model) => model.id === session.modelOverride) && (
                      <option value={session.modelOverride}>
                        {session.modelOverride} · current, unverified
                      </option>
                    )}
                </select>
              </label>
              <div className="control-actions">
                <button
                  type="button"
                  className="pixel-button"
                  disabled={
                    disabled ||
                    sessionModel === "__choose__" ||
                    !state.capabilities?.["session.model"]?.available
                  }
                  onClick={async () => {
                    const operation = await mutate(
                      "sessions.patch",
                      { key: session.key, agentId: agent.agentId, model: sessionModel || null },
                      session.configRevision,
                    );
                    if (operation?.status !== "confirmed") return;
                    setLoading(true);
                    try {
                      const current = await runtimeRequest<SessionConfig>(
                        `session-config?key=${encodeURIComponent(session.key)}&agentId=${encodeURIComponent(agent.agentId)}`,
                      );
                      setSession(current);
                      setSessionModel(
                        current.overrideKnown ? (current.modelOverride ?? "") : "__choose__",
                      );
                    } catch (error) {
                      setNote(
                        error instanceof Error
                          ? error.message
                          : "The change was confirmed, but current session settings could not be reloaded.",
                      );
                    } finally {
                      setLoading(false);
                    }
                  }}
                >
                  Save session override
                </button>
              </div>
            </>
          )}
          {!state.capabilities?.["session.model"]?.available && (
            <p>
              {state.capabilities?.["session.model"]?.reason ??
                "Session model configuration unavailable."}
            </p>
          )}
        </details>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
