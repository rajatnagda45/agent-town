"use client";

import { useEffect, useRef, useState } from "react";
import { runtimeRequest, useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";
import type { ReviewQuestion, ReviewRequest } from "@/types/game";
import "./execution-controls.css";
import { useDialog } from "@/components/ui/useDialog";
import { ShieldCheck } from "lucide-react";

const active = (item: ReviewRequest) =>
  ["pending", "submitting", "outcome_unknown"].includes(item.status);

function QuestionFields({
  question,
  values,
  onChange,
  disabled,
}: {
  question: ReviewQuestion;
  values: string[];
  onChange: (values: string[]) => void;
  disabled: boolean;
}) {
  if (question.isSecret || question.secretStore || question.resource)
    return (
      <fieldset disabled>
        <legend>{question.question}</legend>
        <p>
          This request needs a secure or resource-capable backend client. Answer it there, or cancel
          the request here.
        </p>
      </fieldset>
    );
  const allowed = question.options.map((option) => option.value ?? option.label);
  const custom = values.filter((value) => !allowed.includes(value));
  return (
    <fieldset disabled={disabled}>
      <legend>
        {question.header}: {question.question}
      </legend>
      {question.options.map((option) => {
        const value = option.value ?? option.label;
        return (
          <label key={value} className="review-choice">
            <input
              type={question.multiSelect ? "checkbox" : "radio"}
              name={question.questionId}
              value={value}
              checked={values.includes(value)}
              onChange={(event) =>
                onChange(
                  question.multiSelect
                    ? event.target.checked
                      ? [...values.filter((v) => allowed.includes(v)), value]
                      : values.filter((v) => v !== value)
                    : [value],
                )
              }
            />
            <span>
              {option.label}
              {option.description && <small>{option.description}</small>}
            </span>
          </label>
        );
      })}
      {(!allowed.length || question.isOther) && (
        <label>
          {" "}
          {allowed.length ? "Other answer" : "Your answer"}
          <textarea
            aria-label={`Answer ${question.questionId}`}
            maxLength={4096}
            value={custom.join("\n")}
            onChange={(event) =>
              onChange(
                event.target.value
                  ? question.multiSelect
                    ? event.target.value.split("\n")
                    : [event.target.value]
                  : [],
              )
            }
          />
        </label>
      )}
    </fieldset>
  );
}

function ReviewForm({ item, close }: { item: ReviewRequest; close: () => void }) {
  const { state, reconcile } = useStudio();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const submission = useRef<{ key: string; operationId: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialogRef = useDialog(true, close);
  useEffect(() => {
    heading.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = item.expiresAtMs <= now;
  const editable = item.status === "pending" && !expired && !busy;
  const capability = state.capabilities?.[item.kind === "approval" ? "approvals" : "questions"];
  const presentation = item.payload.presentation;
  const unsupportedQuestion = item.payload.questions?.some(
    (question) => question.isSecret || question.secretStore || question.resource,
  );
  const task = state.tasks.find((task) => task.taskId === item.taskId);
  const decide = async (choice: unknown) => {
    if (!editable || !capability?.available) return;
    const key = JSON.stringify({ revision: item.revision, choice });
    if (submission.current?.key !== key)
      submission.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await runtimeRequest<{ review: ReviewRequest }>(`reviews/${item.id}/decide`, {
        revision: item.revision,
        operationId: submission.current.operationId,
        ...(choice as object),
      });
      if (result.review.error) setError(result.review.error);
      await reconcile();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Decision could not be confirmed. Check backend state before trying again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="review-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-title"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="control-heading">
        <h2 id="review-title" tabIndex={-1} ref={heading}>
          {item.kind === "approval" ? "Review requested action" : "Answer blocking questions"}
        </h2>
        <button type="button" className="pixel-button" onClick={close}>
          Close
        </button>
      </div>
      <p>
        <strong>Agent:</strong> {item.agentId ?? "Not supplied by backend"}
        <br />
        <strong>Session:</strong> {item.sessionKey ?? "Not supplied by backend"}
        <br />
        <strong>Task:</strong>{" "}
        {task?.message ?? item.taskId ?? "No verified local task association"}
      </p>
      {item.association === "session" && (
        <p className="control-note">
          Associated through the active session; the approval event did not include a run ID.
        </p>
      )}
      <p role="status">
        {expired ? "Expired" : item.status} · Backend: {item.backendStatus} · Expires{" "}
        {new Date(item.expiresAtMs).toLocaleString()}
      </p>
      {presentation && (
        <div className="review-action">
          <strong>{presentation.title ?? "Exact requested action"}</strong>
          <pre>{presentation.commandText ?? presentation.description}</pre>
          {presentation.detail && <pre>{presentation.detail}</pre>}
          {presentation.commandPreview &&
            presentation.commandPreview !== presentation.commandText && (
              <pre>{presentation.commandPreview}</pre>
            )}
          {presentation.warningText && <p role="alert">{presentation.warningText}</p>}
          {presentation.host && <p>Host: {presentation.host}</p>}
          {presentation.scope !== undefined && (
            <pre>{JSON.stringify(presentation.scope, null, 2)}</pre>
          )}
        </div>
      )}
      {item.payload.questions?.map((question) => (
        <QuestionFields
          key={question.questionId}
          question={question}
          values={answers[question.questionId] ?? []}
          disabled={!editable}
          onChange={(values) =>
            setAnswers((previous) => ({ ...previous, [question.questionId]: values }))
          }
        />
      ))}
      {(error || item.error) && <p role="alert">{error || item.error}</p>}
      {!capability?.available && (
        <p>{capability?.reason ?? "Backend resolution is unavailable."}</p>
      )}
      <div className="control-actions">
        {presentation?.allowedDecisions.map((decision) => (
          <button
            type="button"
            key={decision}
            className="pixel-button"
            disabled={
              !editable ||
              !capability?.available ||
              presentation.externalResolution?.decisions.includes(decision)
            }
            title={
              presentation.externalResolution?.decisions.includes(decision)
                ? `Use ${presentation.externalResolution.label}`
                : undefined
            }
            onClick={() => void decide({ decision })}
          >
            {decision === "deny"
              ? "Deny"
              : decision === "allow-once"
                ? "Allow once"
                : "Always allow"}
          </button>
        ))}
        {item.kind === "question" && (
          <>
            <button
              type="button"
              className="pixel-button"
              disabled={!editable || !capability?.available || unsupportedQuestion}
              onClick={() =>
                void decide({
                  answers: Object.fromEntries(
                    (item.payload.questions ?? []).map((question) => [
                      question.questionId,
                      answers[question.questionId] ?? [],
                    ]),
                  ),
                })
              }
            >
              Submit answers
            </button>
            <button
              type="button"
              className="pixel-button"
              disabled={!editable || !capability?.available}
              onClick={() => void decide({ cancel: true })}
            >
              Cancel question
            </button>
          </>
        )}
        <button
          type="button"
          className="pixel-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await reconcile();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Backend check failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Check backend again
        </button>
      </div>
      <p className="control-note">
        A review decision does not confirm that the task has finished. Voice cannot approve or
        answer this request.
      </p>
    </div>
  );
}

export default function PendingReviews() {
  const { state } = useStudio();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      gameEvents.on("open-review", (id) => {
        setSelected(id);
        setOpen(true);
      }),
    [],
  );
  const requests = state.reviews ?? [];
  const pending = requests.filter(active);
  const selectedItem = requests.find((item) => item.id === selected);
  const close = () => {
    setOpen(false);
    setSelected(undefined);
    trigger.current?.focus();
  };
  const listRef = useDialog(open && !selectedItem, close);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="pixel-button review-indicator"
        onClick={() => setOpen(true)}
        aria-label={`Review requests: ${pending.length} pending`}
      >
        <ShieldCheck size={15} aria-hidden="true" />
        <span>Reviews</span>
        {pending.length > 0 && <span className="review-count">{pending.length}</span>}
      </button>
      {open && (
        <div
          className="review-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          {selectedItem ? (
            <ReviewForm key={selectedItem.id} item={selectedItem} close={close} />
          ) : (
            <div
              ref={listRef}
              tabIndex={-1}
              className="review-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Pending requests"
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
            >
              <div className="control-heading">
                <h2>Review requests</h2>
                <button type="button" autoFocus className="pixel-button" onClick={close}>
                  Close
                </button>
              </div>
              {!pending.length && (
                <p>You’re all caught up. Requests that need your decision will appear here.</p>
              )}
              {requests
                .slice()
                .sort((a, b) => Number(active(b)) - Number(active(a)))
                .slice(0, 100)
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="review-row"
                    onClick={() => setSelected(item.id)}
                  >
                    <strong>
                      {item.agentId ?? "Unknown agent"} · {item.kind}
                    </strong>
                    <span>
                      {item.payload.presentation?.commandText ??
                        item.payload.presentation?.title ??
                        item.payload.questions?.[0]?.question}
                    </span>
                    <small>
                      {item.status} · {item.sessionKey ?? "Session not supplied"}
                    </small>
                  </button>
                ))}
              <details>
                <summary>Recovery capabilities</summary>
                {Object.entries(state.reviewRecovery ?? {}).map(([key, value]) => (
                  <p key={key}>
                    {key}: {value}
                  </p>
                ))}
              </details>
            </div>
          )}
        </div>
      )}
    </>
  );
}
