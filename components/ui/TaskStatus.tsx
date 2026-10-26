import {
  CheckCircle2,
  Circle,
  CircleAlert,
  Clock3,
  LoaderCircle,
  OctagonPause,
} from "lucide-react";
export function statusTone(status: string) {
  if (status === "completed") return "success";
  if (["failed", "interrupted"].includes(status)) return "danger";
  if (["waiting_question", "waiting_approval", "outcome_unknown"].includes(status))
    return "warning";
  if (["running", "submitted", "returning"].includes(status)) return "active";
  return "neutral";
}
export default function TaskStatus({ status }: { status: string }) {
  const tone = statusTone(status);
  const labels: Record<string, string> = {
    cancel_requested: "Cancellation requested",
    waiting_approval: "Waiting for approval",
    waiting_question: "Waiting for answer",
    outcome_unknown: "Outcome unknown",
  };
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "danger"
        ? CircleAlert
        : tone === "warning"
          ? Clock3
          : tone === "active"
            ? LoaderCircle
            : status === "stopped"
              ? OctagonPause
              : Circle;
  return (
    <span className={`ui-status ui-status--${tone}`}>
      <Icon size={12} aria-hidden="true" />
      {labels[status] ?? status.replaceAll("_", " ")}
    </span>
  );
}
