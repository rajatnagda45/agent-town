"use client";
import { useCallback } from "react";
import { saveOnboardingDone } from "@/lib/persistence";
import { useDialog } from "@/components/ui/useDialog";
export default function OnboardingOverlay({ onDone }: { onDone: () => void }) {
  const finish = useCallback(() => {
    saveOnboardingDone();
    onDone();
  }, [onDone]);
  const ref = useDialog(true, finish);
  return (
    <div className="seat-manager-overlay">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => event.stopPropagation()}
        aria-label="Welcome to Agent Town"
        tabIndex={-1}
        className="ui-confirm"
      >
        <span className="ui-eyebrow">Your agent workspace</span>
        <h2>Welcome to Agent Town</h2>
        <p>
          Connect your gateway to work with your team. Use the connection button in the top toolbar,
          then select a teammate to chat or assign a task.
        </p>
        <div className="ui-actions">
          <button className="pixel-button" onClick={finish}>
            Explore first
          </button>
          <button
            className="pixel-button pixel-button--primary"
            onClick={() => {
              finish();
              document.querySelector<HTMLButtonElement>('[data-dock-id="connection"]')?.click();
            }}
          >
            Set up connection
          </button>
        </div>
      </div>
    </div>
  );
}
