"use client";

import { useEffect, useState } from "react";

const LINES = [
  { text: "$ assign alice research", color: "#f0c13a" },
  { text: "> planning sprint…", color: "#a99d89" },
  { text: "✓ bob: coding UI", color: "#43E58A" },
  { text: "▸ carol: reviewing", color: "#f0e7d5" },
  { text: "✓ dave: backend API", color: "#43E58A" },
];

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function CodeEditorIllustration() {
  // Initialise to full length when reduced-motion is set so no sync setState in effect
  const [visible, setVisible] = useState(() => (prefersReducedMotion() ? LINES.length : 1));
  const [cursor, setCursor] = useState(true);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    // reveal one line every 700 ms, then loop
    const id = setInterval(() => {
      setVisible((v) => (v >= LINES.length ? 1 : v + 1));
    }, 700);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setCursor((c) => !c), 500);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto h-20 w-full max-w-[180px] select-none overflow-hidden rounded-sm border border-[#494033] bg-[#12110F] p-1.5">
      {/* title bar dots */}
      <div className="mb-1 flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-[#A93640]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[#D9AD24]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[#43E58A]" />
        <span className="ml-auto font-pixel text-[5px] text-[#494033]">TASK LOG</span>
      </div>
      {/* lines */}
      <div className="space-y-0.5 font-mono text-[7px] leading-tight">
        {LINES.slice(0, visible).map((l, i) => (
          <div key={i} style={{ color: l.color }}>
            {l.text}
            {i === visible - 1 && (
              <span style={{ color: "#43E58A", opacity: cursor ? 1 : 0 }}>▌</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
