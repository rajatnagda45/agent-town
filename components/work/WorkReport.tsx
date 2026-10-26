"use client";
import { useEffect, useState } from "react";
import { runtimeRequest } from "@/lib/store";
import LifecyclePanel, { type Lifecycle } from "./LifecyclePanel";

// Per-task report adapted from agent-office's Episode Recap + Export JSON (MIT).
// It shows audit data only: decisions, evidence and checks — never raw model reasoning.
interface Decision {
  runtime: string;
  modelProvider: string;
  model: string | null;
  reason: string[];
  rejected: Array<{ optionId: string; missing: string[] }>;
}
interface Check {
  status: string;
  description?: string;
  issues?: string[];
  scope?: string;
  reviewSignals?: { missingTopicTerms: string[]; note: string };
}
export interface WorkTask {
  id: string;
  status: string;
  verdict: string | null;
  error?: string;
  queryState?: string;
  /** Persisted execution events: who did what, against which source, with what result. */
  timeline?: Array<{
    at: string;
    event: string;
    actor: string;
    detail: string;
    source?: string;
    sourceMode?: string;
  }>;
  input: { goal: string; constraints?: string[] };
  contract?: {
    source: string;
    deliverable: { kind: string; minutes?: number; mode?: string };
  } | null;
  route: { workflow: string; dataSources: string[]; successCriteria: string[] };
  attempts: Array<{
    taskId: string;
    role: string;
    stage: string;
    seatId: string | null;
    executionDecision?: Decision;
  }>;
  evidence: Array<{
    evidenceId: string;
    source: string;
    recordId?: string;
    content: string;
    retrievedAt: string;
    freshUntil?: string;
  }>;
  /** Supplier investigations: the order, the recalled finding and the policy decision. */
  purchaseOrder?: string;
  recalled?: {
    taskId: string;
    verifiedAt: string;
    decision: string;
    confidence: number | null;
    evidenceIds: string[];
    conclusions: Record<string, number>;
  } | null;
  decision?: SupplierDecision;
  analysis?: {
    summary: string;
    deliverable?: { content?: string; agenda?: Array<{ title: string; minutes: number }> };
  };
  critic?: { decision: string; reason: string; onTopic?: boolean; unsupportedClaims?: string[] };
  repairHistory?: Array<{ issues: string[] }>;
  revisionHistory?: Array<{
    analysis?: { summary: string };
    critic?: { decision: string; reason: string };
  }>;
  actions: Array<{ kind: string; status: string; executed: boolean; reason?: string }>;
  checks: Check[];
  report?: {
    summary: string;
    verified: boolean;
    decision?: SupplierDecision & { verified: boolean };
    scope: string;
    sources?: Array<{ url: string; title: string }>;
    queryExecutions?: Array<{
      sql: string;
      openElapsedMs?: number;
      cleanup: string;
      openDeadline?: { timeoutMs: number; basis?: string };
    }>;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface SupplierDecision {
  poId: string;
  status: string;
  decision: string;
  actions: string[];
  approvals: string[];
  confidence: number | null;
  rules: Array<{
    id: string;
    title: string;
    condition: string;
    fired: boolean;
    reason: string;
    evidenceIds: string[];
  }>;
  memory: { status: string; reason: string };
}

const display = (value: string) => value.replaceAll(/[-_]/g, " ");
const shortId = (id: string) => id.slice(0, 14);
const MEMORY_STATUS: Record<string, string> = {
  none: "No prior finding",
  confirmed: "Confirmed by fresh evidence",
  conflicts: "Conflicts with current records — not reused",
  not_applicable: "Not applicable",
};
/** Record fields from a server read, without the label and observation stamp. */
function recordFields(content: string) {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return Object.entries(parsed)
      .filter(([key]) => !["synthetic_label", "observed_at", "url", "title"].includes(key))
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(" · ");
  } catch {
    return "";
  }
}
function sourceLink(content: string) {
  try {
    const parsed = JSON.parse(content) as { url?: string; title?: string };
    return parsed.url && /^https?:\/\//.test(parsed.url) ? parsed : null;
  } catch {
    return null;
  }
}

export function WorkReportView({ task, lifecycle }: { task: WorkTask; lifecycle?: Lifecycle }) {
  // The source this task actually read (LIVE, SYNTHETIC or WEB), from its recorded query event.
  const source = task.timeline?.findLast((event) => event.source);
  // The verified decision on the report, or the policy result of a blocked or running task.
  const decision = task.report?.decision ?? task.decision;
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(task, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `work-report-${task.id}-${new Date().toISOString().slice(0, 19)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const verification = task.checks.at(-1);
  const agenda = task.analysis?.deliverable?.agenda;
  return (
    <article className="work-report" aria-label="Work report">
      <header>
        <p className="work-report__kicker">Work Report · {task.id}</p>
        <h1>{task.input.goal}</h1>
        <p>
          <strong>{display(task.status)}</strong>
          {task.verdict && ` · verdict ${task.verdict}`}
          {source && (
            <span className={`work-report__source work-report__source--${source.sourceMode}`}>
              {" "}
              · Source: {source.source}
            </span>
          )}
        </p>
        {task.status === "collecting" && (
          <p role="status">
            Query running. The server is waiting for source results. Refreshing this page does not
            resubmit the query.
          </p>
        )}
        {task.queryState === "execution_outcome_unknown" && (
          <p role="status">
            Execution outcome unknown. The server may still be running the query; automatic
            resubmission is blocked.
          </p>
        )}
        <button type="button" onClick={exportJson}>
          Export JSON
        </button>
      </header>

      {lifecycle && <LifecyclePanel lifecycle={lifecycle} />}
      <section aria-label="Summary">
        <h2>1. Summary</h2>
        {task.contract && (
          <p>
            Contract: {task.contract.deliverable.kind}
            {task.contract.deliverable.minutes &&
              ` · ${task.contract.deliverable.mode ?? "exact"} ${task.contract.deliverable.minutes} min`}{" "}
            ({task.contract.source})
          </p>
        )}
        <p>{task.report?.summary ?? task.analysis?.summary ?? "No result yet."}</p>
        {task.report?.queryExecutions?.map((query, index) => (
          <details key={index}>
            <summary>Query execution and provenance</summary>
            <p>
              Opening elapsed: {query.openElapsedMs ?? "unknown"} ms · waiting budget:{" "}
              {query.openDeadline?.timeoutMs ?? "unknown"} ms · cleanup: {query.cleanup}
            </p>
            <pre>{query.sql}</pre>
          </details>
        ))}
        {agenda && (
          <ol>
            {agenda.map((item, index) => (
              <li key={index}>
                {item.title} — {item.minutes} min
              </li>
            ))}
          </ol>
        )}
        {task.error && <p role="alert">{task.error}</p>}
      </section>

      {decision && (
        <section aria-label="Decision" className="work-report__decision">
          <h2>Decision · {decision.poId}</h2>
          <p>
            <strong>{display(decision.status)}</strong>
            {"verified" in decision &&
              (decision.verified ? " · verified by independent review" : " · not verified")}
            {decision.confidence !== null &&
              ` · confidence ${Math.round(decision.confidence * 100)}% (share of the gap supported by current records)`}
          </p>
          <p>{decision.decision}</p>
          {decision.actions.length > 1 && (
            <ul>
              {decision.actions.slice(1).map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          )}
          {decision.approvals.length > 0 && (
            <div role="note" aria-label="Human approval required">
              <h3>Human approval required</h3>
              <ul>
                {decision.approvals.map((approval) => (
                  <li key={approval}>{approval}</li>
                ))}
              </ul>
              <p>Agent Town only recommends: no payment was approved and no record was changed.</p>
            </div>
          )}
          <table>
            <caption>Why: policy rules applied to current evidence</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Fired</th>
                <th scope="col">Reason</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {decision.rules.map((rule) => (
                <tr key={rule.id} title={rule.condition}>
                  <td>{rule.title}</td>
                  <td>{rule.fired ? "✓" : "—"}</td>
                  <td>{rule.reason}</td>
                  <td>{rule.evidenceIds.map(shortId).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="work-report__label">
            SYNTHETIC DATA · test records, not a real supplier incident.
          </p>
        </section>
      )}
      {task.purchaseOrder && task.recalled !== undefined && (
        <section aria-label="Memory" className="work-report__memory">
          <h2>Memory · H-MEM decision memory</h2>
          {task.recalled ? (
            <>
              <p>
                Recalled verified finding from task <code>{task.recalled.taskId}</code>, verified{" "}
                {task.recalled.verifiedAt}: {task.recalled.decision}
              </p>
              <p>
                Original evidence: {task.recalled.evidenceIds.map(shortId).join(", ") || "none"}
              </p>
            </>
          ) : (
            <p>No prior verified finding for {task.purchaseOrder}.</p>
          )}
          {decision && (
            <p>
              <strong>{MEMORY_STATUS[decision.memory.status] ?? decision.memory.status}</strong> ·{" "}
              {decision.memory.reason}
            </p>
          )}
          <p>Memory is prior context, not proof: current records decide.</p>
        </section>
      )}
      {task.timeline?.length ? (
        <section aria-label="Execution timeline">
          <h2>Execution timeline</h2>
          <ol>
            {task.timeline.map((event) => (
              <li key={`${event.at}-${event.event}`}>
                <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> ·{" "}
                <strong>{event.event.replaceAll("_", " ")}</strong> · {event.actor}
                <p>{event.detail}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <section aria-label="Team and execution">
        <h2>2. Team and execution</h2>
        <ul>
          {task.attempts.map((attempt) => (
            <li key={attempt.taskId}>
              <strong>{display(attempt.stage)}</strong> · {display(attempt.role)} ·{" "}
              {attempt.seatId ?? "backend assignment"}
              {attempt.executionDecision && (
                <>
                  {" "}
                  · {attempt.executionDecision.runtime} · model provider{" "}
                  {attempt.executionDecision.modelProvider}
                  {attempt.executionDecision.model && ` (${attempt.executionDecision.model})`}
                  <br />
                  <small>Why: {attempt.executionDecision.reason.join("; ")}</small>
                  {attempt.executionDecision.rejected.length > 0 && (
                    <>
                      <br />
                      <small>
                        Not chosen:{" "}
                        {attempt.executionDecision.rejected
                          .map((item) => `${item.optionId} (${item.missing.join(", ")})`)
                          .join("; ")}
                      </small>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Findings and evidence">
        <h2>3. Findings and evidence</h2>
        {task.evidence.length === 0 && <p>No retrieved evidence. Draft content is unverified.</p>}
        <ul>
          {task.evidence.map((item) => {
            const link = sourceLink(item.content);
            return (
              <li key={item.evidenceId}>
                {link ? (
                  <a href={link.url} target="_blank" rel="noreferrer noopener">
                    {link.title ?? link.url}
                  </a>
                ) : (
                  item.source
                )}{" "}
                · retrieved {item.retrievedAt}
                {item.freshUntil && ` · fresh until ${item.freshUntil}`}
                {!link && (
                  <p className="work-report__record">
                    {item.recordId && <strong>{item.recordId}</strong>} {recordFields(item.content)}{" "}
                    <code>{shortId(item.evidenceId)}</code>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Decisions and revisions">
        <h2>4. Decisions and revisions</h2>
        {task.critic && (
          <p>
            Critic: {task.critic.decision} · {task.critic.reason}
            {task.critic.onTopic === false && " · off topic"}
          </p>
        )}
        {task.critic?.unsupportedClaims?.length ? (
          <p>Unsupported claims: {task.critic.unsupportedClaims.join("; ")}</p>
        ) : null}
        {(task.repairHistory ?? []).map((repair, index) => (
          <p key={`repair-${index}`}>
            Schema repair {index + 1}: {repair.issues.join(" ")}
          </p>
        ))}
        {(task.revisionHistory ?? []).map((revision, index) => (
          <div key={`revision-${index}`}>
            {revision.analysis?.summary && (
              <p>
                Hypothesis {index + 1} (analyst): {revision.analysis.summary}
              </p>
            )}
            <p>
              Critic sent it back · {revision.critic?.decision} · {revision.critic?.reason}
            </p>
          </div>
        ))}
        {task.analysis?.summary && (task.revisionHistory?.length ?? 0) > 0 && (
          <p>Revised hypothesis (analyst): {task.analysis.summary}</p>
        )}
        {!task.critic && !task.repairHistory?.length && !task.revisionHistory?.length && (
          <p>No review decisions yet.</p>
        )}
      </section>

      <section aria-label="Actions and deliverables">
        <h2>5. Actions and deliverables</h2>
        {task.actions.length === 0 && <p>No actions.</p>}
        <ul>
          {task.actions.map((action, index) => (
            <li key={index}>
              {display(action.kind)} · {action.status} ·{" "}
              {action.executed ? "executed" : "not executed"}
              {action.reason && ` · ${action.reason}`}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Verification">
        <h2>6. Verification</h2>
        {verification ? (
          <>
            <p>
              {verification.status}
              {verification.scope && ` · ${verification.scope}`}
              {task.report?.scope && ` · ${task.report.scope}`}
            </p>
            {verification.issues?.length ? (
              <ul>
                {verification.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p>No open issues.</p>
            )}
            {verification.reviewSignals && (
              <p>
                <small>
                  Review signals: missing topic terms{" "}
                  {verification.reviewSignals.missingTopicTerms.join(", ") || "none"} ·{" "}
                  {verification.reviewSignals.note}
                </small>
              </p>
            )}
          </>
        ) : (
          <p>Not verified yet.</p>
        )}
      </section>
    </article>
  );
}

export default function WorkReport({ id }: { id: string }) {
  const [task, setTask] = useState<WorkTask | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await runtimeRequest<{ task: WorkTask; lifecycle?: Lifecycle }>(
          `composer/${encodeURIComponent(id)}`,
        );
        if (active) {
          setTask(result.task);
          setLifecycle(result.lifecycle);
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Report unavailable");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  if (error && !task) return <p role="alert">{error}</p>;
  if (!task) return <p>Loading report…</p>;
  return <WorkReportView task={task} lifecycle={lifecycle} />;
}
