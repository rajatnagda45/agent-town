"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { runtimeRequest } from "@/lib/store";

import { taskRecord, type ComposedTask } from "@/lib/task-record";

const selectionKey = "agent-town:composer:selected";
const modeLabel = { exact: "exactly", max: "at most", min: "at least" } as const;
function contractLabel(contract: NonNullable<ComposedTask["contract"]>) {
  const { deliverable } = contract;
  const timing = deliverable.minutes
    ? ` · ${modeLabel[deliverable.mode ?? "exact"]} ${deliverable.minutes} min`
    : "";
  const segments = deliverable.requiredSegments?.length
    ? ` · includes ${deliverable.requiredSegments.map((s) => `${s.minutes} min ${s.label}`).join(", ")}`
    : "";
  return `${deliverable.kind}${timing}${segments} (${contract.source === "inferred" ? "from your request" : "supplied"})`;
}
const display = (s: string) => s.replaceAll(/[-_]/g, " ");
export default function TaskComposer({ refreshToken = 0 }: { refreshToken?: number }) {
  const [goal, setGoal] = useState("");
  const [criteria, setCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [attachments, setAttachments] = useState<Array<{ name: string; content: string }>>([]);
  const [tasks, setTasks] = useState<ComposedTask[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<{ available: boolean; reason: string } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [retry, setRetry] = useState(0);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Array<{
    taskId: string;
    goal: string;
    status: string;
    snippet: string;
    link: string;
  }> | null>(null);
  async function searchPast(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    try {
      const { results } = await runtimeRequest<{ results: NonNullable<typeof found> }>(
        `search?q=${encodeURIComponent(query.trim())}`,
      );
      setFound(results);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Search failed");
    }
  }
  const submission = useRef<string | null>(null);
  const generation = useRef(0);
  const current = tasks.find((t) => t.id === selected);
  function choose(id: string) {
    setSelected(id);
    setCorrecting(false);
    try {
      sessionStorage.setItem(selectionKey, id);
    } catch {}
  }
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const version = generation.current;
      try {
        const result = await runtimeRequest<{
          tasks: ComposedTask[];
          readiness?: { available: boolean; reason: string };
        }>("composer");
        if (active && version === generation.current) {
          setTasks(result.tasks ?? []);
          try {
            const saved = sessionStorage.getItem(selectionKey) ?? "";
            setSelected((existing) => existing || saved);
          } catch {}
          setReadiness(result.readiness ?? null);
          setHistoryError("");
        }
      } catch (cause) {
        if (active && version === generation.current)
          setHistoryError(cause instanceof Error ? cause.message : "Task service unavailable");
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [refreshToken, retry]);
  function accept(task: ComposedTask) {
    generation.current++;
    setTasks((old) => [task, ...old.filter((t) => t.id !== task.id)]);
    choose(task.id);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    submission.current ??= crypto.randomUUID();
    try {
      const { task } = await runtimeRequest<{ task: ComposedTask }>("composer", {
        goal: goal.trim(),
        submissionId: submission.current,
        successCriteria: criteria
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        constraints: constraints
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        attachments,
      });
      accept(task);
      submission.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Task could not start");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function act(action: string, payload = {}) {
    if (!current || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const { task } = await runtimeRequest<{ task: ComposedTask }>(
        `composer/${encodeURIComponent(current.id)}/${action}`,
        payload,
      );
      accept(task);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="task-composer" aria-label="Team task composer">
      <h3>What should the team investigate or accomplish?</h3>
      {readiness && !readiness.available && (
        <div role="status">
          <strong>Specialist execution needs setup</strong>
          <p>Use Chat &amp; Tasks to delegate work with the connected agents.</p>
          <details>
            <summary>Setup details</summary>
            <p>{readiness.reason}</p>
          </details>
          <a href="/app/chat">Open Chat &amp; Tasks</a>
          <p>You can review a goal here; specialist execution remains unavailable.</p>
        </div>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <label htmlFor="team-goal">Team goal</label>
          <textarea
            id="team-goal"
            required
            maxLength={2000}
            rows={3}
            value={goal}
            onChange={(e) => {
              setGoal(e.target.value);
              submission.current = null;
            }}
            placeholder="Describe the problem or desired result…"
          />
          <details>
            <summary>Optional success criteria, constraints and files</summary>
            <label>
              Success criteria
              <textarea
                maxLength={2500}
                value={criteria}
                onChange={(e) => {
                  setCriteria(e.target.value);
                  submission.current = null;
                }}
                placeholder="One measurable result per line"
              />
            </label>
            <label>
              Constraints
              <textarea
                maxLength={2500}
                value={constraints}
                onChange={(e) => {
                  setConstraints(e.target.value);
                  submission.current = null;
                }}
                placeholder="For example: do not change inventory"
              />
            </label>
            <label>
              Text files (up to 3, 3 KB each)
              <input
                type="file"
                multiple
                accept=".txt,.md,.csv,.json"
                onChange={async (e) => {
                  if (locked.current) return;
                  locked.current = true;
                  setBusy(true);
                  try {
                    const files = [...(e.target.files ?? [])];
                    if (
                      files.length > 3 ||
                      files.some((f) => f.size > 3000 || !/\.(txt|md|csv|json)$/i.test(f.name))
                    )
                      throw new Error("Choose up to three text files, at most 3 KB each.");
                    setAttachments(
                      await Promise.all(
                        files.map(async (f) => ({ name: f.name, content: await f.text() })),
                      ),
                    );
                    submission.current = null;
                    setError("");
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "File could not be read");
                  } finally {
                    locked.current = false;
                    setBusy(false);
                  }
                }}
              />
            </label>
            <small>Attached text is context, not permission to run commands or change data.</small>
          </details>
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : readiness && !readiness.available ? "Review goal" : "Start task"}
          </button>
        </fieldset>
      </form>
      {historyError && (
        <div role="alert">
          <p>Task history unavailable: {historyError}</p>
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Retry task history
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <form onSubmit={searchPast} aria-label="Task history search">
        <label>
          Search past tasks
          <input
            value={query}
            maxLength={300}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. pump manual"
          />
        </label>
        <button type="submit">Search</button>
      </form>
      {found && (
        <ul aria-label="Search results">
          {found.length === 0 && <li>No matching past tasks.</li>}
          {found.map((item) => (
            <li key={item.taskId}>
              <a href={item.link} target="_blank" rel="noreferrer">
                {item.goal.slice(0, 80)}
              </a>{" "}
              · {display(item.status)} · {item.snippet}
            </li>
          ))}
        </ul>
      )}
      {tasks.length > 0 && (
        <label>
          Saved tasks
          <select
            aria-label="Saved tasks"
            value={selected}
            disabled={busy}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Select a task</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.input.goal.slice(0, 70)} · {display(t.status)}
              </option>
            ))}
          </select>
        </label>
      )}
      {current && (
        <article aria-label="Detected task">
          <h4>Detected task</h4>
          <p>
            {display(current.route.workflow)} ·{" "}
            {current.route.dataSources.join(", ") || "No database selected"} ·{" "}
            {display(current.route.risk)}
          </p>
          <p>
            Routing confidence: {Math.round(current.route.confidence * 100)}% ·{" "}
            {display(current.status)}
          </p>
          <p>{current.input.goal}</p>
          {current.contract && (
            <p aria-label="Deliverable contract">
              Checked contract: {contractLabel(current.contract)}
            </p>
          )}
          <ul>
            {current.route.successCriteria.map((c, index) => (
              <li key={index}>{c}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              setCorrection(current.input.goal);
              setCorrecting(!correcting);
            }}
          >
            Correct interpretation
          </button>
          {(correcting || current.status === "needs_clarification") && (
            <div>
              <p>
                {current.route.clarification ||
                  "Describe the corrected goal. Earlier work remains in the task history."}
              </p>
              <label>
                Clarification or corrected goal
                <textarea
                  value={correction}
                  onChange={(e) => setCorrection(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <button
                disabled={busy || !correction.trim()}
                onClick={() => void act("correct", { goal: correction.trim() })}
              >
                Use corrected goal
              </button>
            </div>
          )}
          {current.status === "needs_confirmation" && (
            <button disabled={busy} onClick={() => void act("confirm")}>
              Continue with this interpretation
            </button>
          )}
          {current.status === "approval_required" && (
            <div>
              <p>
                No changes have been made. The action is a proposal and requires explicit approval
                plus a supported executor.
              </p>
              <button disabled={busy} onClick={() => void act("approve", { approved: true })}>
                Record explicit approval
              </button>
            </div>
          )}
          {current.status === "conversation" && (
            <p>
              Use the existing Chat control and select the requested teammate. No operational task
              was submitted.
            </p>
          )}
          {current.error && <p role="alert">{current.error}</p>}
          {current.attempts.length > 0 && (
            <details>
              <summary>Agents and execution</summary>
              <ul>
                {current.attempts.map((a) => (
                  <li key={a.taskId}>
                    {display(a.role)} · {a.seatId || "backend assignment"} · {a.stage}
                    {a.executionDecision && (
                      <>
                        {" "}
                        · {a.executionDecision.runtime} · model provider{" "}
                        {a.executionDecision.modelProvider}
                        {a.executionDecision.model && ` (${a.executionDecision.model})`}
                        <br />
                        <small>
                          Why: {a.executionDecision.reason.join("; ")}
                          {a.executionDecision.rejected.length > 0 &&
                            ` · Not chosen: ${a.executionDecision.rejected
                              .map((r) => `${r.optionId} (${r.missing.join(", ")})`)
                              .join("; ")}`}
                        </small>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {current.evidence.some((e) => e.content.includes("SYNTHETIC DATA")) && (
            <strong className="inventory-workspace__synthetic">SYNTHETIC DATA</strong>
          )}
          {current.evidence.length > 0 && (
            <details>
              <summary>Evidence · {current.evidence.length} records</summary>
              {current.evidence.map((e) => (
                <details key={e.evidenceId}>
                  <summary>
                    {e.source} · {e.evidenceId.slice(0, 10)}
                  </summary>
                  <p>Read at {e.retrievedAt}</p>
                  <pre>{e.content}</pre>
                </details>
              ))}
            </details>
          )}
          {current.analysis && (
            <div>
              <h4>Reasoning</h4>
              <p>{current.analysis.summary}</p>
              <ul>
                {current.analysis.alternatives.map((a, index) => (
                  <li key={index}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {current.checks.map((c, i) => (
            <div key={i}>
              <h4>Check: {c.status}</h4>
              <p>{c.description}</p>
              {c.issues?.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
              {c.ranking && (
                <ol>
                  {c.ranking.map((r) => (
                    <li key={r.id}>
                      {r.label}: {r.value}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          {current.critic && (
            <p>
              Critic: {current.critic.decision} · {current.critic.reason}
            </p>
          )}
          {!!current.revisionHistory?.length && (
            <p>Revisions: {current.revisionHistory.length} / 1</p>
          )}
          {current.actions.map((a, i) => (
            <p key={i}>
              Action: {display(a.kind)} · {a.status} · {a.executed ? "executed" : "not executed"}
              {a.reason && ` · ${a.reason}`}
            </p>
          ))}
          {current.report && (
            <div aria-label="Task report">
              <h4>{current.report.verified ? "Verified result" : "Unverified result"}</h4>
              <p>{current.report.summary}</p>
              <p>{current.report.scope}</p>
            </div>
          )}
          {current.verdict && <strong>Final verdict: {current.verdict}</strong>}
          <p>
            <a href={`/work/${encodeURIComponent(current.id)}`} target="_blank" rel="noreferrer">
              Open Work Report
            </a>
          </p>
          <p>
            <a
              href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(taskRecord(current), null, 2))}`}
              style={{ textDecoration: "underline", textUnderlineOffset: "0.2em" }}
              download={`agent-town-${current.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`}
            >
              Download investigation record
            </a>
          </p>
          <p>
            Local snapshot with result and source references. Review before sharing; raw source
            contents are excluded.
          </p>
        </article>
      )}
    </section>
  );
}
