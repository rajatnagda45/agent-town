"use client";

import { useEffect, useState } from "react";

// 3 floors × 2 windows each; each window has its own flicker interval
const WINDOWS = [
  [{ delay: 0 }, { delay: 1400 }],
  [{ delay: 800 }, { delay: 300 }],
  [{ delay: 600 }, { delay: 1900 }],
];

function Window({ delay }: { delay: number }) {
  const [lit, setLit] = useState(true);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    const id = setTimeout(() => {
      const interval = setInterval(
        () => {
          setLit((l) => !l);
          // stay on for ~3 s, off for ~200 ms
          setTimeout(() => setLit(true), 220);
        },
        3200 + (delay % 900),
      );
      return () => clearInterval(interval);
    }, delay);
    return () => clearTimeout(id);
  }, [delay]);

  return (
    <span
      className="inline-block h-3.5 w-3.5 border border-[#2a2620] transition-opacity duration-100"
      style={{
        background: lit ? "#D9AD24" : "#12110F",
        boxShadow: lit ? "0 0 4px 1px rgba(217,173,36,0.5)" : "none",
      }}
    />
  );
}

export function OfficeIllustration() {
  return (
    <div className="mx-auto flex h-20 w-[90px] flex-col items-center justify-end select-none">
      {/* antenna */}
      <div className="h-2 w-0.5 bg-[#494033]" />
      <div className="h-0.5 w-3 bg-[#494033]" />
      {/* building */}
      <div className="w-full border-2 border-[#494033] bg-[#1a1814]">
        {WINDOWS.map((floor, fi) => (
          <div
            key={fi}
            className="flex justify-around border-b border-[#2a2620] px-1.5 py-1.5 last:border-b-0"
          >
            {floor.map((win, wi) => (
              <Window key={wi} delay={win.delay} />
            ))}
          </div>
        ))}
        {/* ground floor door */}
        <div className="flex justify-center border-t border-[#2a2620] pb-0">
          <span className="h-3 w-4 border-x border-t border-[#494033] bg-[#0e0d1a]" />
        </div>
      </div>
    </div>
  );
}
