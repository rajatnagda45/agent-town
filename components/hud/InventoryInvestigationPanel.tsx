"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { runtimeRequest } from "@/lib/store";
import InventoryReasoningPanel, { type ReasoningView } from "./InventoryReasoningPanel";

interface Investigation {
  reasoning?: ReasoningView | null;
  incidentId: string;
  goal: string;
  acceptanceCriteria: Array<{ criterionId: string; description: string }>;
  criteria: {
    scenarioId: string;
    sku: string;
    locationId: string;
    ledgerQuantity: number;
    physicalQuantity: number;
    maxUnexplainedUnits: number;
  } | null;
  status: string;
  revisionOf: string | null;
  revisedIncidentId: string | null;
  tasks: Array<{
    nodeId: string;
    taskId: string;
    role: string;
    dependencies: string[];
    status: string;
    selectionReason: string | null;
    specialist: string | null;
    retryCount: number;
  }>;
  readsCollected: boolean;
  evidenceConfirmed: boolean;
  analystValidated: boolean;
  evidence: Array<{
    evidenceId: string;
    source: string;
    sourceTimestamp: string | null;
    freshUntil: string | null;
    taskId: string;
  }>;
  synthetic: boolean;
  hypothesis: string | null;
  critique: { hypothesisSupported: boolean; missingEvidence: string[] } | null;
  report: {
    verdict: "pass" | "revise" | "unresolved";
    checkedAt: string;
    verificationId: string;
    evidenceIds: string[];
    hypothesis: string | null;
    reconciliation: {
      discrepancy: number | null;
      explained: number;
      unexplained: number | null;
    } | null;
    issues: string[];
    missingEvidence: string[];
  } | null;
}

interface EvidenceDetail {
  evidenceId: string;
  source: string;
  recordId: string;
  sourceTimestamp: string | null;
  retrievedAt: string;
  freshUntil: string | null;
  content: Record<string, unknown>;
}

const display = (value: string) => value.replaceAll("_", " ");
const freshness = (value: string | null) =>
  !value ? "Freshness unknown" : Date.parse(value) <= Date.now() ? "Expired" : "Fresh";
const selectionKey = "agent-town:inventory:selected";

export default function InventoryInvestigationPanel({ refreshToken }: { refreshToken?: number }) {
  const [list, setList] = useState<
    Array<{ incidentId: string; goal: string; verdict: string | null }>
  >([]);
  const [selected, setSelected] = useState("");
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [evidence, setEvidence] = useState<EvidenceDetail | null>(null);
  const [goal, setGoal] = useState("");
  const [scenarioId, setScenarioId] = useState("");
  const [revisionScenarioId, setRevisionScenarioId] = useState("");
  const [sku, setSku] = useState("");
  const [locationId, setLocationId] = useState("");
  const [ledgerQuantity, setLedgerQuantity] = useState("");
  const [physicalQuantity, setPhysicalQuantity] = useState("");
  const [maxUnexplainedUnits, setMaxUnexplainedUnits] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submissionId = useRef<string | null>(null);
  const selection = useRef("");
  const detailGeneration = useRef(0);
  const listGeneration = useRef(0);
  const evidenceGeneration = useRef(0);

  const selectCase = useCallback((incidentId: string) => {
    selection.current = incidentId;
    detailGeneration.current++;
    evidenceGeneration.current++;
    setSelected(incidentId);
    setEvidence(null);
    setError("");
    try {
      sessionStorage.setItem(selectionKey, incidentId);
    } catch {
      // Storage can be unavailable; in-memory selection still works.
    }
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (typeof id === "string" && /^inventory_[A-Za-z0-9_-]+$/.test(id)) selectCase(id);
    };
    window.addEventListener("agent-town:open-investigation", open);
    return () => window.removeEventListener("agent-town:open-investigation", open);
  }, [selectCase]);

  useEffect(() => {
    let active = true;
    const generation = ++listGeneration.current;
    void runtimeRequest<{ investigations: typeof list }>("investigations")
      .then(({ investigations }) => {
        if (!active || generation !== listGeneration.current) return;
        const available = Array.isArray(investigations) ? investigations : [];
        setList(available);
        if (!selection.current) {
          let restored = "";
          try {
            restored = sessionStorage.getItem(selectionKey) ?? "";
          } catch {
            // No persisted selection is available in this browser.
          }
          selectCase(
            available.find((item) => item.incidentId === restored)?.incidentId ??
              available[0]?.incidentId ??
              "",
          );
        }
      })
      .catch(
        (cause) =>
          active &&
          generation === listGeneration.current &&
          setError(cause instanceof Error ? cause.message : "Investigations unavailable"),
      );
    return () => {
      active = false;
    };
  }, [refreshToken, selectCase]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const generation = ++detailGeneration.current;
    void runtimeRequest<{ investigation: Investigation }>(
      `investigations/${encodeURIComponent(selected)}`,
    )
      .then(({ investigation }) => {
        if (
          active &&
          generation === detailGeneration.current &&
          investigation.incidentId === selection.current
        ) {
          setInvestigation(investigation);
          setError("");
        }
      })
      .catch(
        (cause) =>
          active &&
          generation === detailGeneration.current &&
          setError(cause instanceof Error ? cause.message : "Investigation unavailable"),
      );
    return () => {
      active = false;
    };
  }, [selected, refreshToken]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    submissionId.current ??= crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      const { investigation: next } = await runtimeRequest<{ investigation: Investigation }>(
        "investigations",
        {
          goal,
          submissionId: submissionId.current,
          criteria: {
            scenarioId,
            sku,
            locationId,
            ledgerQuantity: Number(ledgerQuantity),
            physicalQuantity: Number(physicalQuantity),
            maxUnexplainedUnits: Number(maxUnexplainedUnits),
          },
        },
      );
      selectCase(next.incidentId);
      setInvestigation(next);
      submissionId.current = null;
      listGeneration.current++;
      setList((old) => [
        { incidentId: next.incidentId, goal: next.goal, verdict: null },
        ...old.filter((item) => item.incidentId !== next.incidentId),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation could not start");
    } finally {
      setBusy(false);
    }
  }

  async function act(
    action:
      | "accept-plan"
      | "collect-evidence"
      | "confirm-evidence"
      | "accept-analyst"
      | "finish"
      | "revise",
  ) {
    if (!investigation || busy) return;
    const actingOn = investigation.incidentId;
    setBusy(true);
    setError("");
    try {
      const { investigation: next } = await runtimeRequest<{ investigation: Investigation }>(
        `investigations/${encodeURIComponent(investigation.incidentId)}/${action}`,
        action === "revise" ? { scenarioId: revisionScenarioId } : {},
      );
      if (selection.current === actingOn) {
        selectCase(next.incidentId);
        setInvestigation(next);
      }
      listGeneration.current++;
      setList((old) => [
        { incidentId: next.incidentId, goal: next.goal, verdict: next.report?.verdict ?? null },
        ...old.filter((item) => item.incidentId !== next.incidentId),
      ]);
    } catch (cause) {
      if (selection.current === actingOn)
        setError(cause instanceof Error ? cause.message : "Investigation action failed");
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(evidenceId: string) {
    if (!investigation) return;
    const generation = ++evidenceGeneration.current;
    try {
      const result = await runtimeRequest<{ evidence: EvidenceDetail }>(
        `investigations/${encodeURIComponent(investigation.incidentId)}/evidence/${encodeURIComponent(evidenceId)}`,
      );
      if (generation === evidenceGeneration.current) setEvidence(result.evidence);
    } catch (cause) {
      if (generation === evidenceGeneration.current)
        setError(cause instanceof Error ? cause.message : "Evidence unavailable");
    }
  }

  const canAccept = investigation?.tasks.some(
    (task) => task.status === "waiting_planner_validation",
  );
  const readerCompleted = investigation?.tasks.some(
    (task) => task.nodeId === "reader" && task.status === "completed",
  );
  const analystCompleted = investigation?.tasks.some(
    (task) => task.nodeId === "analyst" && task.status === "completed",
  );
  return (
    <section className="inventory-workspace" aria-label="Inventory investigation">
      <div className="workspace-section-heading">
        <span className="ui-eyebrow">Evidence workspace</span>
        <h3>Inventory investigation</h3>
        <p>Reconcile a count, trace the evidence, and review the recorded verdict.</p>
      </div>
      <form className="inventory-workspace__form" onSubmit={start} aria-busy={busy}>
        <label>
          Goal
          <textarea
            required
            maxLength={2000}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Explain the cycle-count shortage"
          />
        </label>
        <div className="inventory-workspace__fields">
          <label>
            Evidence scenario
            <input
              required
              maxLength={64}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
              value={scenarioId}
              onChange={(event) => setScenarioId(event.target.value)}
              placeholder="Scenario identifier"
              title="Use the evidence scenario configured by your data source"
            />
          </label>
          <label>
            SKU
            <input required value={sku} onChange={(event) => setSku(event.target.value)} />
          </label>
          <label>
            Location
            <input
              required
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
            />
          </label>
        </div>
        <fieldset>
          <legend>Success criteria · source quantities</legend>
          <div className="inventory-workspace__fields">
            <label>
              Ledger units
              <input
                required
                type="number"
                min="0"
                step="1"
                value={ledgerQuantity}
                onChange={(event) => setLedgerQuantity(event.target.value)}
              />
            </label>
            <label>
              Physical units
              <input
                required
                type="number"
                min="0"
                step="1"
                value={physicalQuantity}
                onChange={(event) => setPhysicalQuantity(event.target.value)}
              />
            </label>
          </div>
        </fieldset>
        <details className="workspace-advanced">
          <summary>
            Discrepancy tolerance <span>{maxUnexplainedUnits || 0} units</span>
          </summary>
          <p className="control-note">
            Maximum unexplained units allowed by the acceptance criteria.
          </p>
          <label>
            Max unexplained
            <input
              required
              type="number"
              min="0"
              max="100"
              step="1"
              value={maxUnexplainedUnits}
              onChange={(event) => setMaxUnexplainedUnits(event.target.value)}
            />
          </label>{" "}
        </details>
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Start investigation"}
        </button>
      </form>
      {error && (
        <p className="office-ledger__notice" role="alert">
          {error}
        </p>
      )}
      {list.length > 0 && (
        <label className="inventory-workspace__select">
          Open investigation
          <select
            value={selected}
            onChange={(event) => {
              selectCase(event.target.value);
              setInvestigation(null);
            }}
          >
            {list.map((item) => (
              <option key={item.incidentId} value={item.incidentId}>
                {item.goal.slice(0, 48)} · {item.verdict ?? "in progress"}
              </option>
            ))}
          </select>
        </label>
      )}
      {investigation && (
        <div className="inventory-workspace__case">
          {investigation.reasoning && <InventoryReasoningPanel value={investigation.reasoning} />}
          <div className="inventory-workspace__headline">
            <strong>{investigation.goal}</strong>
            <span>
              {investigation.report
                ? `Verdict: ${display(investigation.report.verdict)}`
                : display(investigation.status)}
            </span>
          </div>
          {investigation.synthetic && (
            <strong className="inventory-workspace__synthetic">SYNTHETIC DATA</strong>
          )}
          <p className="inventory-workspace__scope">
            {investigation.criteria?.scenarioId} · {investigation.criteria?.sku} at{" "}
            {investigation.criteria?.locationId} · {investigation.incidentId}
          </p>
          <h4>Success criteria</h4>
          <ul>
            {investigation.acceptanceCriteria.map((item) => (
              <li key={item.criterionId}>{item.description}</li>
            ))}
          </ul>
          <h4>Tasks and dependencies</h4>
          <ol className="inventory-workspace__tasks">
            {investigation.tasks.map((task) => (
              <li key={task.nodeId}>
                <strong>{task.nodeId}</strong>
                <span>{display(task.status)}</span>
                <small>
                  {task.specialist ?? task.role} ·{" "}
                  {task.selectionReason ? display(task.selectionReason) : "Selection pending"}
                  {task.dependencies.length ? ` · after ${task.dependencies.join(", ")}` : ""}
                  {task.retryCount ? ` · ${task.retryCount} retries` : ""}
                </small>
              </li>
            ))}
          </ol>
          {canAccept && (
            <button type="button" disabled={busy} onClick={() => void act("accept-plan")}>
              Validate Planner output
            </button>
          )}
          {readerCompleted && !investigation.readsCollected && (
            <button type="button" disabled={busy} onClick={() => void act("collect-evidence")}>
              Collect inventory evidence
            </button>
          )}
          {readerCompleted && investigation.readsCollected && !investigation.evidenceConfirmed && (
            <button type="button" disabled={busy} onClick={() => void act("confirm-evidence")}>
              Check evidence and dispatch Analyst
            </button>
          )}
          {analystCompleted && !investigation.analystValidated && (
            <button type="button" disabled={busy} onClick={() => void act("accept-analyst")}>
              Validate Analyst result
            </button>
          )}
          <h4>Hypothesis and Critic</h4>
          <p>{investigation.hypothesis ?? "Waiting for the Analyst result."}</p>
          <p>
            {investigation.critique
              ? investigation.critique.hypothesisSupported
                ? "Critic supports the hypothesis."
                : "Critic rejected the hypothesis."
              : "Critic review pending."}
          </p>
          {investigation.critique?.missingEvidence.map((item) => (
            <p key={item}>{item}</p>
          ))}
          <h4>Evidence</h4>
          {investigation.evidence.length ? (
            investigation.evidence.map((item) => (
              <button
                className="inventory-workspace__evidence"
                type="button"
                key={item.evidenceId}
                onClick={() => void openEvidence(item.evidenceId)}
              >
                <strong>{item.source}</strong>
                <span>{freshness(item.freshUntil)}</span>
                <small>
                  {item.evidenceId} · source time {item.sourceTimestamp ?? "unknown"}
                </small>
              </button>
            ))
          ) : (
            <p>Waiting for source-backed evidence.</p>
          )}
          {evidence && (
            <div className="inventory-workspace__detail">
              <button type="button" onClick={() => setEvidence(null)}>
                Close evidence
              </button>
              <strong>{evidence.source}</strong>
              <p>
                Record {evidence.recordId} · {freshness(evidence.freshUntil)}
              </p>
              <pre>{JSON.stringify(evidence.content, null, 2)}</pre>
            </div>
          )}
          {!investigation.report && investigation.status === "awaiting_verification" && (
            <button type="button" disabled={busy} onClick={() => void act("finish")}>
              Check evidence and record verdict
            </button>
          )}
          {investigation.report && (
            <div className="inventory-workspace__report" aria-label="Final evidence-linked report">
              <h4>Final report · {investigation.report.verdict}</h4>
              <p>{investigation.report.hypothesis ?? investigation.hypothesis}</p>
              <p>
                Discrepancy {investigation.report.reconciliation?.discrepancy ?? "unresolved"} ·
                Explained {investigation.report.reconciliation?.explained ?? "unresolved"} ·
                Unexplained {investigation.report.reconciliation?.unexplained ?? "unresolved"}
              </p>
              <p>
                Evidence:{" "}
                {investigation.report.evidenceIds.length
                  ? investigation.report.evidenceIds.map((id) => (
                      <button type="button" key={id} onClick={() => void openEvidence(id)}>
                        {id}
                      </button>
                    ))
                  : "none"}
              </p>
              {[...investigation.report.issues, ...investigation.report.missingEvidence].map(
                (issue) => (
                  <p key={issue} className="inventory-workspace__issue">
                    {issue}
                  </p>
                ),
              )}
              {investigation.report.verdict === "revise" && !investigation.revisedIncidentId && (
                <div>
                  <label>
                    Revision evidence scenario
                    <input
                      value={revisionScenarioId}
                      maxLength={64}
                      pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                      onChange={(event) => setRevisionScenarioId(event.target.value)}
                      placeholder="complete"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy || !revisionScenarioId}
                    onClick={() => void act("revise")}
                  >
                    Start one revision
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
