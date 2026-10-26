"use client";
import { RuntimeNotice } from "@/components/ui/RuntimeNotice";
import "./seat-manager.css";
import { useEffect, useState, useCallback } from "react";
import { X, Users } from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import { WORKER_SPRITES } from "@/components/game/config/animations";
import type { SeatState, SeatType, AgentConfig } from "@/types/game";
import { getAgentProvider } from "@/lib/utils";
import { useDialog } from "@/components/ui/useDialog";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import SeatList from "./seat-manager/SeatList";
import SeatDetailPanel from "./seat-manager/SeatDetailPanel";

import BackendManagement from "./seat-manager/BackendManagement";

const IS_AUGGIE = getAgentProvider() === "auggie";
type Draft = {
  name: string;
  role: string;
  spriteKey: string;
  spritePath: string;
  type: SeatType;
  agent?: AgentConfig;
};
function fromSeat(seat: SeatState): Draft {
  return {
    name: seat.assigned ? seat.label : "",
    role: seat.roleTitle ?? "",
    spriteKey: seat.spriteKey ?? WORKER_SPRITES[0]?.key ?? "",
    spritePath: seat.spritePath ?? WORKER_SPRITES[0]?.path ?? "",
    type: seat.seatType ?? "worker",
    agent: seat.agentConfig,
  };
}

export default function SeatManagerModal(props: {
  open: boolean;
  onClose: () => void;
  seats: SeatState[];
}) {
  // Mount a fresh editing session each time; no stale draft survives a closed dialog.
  return props.open ? <TeamWorkspace {...props} /> : null;
}
function TeamWorkspace({ onClose, seats }: { onClose: () => void; seats: SeatState[] }) {
  const { state, updateSeatConfig } = useStudio();
  const [saving, setSaving] = useState(false);
  const [rolePreview, setRolePreview] = useState<{
    seatId: string;
    hash: string;
    current: string;
    proposed: string;
    revision: number;
  } | null>(null);
  const [selectedId, setSelectedId] = useState(seats[0]?.seatId ?? "");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<"close" | "unassign" | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentError, setAgentError] = useState("");
  const [reload, setReload] = useState(0);
  const selected = seats.find((s) => s.seatId === selectedId) ?? seats[0];
  const dirtyIds = Object.keys(drafts).filter((id) => {
    const seat = seats.find((s) => s.seatId === id);
    return seat && JSON.stringify(drafts[id]) !== JSON.stringify(fromSeat(seat));
  });
  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirtyIds.length) setConfirmation("close");
    else onClose();
  }, [dirtyIds.length, onClose, saving]);
  const ref = useDialog(true, requestClose);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agents/discover", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("Agent discovery is unavailable. Try again.");
        const data = await res.json();
        setAgents(
          Array.isArray(data.agents)
            ? data.agents.filter((agent: AgentConfig) => agent.agentId !== data.sharedAgentId)
            : [],
        );
      })
      .catch((err) => {
        if (!controller.signal.aborted) setAgentError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAgentsLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  if (!selected) return null;
  const draft = drafts[selected.seatId] ?? fromSeat(selected);
  const busy =
    saving ||
    selected.status === "running" ||
    selected.status === "returning" ||
    state.tasks.some(
      (task) =>
        task.seatId === selected.seatId &&
        !["completed", "failed", "stopped", "interrupted"].includes(task.status),
    );
  const usedAgentIds = new Set(
    seats
      .filter((s) => s.seatId !== selected.seatId && s.assigned && s.seatType === "agent")
      .map((s) => s.agentConfig?.agentId ?? ""),
  );
  const valid = !!(
    state.capabilities?.["agents.list"]?.available &&
    draft.name.trim() &&
    draft.role.trim() &&
    draft.spriteKey &&
    draft.spritePath &&
    !busy &&
    (draft.type !== "agent" ||
      (!IS_AUGGIE && draft.agent?.agentId && !usedAgentIds.has(draft.agent.agentId)))
  );
  const patch = (value: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [selected.seatId]: { ...draft, ...value } }));
    setNotice("");
    setError("");
  };
  const reset = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[selected.seatId];
      return next;
    });
    setError("");
    setNotice("Changes reset for this seat.");
  };
  const save = async () => {
    if (!valid) {
      setError(
        "Enter a name and role, choose a character, and select an available agent if needed.",
      );
      return;
    }
    setSaving(true);
    try {
      await updateSeatConfig(selected.seatId, {
        assigned: true,
        label: draft.name.trim(),
        roleTitle: draft.role.trim(),
        spriteKey: draft.spriteKey,
        spritePath: draft.spritePath,
        seatType: draft.type,
        agentConfig: draft.type === "agent" ? draft.agent : undefined,
      });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[selected.seatId];
        return next;
      });
      setNotice(`${draft.name.trim()} saved.`);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this profile. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const unassign = async () => {
    if (busy) {
      setConfirmation(null);
      return;
    }
    setSaving(true);
    try {
      await updateSeatConfig(selected.seatId, {
        assigned: false,
        seatType: "worker",
        roleTitle: undefined,
        spriteKey: undefined,
        spritePath: undefined,
        agentConfig: undefined,
      });
      reset();
      setNotice("Seat is now available.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not unassign this seat. Try again.");
    } finally {
      setSaving(false);
    }
    setConfirmation(null);
  };
  const count = seats.filter((s) => s.assigned).length;
  return (
    <div
      className="seat-manager-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={ref}
        className="seat-manager pixel-panel"
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => event.stopPropagation()}
        aria-label="Team Management"
        tabIndex={-1}
      >
        <header className="seat-manager__header">
          <div className="team-heading">
            <span className="team-heading__icon">
              <Users size={22} />
            </span>
            <div>
              <h1>Team Management</h1>
              <p>Build your team. Give every seat a purpose.</p>
            </div>
          </div>
          <div className="team-capacity">
            <strong>
              {count}
              <span> / {seats.length}</span>
            </strong>
            <span>{seats.length - count} seats available</span>
          </div>
          <button
            className="pixel-icon-btn"
            onClick={requestClose}
            aria-label="Close seat manager"
            title="Close"
          >
            <X size={18} />
          </button>
        </header>
        <SeatList
          seats={seats}
          selectedSeatId={selected.seatId}
          dirtyIds={dirtyIds}
          onSelectSeat={(s) => {
            if (saving) return;
            setRolePreview(null);
            setSelectedId(s.seatId);
            setNotice("");
            setError("");
          }}
        />
        <div className="team-editor">
          <div className="team-editor__scroll">
            <div className="team-editor__toolbar">
              <span className="ui-eyebrow">Profile & appearance</span>
              <div className="ui-segmented" role="group" aria-label="Seat type">
                {(["worker", "agent"] as const).map((type) => (
                  <button
                    key={type}
                    aria-pressed={draft.type === type}
                    disabled={busy}
                    onClick={() =>
                      patch({ type, agent: type === "worker" ? undefined : draft.agent })
                    }
                  >
                    {type === "worker" ? "Worker" : "Agent"}
                  </button>
                ))}
              </div>
            </div>
            {!state.capabilities?.["agents.list"]?.available && (
              <RuntimeNotice
                detail={
                  state.capabilities?.["agents.list"]?.reason ??
                  "Backend contracts have not been verified."
                }
              />
            )}
            {selected.seatType === "agent" && (
              <div>
                <button
                  className="pixel-button"
                  disabled={busy || !state.capabilities?.roleApply?.available}
                  title={state.capabilities?.roleApply?.reason}
                  onClick={async () => {
                    try {
                      const preview = await runtimeRequest<{
                        hash: string;
                        current: string;
                        proposed: string;
                        revision: number;
                      }>(`seats/${encodeURIComponent(selected.seatId)}/role`, {
                        revision: selected.binding?.revision,
                      });
                      setRolePreview({ ...preview, seatId: selected.seatId });
                    } catch (error) {
                      setError(error instanceof Error ? error.message : "Role preview failed");
                    }
                  }}
                >
                  Apply saved role to backend
                </button>
                {!state.capabilities?.roleApply?.available && (
                  <p>
                    {state.capabilities?.roleApply?.reason ??
                      "Backend role updates are unsupported."}
                  </p>
                )}
                {rolePreview &&
                  rolePreview.seatId === selected.seatId &&
                  rolePreview.revision === selected.binding?.revision && (
                    <div>
                      <p>Review the backend instructions before applying:</p>
                      <pre style={{ maxHeight: 180, overflow: "auto", whiteSpace: "pre-wrap" }}>
                        {rolePreview.proposed}
                      </pre>
                      <button
                        className="pixel-button"
                        onClick={async () => {
                          try {
                            await runtimeRequest(
                              `seats/${encodeURIComponent(rolePreview.seatId)}/role`,
                              { revision: rolePreview.revision, expectedHash: rolePreview.hash },
                            );
                            setRolePreview(null);
                            setError("Backend role applied.");
                          } catch (error) {
                            setError(error instanceof Error ? error.message : "Role update failed");
                          }
                        }}
                      >
                        Apply reviewed instructions
                      </button>
                      <button className="pixel-button" onClick={() => setRolePreview(null)}>
                        Cancel
                      </button>
                    </div>
                  )}
              </div>
            )}
            <SeatDetailPanel
              selectedSeat={selected}
              effectiveName={draft.name}
              effectiveRoleTitle={draft.role}
              effectiveSpriteKey={draft.spriteKey}
              effectiveSpritePath={draft.spritePath}
              effectiveSeatType={draft.type}
              effectiveAgentConfig={draft.agent}
              busy={busy}
              agentsLoading={agentsLoading}
              discoveredAgents={agents}
              usedAgentIds={usedAgentIds}
              onNameChange={(name) => patch({ name })}
              onRoleTitleChange={(role) => patch({ role })}
              onSpriteSelect={(spriteKey, spritePath, name) =>
                patch({ spriteKey, spritePath, name: draft.name.trim() ? draft.name : name })
              }
              onSelectAgent={(agent) =>
                patch({
                  agent,
                  type: "agent",
                  name: agent.identity?.name ?? agent.agentId,
                  role: "Independent Agent",
                })
              }
              isAuggie={IS_AUGGIE}
            />
            <BackendManagement
              seat={selected}
              agentId={
                draft.type === "agent" ? draft.agent?.agentId : (state.sharedAgentId ?? "main")
              }
              onRefresh={async () => {
                setAgentsLoading(true);
                setReload((n) => n + 1);
              }}
            />
          </div>
          <div className="team-actions">
            <button
              className="pixel-button ui-button-danger"
              onClick={() => setConfirmation("unassign")}
              disabled={!selected.assigned || busy}
            >
              Unassign
            </button>
            <div>
              <button
                className="pixel-button"
                onClick={reset}
                disabled={saving || !dirtyIds.includes(selected.seatId)}
              >
                Reset changes
              </button>
              <button
                className="pixel-button pixel-button--primary"
                onClick={save}
                disabled={!valid || !dirtyIds.includes(selected.seatId)}
              >
                {selected.assigned ? "Save Changes" : "Assign Character"}
              </button>
            </div>
          </div>
          <div className="team-feedback" aria-live="polite">
            {error ? (
              <span role="alert" className="ui-error">
                {error}
              </span>
            ) : (
              notice ||
              (dirtyIds.length
                ? `${dirtyIds.length} unsaved profile${dirtyIds.length === 1 ? "" : "s"} · Drafts are kept when switching seats.`
                : "Changes are saved to this workspace.")
            )}
          </div>
          {draft.type === "agent" && agentError && (
            <div className="ui-error" role="alert">
              {agentError}{" "}
              <button
                className="pixel-button"
                onClick={() => {
                  setAgentError("");
                  setAgentsLoading(true);
                  setReload((n) => n + 1);
                }}
              >
                Retry discovery
              </button>
            </div>
          )}
        </div>
      </div>
      {confirmation && (
        <ConfirmDialog
          title={
            confirmation === "close" ? "Discard unsaved profiles?" : `Unassign ${selected.label}?`
          }
          description={
            confirmation === "close"
              ? "Your saved team stays unchanged. Unsaved profile edits will be discarded."
              : "This seat will become available. You can assign a team member again later."
          }
          confirmLabel={confirmation === "close" ? "Discard changes" : "Unassign seat"}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmation === "close" ? onClose : unassign}
        />
      )}
    </div>
  );
}
