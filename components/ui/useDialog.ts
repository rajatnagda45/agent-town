"use client";

import { useEffect, useRef } from "react";

/** Keep keyboard focus in the topmost dialog and restore its invoking control. */
export function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
        ),
      ).filter((el) => {
        if (el.closest("[hidden], [inert]")) return false;
        const closed = el.closest("details:not([open])");
        return !closed || closed.querySelector(":scope > summary")?.contains(el);
      });
    const frame = requestAnimationFrame(() => (focusable()[0] ?? root).focus());
    const keydown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== root) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const nodes = focusable();
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        if (!nodes.length) {
          event.preventDefault();
          root.focus();
        } else if (event.shiftKey && index <= 0) {
          event.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!event.shiftKey && (index === nodes.length - 1 || index < 0)) {
          event.preventDefault();
          nodes[0].focus();
        }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  return ref;
}
