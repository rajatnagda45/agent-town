"use client";

import type {
  ReasoningBundle,
  ReasoningState,
  ReasoningCritic,
} from "@/lib/reasoning-contracts.mjs";

export interface ReasoningView extends ReasoningState {
  bundle: ReasoningBundle | null;
  original: ReasoningState | null;
  rejectedCritic?: ReasoningCritic | null;
  remainingAttempts: number;
  hypothesisChecks?: Array<{
    hypothesisId: string;
    arithmeticMatches: boolean;
    explanationReferencesMatch: boolean;
    contradictions: number;
    missingEvidence: number;
  }>;
}

export default function InventoryReasoningPanel({ value }: { value: ReasoningView }) {
  const bundle = value.bundle;
  return (
    <section aria-label="Persisted reasoning">
      <h4>
        Reasoning attempt {value.attempt} of {value.maxAttempts}
      </h4>
      <p>
        {value.stage.replaceAll("_", " ")} · {value.remainingAttempts} revision remaining
      </p>
      <p>Hypotheses are proposals. Only the trusted verifier can establish a passing outcome.</p>
      {bundle && (
        <>
          <h4>Evidence bundle</h4>
          <p>
            {bundle.bundleId} · version {bundle.schemaVersion}
          </p>
          <p>
            Scope: {bundle.scope.scenarioId} · {bundle.scope.sku} at {bundle.scope.locationId}
          </p>
          <p>
            Opening: {bundle.temporalScope.openingAt ?? "unknown"} · Count cutoff:{" "}
            {bundle.temporalScope.countCutoffAt ?? "unknown"}
          </p>
          <h4>Deterministic checks</h4>
          <p>
            {bundle.checks.supported
              ? "Supported inventory domain"
              : "Unresolved domain or evidence"}
            : {bundle.checks.reason}
          </p>
          <p>
            Ledger {bundle.checks.ledgerQuantity ?? "?"} · Count{" "}
            {bundle.checks.countQuantity ?? "?"} · Shortage {bundle.checks.discrepancy ?? "?"} ·
            Explained {bundle.checks.explained ?? "?"} · Unexplained{" "}
            {bundle.checks.unexplained ?? "?"}
          </p>
          <ul>
            {bundle.checks.excludedEvidence.map((item) => (
              <li key={item.evidenceId}>
                Excluded {item.evidenceId}: {item.reason}
              </li>
            ))}
          </ul>
          <details>
            <summary>Source provenance and business rules</summary>
            <ul>
              {bundle.businessRules.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
            <ul>
              {bundle.evidence.map((item) => (
                <li key={item.evidenceId}>
                  {item.evidenceId} · revision {item.revision} · {item.source} / {item.recordId} ·
                  observed {item.sourceTimestamp} · expires {item.freshUntil} · audit{" "}
                  {item.auditRef}
                </li>
              ))}
            </ul>
          </details>
          <h4>Applicable memory · local H-MEM subset</h4>
          {bundle.memory.length ? (
            <ul>
              {bundle.memory.map((memory) => (
                <li key={memory.memoryId}>
                  {memory.content}
                  <br />
                  Source {memory.incidentId} · {memory.verificationId} ·{" "}
                  {memory.evidenceIds.join(", ")}
                </li>
              ))}
            </ul>
          ) : (
            <p>No applicable verified lesson. Current evidence is required.</p>
          )}
        </>
      )}
      <h4>Competing hypotheses</h4>
      {value.analysis?.hypotheses.length ? (
        value.analysis.hypotheses.map((hypothesis) => (
          <article key={hypothesis.hypothesisId}>
            <strong>
              {hypothesis.hypothesisId}
              {hypothesis.hypothesisId === value.analysis?.primaryHypothesisId
                ? " · primary proposal"
                : " · alternative proposal"}
            </strong>
            <p>{hypothesis.statement}</p>
            <p>Claimed explanation: {hypothesis.claimedExplainedUnits} units</p>
            {value.hypothesisChecks
              ?.filter((check) => check.hypothesisId === hypothesis.hypothesisId)
              .map((check) => (
                <p key={check.hypothesisId}>
                  Independent checks: arithmetic {check.arithmeticMatches ? "matches" : "rejected"};
                  explanation citations{" "}
                  {check.explanationReferencesMatch ? "match" : "incomplete or unsupported"}.
                </p>
              ))}
            <p>Supporting evidence: {hypothesis.supportingEvidenceIds.join(", ") || "none"}</p>
            <p>Contradictions: {hypothesis.contradictingEvidenceIds.join(", ") || "none cited"}</p>
            <p>Missing evidence: {hypothesis.missingEvidence.join("; ") || "none reported"}</p>
          </article>
        ))
      ) : (
        <p>No hypotheses recorded.</p>
      )}
      <h4>Structured Critic</h4>
      {value.rejectedCritic && (
        <p>
          Unvalidated Critic proposal · {value.rejectedCritic.decision}:{" "}
          {value.rejectedCritic.reasoning}. See the validation issues below; this proposal cannot
          establish success.
        </p>
      )}
      {value.critic ? (
        <>
          <p>
            {value.critic.decision}: {value.critic.reasoning}
          </p>
          <p>Missing evidence: {value.critic.missingEvidence.join("; ") || "none reported"}</p>
          <ul>
            {value.critic.nextTasks.map((task) => (
              <li key={task.templateId}>
                Proposed {task.templateId}: {task.reason} · {task.parameters.scenarioId}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Critic response has not been validated.</p>
      )}
      {value.issues.length > 0 && (
        <ul>
          {value.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      <h4>Revision history</h4>
      {value.original && (
        <p>
          Original {value.original.incidentId}: {value.original.stage.replaceAll("_", " ")} ·{" "}
          {value.original.critic?.reasoning}
        </p>
      )}
      <ol>
        {value.history.map((item, index) => (
          <li key={index}>
            {item.at} · {item.stage.replaceAll("_", " ")}
          </li>
        ))}
      </ol>
      {value.verificationId && <p>Trusted verification reference: {value.verificationId}</p>}
    </section>
  );
}
