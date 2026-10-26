// The truthful lifecycle of one office request, as derived on the server from persisted task
// state (lib/server/task-lifecycle.mjs). Nothing here is animated or inferred in the browser.

interface Worker {
  role: string;
  configured: { seatId: string; label: string; agentId: string | null } | null;
  selected: {
    optionId: string;
    runtime: string;
    model: string | null;
    reason: string | null;
    rejected: Array<{ optionId: string; missing: string[] }>;
  } | null;
  dispatched: {
    taskId: string;
    agentId: string | null;
    sessionKey: string | null;
    seatId: string | null;
    status: string;
    createdAt: string | null;
    completedAt: string | null;
    retryCount: number;
  } | null;
  executed: { agentId: string; sessionKey: string; runId: string | null } | null;
}

export interface Lifecycle {
  taskId: string;
  overall: string;
  composerStatus: string;
  progress: { done: number; total: number };
  stages: Array<{
    id: string;
    title: string;
    purpose: string;
    status: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    executor?: string | null;
    error?: string | null;
    count?: number;
    attempts?: number;
    rounds?: number;
    reasons?: Array<string | null>;
    verdict?: string | null;
    reason?: string | null;
    worker?: Worker | null;
  }>;
  criteria: Array<{ description: string; status: string }>;
  independence: { kind: string; warning: string | null };
  delivery: { messageDelivered: boolean; deliveredAt: string | null; workVerified: boolean };
  diagnosis: { cause: string; confirmed: boolean; observed: string } | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const words = (value: string) => value.replaceAll("_", " ");
const STATUS_TEXT: Record<string, string> = {
  done: "Done",
  active: "In progress",
  not_started: "Not started",
  stopped: "Stopped here",
  failed: "Failed",
  empty: "No records returned",
  not_applicable: "Not applicable",
  not_needed: "Not needed",
  not_recorded: "Not recorded",
};
const time = (value?: string | null) => (value ? new Date(value).toLocaleTimeString() : "—");

function WorkerDetails({ worker }: { worker: Worker }) {
  return (
    <dl className="lifecycle__worker">
      <dt>Configured seat</dt>
      <dd>
        {worker.configured
          ? `${worker.configured.label} (${worker.configured.seatId}) → ${worker.configured.agentId ?? "unbound"}`
          : "Not recorded"}
      </dd>
      <dt>Selected</dt>
      <dd>
        {worker.selected
          ? `${worker.selected.optionId} · ${worker.selected.runtime}${worker.selected.model ? ` · ${worker.selected.model}` : ""}`
          : "Not recorded (no routing decision)"}
        {worker.selected?.rejected.map((item) => (
          <span key={item.optionId} className="lifecycle__rejected">
            {" "}
            Rejected {item.optionId}: {item.missing.join("; ")}.
          </span>
        ))}
      </dd>
      <dt>Dispatched</dt>
      <dd>
        {worker.dispatched
          ? `${worker.dispatched.agentId ?? "unknown agent"} · session ${worker.dispatched.sessionKey ?? "unknown"} · ${words(worker.dispatched.status)} · retries ${worker.dispatched.retryCount}`
          : "Not dispatched"}
      </dd>
      <dt>Executed</dt>
      <dd>
        {worker.executed
          ? `${worker.executed.agentId}${worker.executed.runId ? ` · run ${worker.executed.runId}` : ""}`
          : "No execution recorded"}
      </dd>
    </dl>
  );
}

export default function LifecyclePanel({ lifecycle }: { lifecycle: Lifecycle }) {
  const { progress } = lifecycle;
  return (
    <section aria-label="Lifecycle" className="lifecycle">
      <h2>
        Lifecycle · <strong>{words(lifecycle.overall)}</strong>
      </h2>
      <p>
        <progress value={progress.done} max={Math.max(progress.total, 1)} /> {progress.done} of{" "}
        {progress.total} required stages done · task <code>{lifecycle.taskId}</code> · created{" "}
        {time(lifecycle.createdAt)} · updated {time(lifecycle.updatedAt)}
      </p>
      <p role="status" className="lifecycle__delivery">
        Chat reply{" "}
        {lifecycle.delivery.messageDelivered
          ? `delivered ${time(lifecycle.delivery.deliveredAt)}`
          : "not delivered yet"}{" "}
        · work {lifecycle.delivery.workVerified ? "verified" : "not verified"}
        {lifecycle.delivery.messageDelivered &&
          !lifecycle.delivery.workVerified &&
          " — a delivered reply does not mean the work succeeded."}
      </p>
      {lifecycle.diagnosis && (
        <p role="alert" className="lifecycle__diagnosis">
          {lifecycle.diagnosis.confirmed
            ? `Blocked: ${words(lifecycle.diagnosis.cause)}.`
            : "Cause unresolved."}{" "}
          Observed: {lifecycle.diagnosis.observed}
        </p>
      )}
      {lifecycle.independence.warning && (
        <p className="lifecycle__independence">
          Identity: {words(lifecycle.independence.kind)}. {lifecycle.independence.warning}
        </p>
      )}
      <ol className="lifecycle__stages">
        {lifecycle.stages.map((stage) => (
          <li key={stage.id} data-status={stage.status}>
            <details open={stage.status === "active" || stage.status === "stopped"}>
              <summary>
                <strong>{stage.title}</strong> · {STATUS_TEXT[stage.status] ?? words(stage.status)}
                {stage.startedAt ? ` · ${time(stage.startedAt)}` : ""}
                {stage.finishedAt ? `–${time(stage.finishedAt)}` : ""}
              </summary>
              <p>{stage.purpose}</p>
              {stage.executor && <p>Executor: {stage.executor}</p>}
              {stage.count !== undefined && <p>Evidence records: {stage.count}</p>}
              {stage.attempts !== undefined && stage.attempts > 1 && (
                <p>Analyst attempts: {stage.attempts}</p>
              )}
              {stage.verdict && (
                <p>
                  Verdict: {stage.verdict}
                  {stage.reason ? ` · ${stage.reason}` : ""}
                </p>
              )}
              {stage.rounds ? (
                <p>
                  Revision rounds: {stage.rounds}
                  {stage.reasons?.filter(Boolean).map((reason) => ` · ${reason}`)}
                </p>
              ) : null}
              {stage.error && <p role="alert">{stage.error}</p>}
              {stage.worker && <WorkerDetails worker={stage.worker} />}
            </details>
          </li>
        ))}
      </ol>
      {lifecycle.criteria.length > 0 && (
        <ul className="lifecycle__criteria" aria-label="Acceptance criteria">
          {lifecycle.criteria.map((criterion) => (
            <li key={criterion.description}>
              {words(criterion.status)} · {criterion.description}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
