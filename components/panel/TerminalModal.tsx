"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { RuntimeNotice } from "@/components/ui/RuntimeNotice";
import { WorkRedirectNotice } from "@/components/ui/WorkRedirectNotice";
import { useDialog } from "@/components/ui/useDialog";
import { useStudio } from "@/lib/store";
import { gameEvents } from "@/lib/events";

export default function TerminalModal() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [targetSeatId, setTargetSeatId] = useState<string | undefined>(undefined);
  const { state, assignTask, prepareSessionForSeat } = useStudio();
  const dispatching = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isConnected = state.connection === "connected";
  const [sending, setSending] = useState(false);
  const canSend = isConnected && state.capabilities?.["chat.send"]?.available;
  const sendReason =
    state.capabilities?.["chat.send"]?.reason ?? "Backend contracts have not been verified.";

  const close = useCallback(() => {
    setOpen(false);
    setTargetSeatId(undefined);
    gameEvents.emit("terminal-closed");
  }, []);

  useEffect(() => {
    const handleOpen = async (seatId?: string) => {
      if (seatId) {
        await prepareSessionForSeat(seatId);
      }
      setTargetSeatId(seatId);
      setOpen(true);
    };
    const unsubOpen = gameEvents.on("open-terminal", (seatId) => {
      void handleOpen(seatId);
    });
    const unsubQueue = gameEvents.on("open-terminal-queue", (seatId) => {
      void handleOpen(seatId);
    });
    return () => {
      unsubOpen();
      unsubQueue();
    };
  }, [prepareSessionForSeat]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  const dialogRef = useDialog(open, close);

  const handleSubmit = async () => {
    const trimmed = input.trim();
    if (!trimmed || !canSend || dispatching.current) return;
    dispatching.current = true;
    setSending(true);
    try {
      // A request sent to the work pipeline is done here; the notice shows where it went.
      const sent = await assignTask(trimmed, targetSeatId, { onRedirect: () => setInput("") });
      if (sent) {
        setInput("");
        close();
      }
    } finally {
      dispatching.current = false;
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Stop game from receiving keys while terminal is open
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ zIndex: 50, background: "rgba(0,0,0,0.6)", pointerEvents: "auto" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => event.stopPropagation()}
        aria-label="Assign a task"
        tabIndex={-1}
        className="pixel-panel workspace-dialog"
        style={{
          width: "min(520px, 90vw)",
          padding: "20px",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "10px" }}>{">"} Terminal</div>
          <button className="pixel-button" style={{ padding: "2px 8px" }} onClick={close}>
            Close
          </button>
        </div>

        {/* Status */}
        {targetSeatId && (
          <button
            className="pixel-button pixel-button--primary"
            style={{ marginBottom: 12, width: "100%" }}
            onClick={() => {
              const seatId = targetSeatId;
              close();
              gameEvents.emit("open-voice", seatId);
            }}
          >
            Talk to{" "}
            {state.seats.find((seat) => seat.seatId === targetSeatId)?.label ?? "this agent"}
          </button>
        )}
        <WorkRedirectNotice redirect={state.workRedirect} />
        {(!canSend || state.runtimeError) && (
          <RuntimeNotice
            failed={!!state.runtimeError}
            detail={
              state.runtimeError ??
              (!isConnected ? "Not connected. Use Connection settings to reconnect." : sendReason)
            }
          />
        )}

        {/* Input */}
        <div style={{ marginBottom: "12px" }}>
          <textarea
            aria-label="Task description"
            ref={inputRef}
            className="pixel-input"
            placeholder={isConnected ? "Describe task..." : "Connect first..."}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            maxLength={20000}
            style={{ minHeight: "48px" }}
          />
          <button
            className="pixel-button pixel-button--primary w-full"
            style={{ marginTop: "8px" }}
            onClick={handleSubmit}
            disabled={!canSend || sending || !input.trim()}
          >
            {sending ? "Assigning…" : "Assign"}
          </button>
        </div>
      </div>
    </div>
  );
}
