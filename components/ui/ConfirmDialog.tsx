"use client";
import { useDialog } from "./useDialog";

export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useDialog(true, onCancel);
  return (
    <div
      className="ui-confirm-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        onKeyDown={(event) => event.stopPropagation()}
        aria-label={title}
        aria-describedby="confirm-description"
        tabIndex={-1}
        className="ui-confirm"
      >
        <h2>{title}</h2>
        <p id="confirm-description">{description}</p>
        <div className="ui-actions">
          <button className="pixel-button" onClick={onCancel}>
            Keep editing
          </button>
          <button className="pixel-button ui-button-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
