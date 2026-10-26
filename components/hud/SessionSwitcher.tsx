"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, ChevronDown } from "lucide-react";
import { useStudio } from "@/lib/store";
import { formatRelativeTime } from "@/lib/constants";
import type { SessionRecord } from "@/types/game";

export default function SessionSwitcher({
  sessions,
  activeKey,
}: {
  sessions: SessionRecord[];
  activeKey?: string;
}) {
  const { newSession, switchSession } = useStudio();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const activeLabel =
    sessions.find((s) => s.key === activeKey)?.label ?? activeKey?.split(":").pop() ?? "Default";

  return (
    <div
      ref={ref}
      className="session-switcher"
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = Array.from(
            ref.current?.querySelectorAll<HTMLButtonElement>(".session-dropdown__item") ?? [],
          );
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          items[
            (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length
          ]?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-controls="session-options"
        type="button"
        className="pixel-button"
        style={{
          padding: "3px 8px",
          whiteSpace: "nowrap",
          display: "flex",
          alignItems: "center",
          gap: 4,
          maxWidth: 140,
        }}
        onClick={() => setOpen((prev) => !prev)}
        title="Switch session"
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeLabel}</span>
        <ChevronDown
          size={10}
          style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      <button
        type="button"
        className="pixel-button pixel-button--primary"
        style={{ padding: "3px 6px", whiteSpace: "nowrap" }}
        onClick={() => {
          newSession();
          setOpen(false);
        }}
        title="New session"
        aria-label="New session"
      >
        <Plus size={10} />
      </button>

      {open && (
        <div id="session-options" className="session-dropdown" aria-label="Conversations">
          {sessions.length === 0 ? (
            <div className="session-dropdown__empty">No sessions yet</div>
          ) : (
            sessions.map((session) => {
              const isActive = session.key === activeKey;
              return (
                <button
                  key={session.key}
                  type="button"
                  className={`session-dropdown__item ${isActive ? "session-dropdown__item--active" : ""}`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    switchSession(session.key);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <div style={{ fontWeight: isActive ? "bold" : "normal" }}>
                    {session.label ?? session.key.split(":").pop()}
                  </div>
                  <div className="session-dropdown__time">
                    {formatRelativeTime(session.createdAt)}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
