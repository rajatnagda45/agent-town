"use client";

import { formatCompact } from "@/lib/constants";

interface ContextMeterProps {
  usedTokens?: number;
  maxTokens?: number;
  fresh: boolean;
  /** Inline single-row variant for bottom bar */
  inline?: boolean;
}

export default function ContextMeter({
  usedTokens,
  maxTokens,
  fresh,
  inline = false,
}: ContextMeterProps) {
  const hasValues =
    typeof usedTokens === "number" &&
    Number.isFinite(usedTokens) &&
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0;
  const remaining = hasValues ? Math.min(1, Math.max(1 - usedTokens / maxTokens, 0)) : 0;
  const remainPct = Math.round(remaining * 100);

  const barColor = !fresh
    ? "linear-gradient(90deg, #6b7280, #94a3b8)"
    : remaining > 0.5
      ? "linear-gradient(90deg, #22a44b, #4ade80)"
      : remaining > 0.2
        ? "linear-gradient(90deg, #b8860b, #facc15)"
        : "linear-gradient(90deg, #a61123, #ef4444)";

  if (inline) {
    return (
      <div
        className="hud-meter-inline"
        role="meter"
        aria-label="Context remaining"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasValues ? remainPct : undefined}
        aria-valuetext={
          hasValues ? `${remainPct}% remaining${fresh ? "" : ", last reported"}` : "Not reported"
        }
        title={
          hasValues
            ? `${formatCompact(usedTokens!)} of ${formatCompact(maxTokens!)} tokens used${fresh ? "" : " (last reported)"}`
            : "Context usage has not been supplied by the runtime"
        }
      >
        <span className="hud-meter-inline__label">Context</span>
        <div className="hud-meter-inline__bar" hidden={!hasValues}>
          <div
            style={{
              width: `${remainPct}%`,
              height: "100%",
              background: barColor,
              transition: "width 0.4s ease, background 0.4s ease",
            }}
          />
        </div>
        <span className="hud-meter-inline__value">
          {hasValues ? `${remainPct}% left` : "Not reported"}
          {hasValues && !fresh && " · last reported"}
        </span>
      </div>
    );
  }

  return (
    <div className="hud-meter hud-meter--compact">
      <div className="hud-meter__topline">
        <span className="hud-meter__label">Context</span>
        <div className="hud-meter__meta">
          <span className="hud-meter__value">
            {hasValues ? `${formatCompact(maxTokens! - usedTokens!)} left` : "No session"}
          </span>
          {!fresh && <span className="hud-meter__stale">stale</span>}
        </div>
      </div>
      <div className="hud-meter__bar">
        <div
          style={{
            width: `${remainPct}%`,
            height: "100%",
            background: barColor,
            transition: "width 0.4s ease, background 0.4s ease",
          }}
        />
      </div>
      <div className="hud-meter__bottomline">
        <span>{hasValues ? `${remainPct}% remaining` : "Waiting for context"}</span>
      </div>
    </div>
  );
}
