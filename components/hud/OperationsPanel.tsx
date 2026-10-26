"use client";

import { useEffect, useState } from "react";
import { gameEvents } from "@/lib/events";
import { runtimeRequest, useStudio } from "@/lib/store";
import type { TaskItem } from "@/types/game";
import HudFlyout from "./HudFlyout";
import InventoryInvestigationPanel from "./InventoryInvestigationPanel";
import TaskComposer from "./TaskComposer";
import "./operations-panel.css";

interface OfficeLeadView {
  lead: { seatId: string; label: string } | null;
  directory: Array<{
    seatId: string;
    name: string;
    runtime: string;
    available: boolean;
    capabilities: string[];
    tools: string[];
    limitations: string[];
  }>;
  runs: Array<{
    id: string;
    status: string;
    transfers: Array<{
      at: string;
      nodeId: string;
      fromRole: string;
      fromRuntime: string | null;
      toRole?: string | null;
      toRuntime?: string | null;
      reason: string;
    }>;
  }>;
}

interface OfficeOverview {
  cursor: number;
  generatedAt: string;
  evidence: Array<{
    evidenceId: string;
    taskId: string;
    source: string;
    retrievedAt: string;
    freshUntil?: string;
    revision: number;
  }>;
  verification: Array<{
    verificationId: string;
    taskId: string;
    verdict: "pass" | "revise" | "unresolved";
    checkedAt: string;
    evidenceIds: string[];
  }>;
  operationTasks: Array<{ taskId: string; role?: string; retryCount: number; status: string }>;
  plans: Array<{ planId: string; status: string; steps: number }>;
  events: Array<{
    seq: number;
    kind: string;
    id?: string;
    taskId?: string;
    status?: string;
    revision?: number;
  }>;
}

const active = (status: TaskItem["status"]) =>
  [
    "submitted",
    "running",
    "returning",
    "cancel_requested",
    "outcome_unknown",
    "waiting_approval",
    "waiting_question",
  ].includes(status);
const pendingReview = (status: string) =>
  ["pending", "submitting", "outcome_unknown"].includes(status);
const time = (value?: string) =>
  value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const eventLabel = (kind: string) =>
  (
    ({
      "operation.evidence": "Evidence saved",
      "operation.verification": "Verification recorded",
      "operation.dataRead": "Data source read",
      "operation.task": "Operation task updated",
      "operation.incident": "Incident updated",
      review: "Approval or question updated",
      task: "Task updated",
      seat: "Agent assignment updated",
      connection: "Provider connection updated",
      managementOperation: "Agent management updated",
      orchestration: "Team plan updated",
    }) as Record<string, string>
  )[kind] ?? kind.replaceAll(".", " ");

export default function OperationsPanel() {
  const { state } = useStudio();
  const [overview, setOverview] = useState<OfficeOverview>();
  const [leadView, setLeadView] = useState<OfficeLeadView>();
  const [refreshTick, setRefreshTick] = useState(0);
  const [error, setError] = useState("");
  const [inventoryOpen, setInventoryOpen] = useState(() => {
    try {
      return Boolean(sessionStorage.getItem("agent-town:inventory:selected"));
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const open = (event: Event) => {
      if (/^inventory_[A-Za-z0-9_-]+$/.test((event as CustomEvent<string>).detail ?? ""))
        setInventoryOpen(true);
    };
    window.addEventListener("agent-town:open-investigation", open);
    return () => window.removeEventListener("agent-town:open-investigation", open);
  }, []);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    const refresh = () => {
      if (closed) return;
      const request = ++generation;
      // Case refresh must not depend on a separate overview request succeeding.
      setRefreshTick((count) => count + 1);
      void runtimeRequest<OfficeOverview>("office-overview")
        .then((value) => {
          if (!closed && request === generation) {
            setOverview(value);
            setError("");
          }
        })
        .catch((cause) => {
          if (!closed && request === generation)
            setError(cause instanceof Error ? cause.message : "Activity unavailable");
        });
      // After the overview, so the activity view never waits on the directory.
      void runtimeRequest<OfficeLeadView>("office-lead")
        .then((value) => {
          if (!closed && request === generation) setLeadView(value);
        })
        .catch(() => {
          /* The lead's directory is supplementary; the team list still renders. */
        });
    };
    const schedule = () => {
      // Coalesce bursts without postponing refresh indefinitely under continuous events.
      if (timer || closed) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 180);
    };
    refresh();
    const events = new EventSource("/api/runtime/events");
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.kind !== "metrics" && event.kind !== "message") schedule();
      } catch {
        schedule();
      }
    };
    events.onerror = () => {
      if (!closed) setError("Activity stream reconnecting");
    };
    events.onopen = schedule;
    return () => {
      closed = true;
      clearTimeout(timer);
      events.close();
    };
  }, []);

  const lead =
    state.seats.find((seat) => seat.assigned && seat.seatId === state.officeLead?.seatId) ??
    state.seats.find(
      (seat) => seat.assigned && /lead|orchestrat/i.test(`${seat.roleTitle ?? ""} ${seat.label}`),
    );
  const directory = new Map((leadView?.directory ?? []).map((agent) => [agent.seatId, agent]));
  const transfers = (leadView?.runs ?? [])
    .flatMap((run) => run.transfers.map((transfer) => ({ ...transfer, runId: run.id })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);
  const workers = state.seats.filter((seat) => seat.assigned);
  const inFlight = state.tasks.filter((task) => active(task.status));
  const running = state.tasks.filter((task) =>
    ["submitted", "running", "returning"].includes(task.status),
  );
  const queued = state.tasks.filter((task) => task.status === "queued");
  const reviews = (state.reviews ?? []).filter((item) => pendingReview(item.status));
  const retryByTask = new Map(
    overview?.operationTasks.map((task) => [task.taskId, task.retryCount]),
  );
  const retrying = (overview?.operationTasks ?? []).filter((task) => task.retryCount > 0);
  const work = [...state.tasks]
    .sort(
      (a, b) =>
        Number(b.status === "queued") - Number(a.status === "queued") ||
        Number(active(b.status)) - Number(active(a.status)) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 30);
  const verdictByTask = new Map<string, OfficeOverview["verification"][number]>();
  for (const item of [...(overview?.verification ?? [])].reverse())
    verdictByTask.set(item.taskId, item);

  return (
    <HudFlyout
      title="Office operations"
      subtitle="Live execution and evidence ledger"
      bodyClass="office-ledger"
    >
      <div className="office-ledger__summary" aria-label="Office status">
        <span>
          <strong>{running.length}</strong> running
        </span>
        <span>
          <strong>{queued.length}</strong> queued
        </span>
        <span>
          <strong>{reviews.length}</strong> approvals
        </span>
      </div>
      {error && (
        <p className="office-ledger__notice" role="status">
          {error}
        </p>
      )}
      <TaskComposer refreshToken={refreshTick} />
      <details
        className="legacy-inventory"
        open={inventoryOpen}
        onToggle={(event) => setInventoryOpen(event.currentTarget.open)}
      >
        <summary>Earlier inventory investigations and advanced controls</summary>
        <InventoryInvestigationPanel refreshToken={refreshTick} />
      </details>
      <section aria-label="Team lead and agents">
        <h3>Team</h3>
        <p className="office-ledger__lead">
          Team Lead: <strong>{lead?.label ?? "Not assigned"}</strong>
        </p>
        {workers.length ? (
          workers.map((seat) => {
            const task = inFlight.find((item) => item.seatId === seat.seatId);
            const known = directory.get(seat.seatId);
            return (
              <div className="office-ledger__row" key={seat.seatId}>
                <span
                  className="office-ledger__name"
                  title={known?.limitations.join("\n") || undefined}
                >
                  {seat.label}
                  <small>
                    {seat.seatId === lead?.seatId
                      ? "Office Lead"
                      : (seat.roleTitle ?? seat.binding?.agentId ?? "Agent")}
                    {known ? ` · ${known.runtime}` : ""}
                  </small>
                </span>
                <span
                  className={`office-ledger__state ${task ? "office-ledger__state--busy" : ""}`}
                >
                  {task ? task.status.replaceAll("_", " ") : "Available"}
                </span>
              </div>
            );
          })
        ) : (
          <p className="office-ledger__empty">Assign an agent to start work.</p>
        )}
        {transfers.length > 0 && (
          <>
            <h3>{lead?.label ?? "Office lead"}&apos;s transfers</h3>
            {transfers.map((transfer) => (
              <div className="office-ledger__row" key={`${transfer.runId}-${transfer.at}`}>
                <span className="office-ledger__name">
                  {transfer.nodeId}
                  <small>
                    {transfer.fromRole}
                    {transfer.fromRuntime ? ` (${transfer.fromRuntime})` : ""} →{" "}
                    {transfer.toRole ?? "another planner"}
                    {transfer.toRuntime ? ` (${transfer.toRuntime})` : ""}
                  </small>
                </span>
                <span className="office-ledger__state" title={transfer.reason}>
                  moved
                </span>
              </div>
            ))}
          </>
        )}
      </section>
      <section aria-label="Plans and tasks">
        <h3>Work queue</h3>
        {overview?.plans.slice(0, 3).map((plan) => (
          <div className="office-ledger__row" key={plan.planId}>
            <span className="office-ledger__name">
              {plan.planId}
              <small>{plan.steps} steps</small>
            </span>
            <span className="office-ledger__state">{plan.status.replaceAll("_", " ")}</span>
          </div>
        ))}
        {work.map((task) => {
          const verdict = verdictByTask.get(task.taskId);
          const retry = Math.max(retryByTask.get(task.taskId) ?? 0, (task.attempt ?? 1) - 1);
          return (
            <div className="office-ledger__task" key={task.taskId}>
              <span className="office-ledger__task-title">Task {task.taskId}</span>
              <span className="office-ledger__task-meta">
                {task.actorName ?? task.seatId ?? "Unassigned"} · {task.status.replaceAll("_", " ")}
                {retry > 0 ? ` · ${retry} ${retry === 1 ? "retry" : "retries"}` : ""}
                {task.status === "completed"
                  ? ` · ${verdict ? `verification ${verdict.verdict}` : "awaiting verification"}`
                  : ""}
              </span>
            </div>
          );
        })}
        {!state.tasks.length && !overview?.plans.length && (
          <p className="office-ledger__empty">No work has been queued.</p>
        )}
        {retrying.length > 0 && (
          <div className="office-ledger__retries">
            <strong>Retries</strong>
            {retrying.slice(0, 5).map((task) => (
              <span key={task.taskId}>
                {task.role ?? task.taskId}: {task.retryCount}{" "}
                {task.retryCount === 1 ? "retry" : "retries"}
              </span>
            ))}
          </div>
        )}
      </section>
      <section aria-label="Approval requests">
        <h3>
          Approval requests <span>{reviews.length}</span>
        </h3>
        {reviews.map((review) => (
          <button
            type="button"
            className="office-ledger__review"
            key={review.id}
            onClick={() => gameEvents.emit("open-review", review.id)}
          >
            <span>Review {review.id}</span>
            <small>
              {review.agentId ?? "Agent"} · {review.status.replaceAll("_", " ")}
            </small>
          </button>
        ))}
        {!reviews.length && <p className="office-ledger__empty">No decision is waiting.</p>}
      </section>
      <section aria-label="Evidence activity">
        <h3>
          Evidence <span>{overview?.evidence.length ?? 0} recent</span>
        </h3>
        {overview?.evidence.slice(0, 8).map((item) => (
          <div className="office-ledger__entry" key={item.evidenceId}>
            <strong>{item.source}</strong>
            <span>{time(item.retrievedAt)}</span>
            <small>
              Task {item.taskId} · {item.evidenceId} ·{" "}
              {item.freshUntil
                ? new Date(item.freshUntil).getTime() <= new Date(overview.generatedAt).getTime()
                  ? "Expired"
                  : "Fresh"
                : "Freshness unknown"}
            </small>
          </div>
        ))}
        {!overview?.evidence.length && (
          <p className="office-ledger__empty">No evidence recorded.</p>
        )}
      </section>
      <section aria-label="Verification outcomes">
        <h3>
          Verification <span>{overview?.verification.length ?? 0} recent</span>
        </h3>
        {overview?.verification.slice(0, 8).map((item) => (
          <div className="office-ledger__entry" key={item.verificationId}>
            <strong>Task {item.taskId}</strong>
            <span className={`office-ledger__verdict office-ledger__verdict--${item.verdict}`}>
              {item.verdict}
            </span>
            <small>
              Outcome recorded · {item.evidenceIds.length} evidence · {time(item.checkedAt)}
            </small>
          </div>
        ))}
        {!overview?.verification.length && (
          <p className="office-ledger__empty">No outcome verified yet.</p>
        )}
      </section>
      <section aria-label="Backend event history">
        <h3>
          Activity <span>latest {overview?.events.length ?? 0}</span>
        </h3>
        {overview?.events.map((event) => (
          <div className="office-ledger__event" key={event.seq}>
            <span>
              #{event.seq} {eventLabel(event.kind)}
            </span>
            <small>{event.status ?? event.id ?? event.taskId ?? "Recorded"}</small>
          </div>
        ))}
        {!overview?.events.length && (
          <p className="office-ledger__empty">No backend activity recorded.</p>
        )}
      </section>
      <p className="office-ledger__footnote">
        Shows the latest 80 backend events. Evidence content stays on the server.
      </p>
    </HudFlyout>
  );
}
