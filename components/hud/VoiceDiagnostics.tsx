"use client";

import { useStudio } from "@/lib/store";
import { VOICE_BILLING_NOTICE } from "@/lib/voice/diagnostics.mjs";

export default function VoiceDiagnostics() {
  const { state } = useStudio();
  const calls = state.voice?.calls ?? [];
  return (
    <details className="chat-voice-hint">
      <summary>Call diagnostics and usage · all devices</summary>
      <p>{VOICE_BILLING_NOTICE}</p>
      <p>
        Shared by devices connected to this server. Duration is browser-measured connected time. An
        open record may be incomplete if its device disconnected. The 10 most recent calls are
        shown.
      </p>
      {!calls.length && <p>No call records yet.</p>}
      <ul aria-label="Recent voice calls">
        {calls.slice(0, 10).map((call) => {
          const reports = call.usageReports ?? [];
          const usage = reports.at(-1)?.usage;
          return (
            <li key={call.id}>
              <strong>{call.name}</strong> · {new Date(call.createdAt).toLocaleString()} ·{" "}
              {call.status ?? "unknown"}
              <div>
                {call.model ?? "Model unknown"} / {call.apiVersion ?? "API version unknown"}
              </div>
              <div>
                Recorded connected duration:{" "}
                {call.durationMs === undefined
                  ? "unknown"
                  : `${(call.durationMs / 1000).toFixed(1)}s`}
              </div>
              {call.diagnostic && (
                <div>
                  {call.diagnostic.message} ({call.diagnostic.code}, {call.diagnostic.phase}
                  {call.diagnostic.httpStatus ? `, HTTP ${call.diagnostic.httpStatus}` : ""}
                  {call.diagnostic.closeCode ? `, close ${call.diagnostic.closeCode}` : ""})
                </div>
              )}
              {usage ? (
                <div>
                  Latest provider token report: input {usage.promptTokenCount ?? "unknown"}, output{" "}
                  {usage.responseTokenCount ?? "unknown"}, total{" "}
                  {usage.totalTokenCount ?? "unknown"}. {reports.length} recent reports retained;
                  these are not a summed call total.
                </div>
              ) : (
                <div>Provider token usage: unknown (no metadata received).</div>
              )}
              <small>Call ID: {call.id}</small>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
