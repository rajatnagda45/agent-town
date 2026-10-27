"use client";

import { PixelCharacter } from "../PixelCharacter";

// Alice, Bob, Carol — from officeData agentDefs
const DEFS = [
  { hair: "#6b3f22", skin: "#f1c7a0", shirt: "#3b4a7a", pants: "#2a2a3a" },
  { hair: "#8a5a32", skin: "#f1c7a0", shirt: "#3f8a5a", pants: "#4a4a58" },
  { hair: "#a3462c", skin: "#e9b88f", shirt: "#2f8a8a", pants: "#c46a2a", cap: "#a93640" },
];

export function CollabIllustration() {
  return (
    <div className="relative mx-auto flex h-20 items-end justify-center gap-3 pb-1">
      {/* dotted connector line */}
      <div
        className="absolute bottom-[22px] left-[16%] right-[16%] border-t-2 border-dashed border-[#D9AD24] opacity-50"
        aria-hidden
      />
      {/* shared task badge */}
      <div className="absolute bottom-[24px] left-1/2 z-10 -translate-x-1/2 rounded-sm border border-[#D9AD24] bg-[#12110F] px-1.5 py-0.5">
        <span className="font-pixel text-[5px] text-[#D9AD24]">TASK</span>
      </div>
      {DEFS.map((def, i) => (
        <PixelCharacter key={i} def={def} className="h-[68px]" animate />
      ))}
    </div>
  );
}
