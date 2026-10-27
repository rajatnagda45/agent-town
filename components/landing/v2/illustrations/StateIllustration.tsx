"use client";

import { PixelCharacter } from "../PixelCharacter";

const ALICE = { hair: "#6b3f22", skin: "#f1c7a0", shirt: "#3b4a7a", pants: "#2a2a3a" };
const DAVE = { hair: "#4a5a7a", skin: "#f3d0b0", shirt: "#6a4a8a", pants: "#3a4a3a" };

export function StateIllustration() {
  return (
    <div className="relative mx-auto flex h-20 items-end justify-center gap-5 pb-1">
      {/* shared snapshot card floating in the middle */}
      <div className="absolute bottom-[26px] left-1/2 z-10 -translate-x-1/2 rounded-sm border border-[#494033] bg-[#211F18] px-2 py-1 text-center">
        <div className="font-pixel text-[5px] text-[#a99d89]">SNAPSHOT</div>
        <div className="mt-0.5 flex items-center gap-1">
          <span className="h-1.5 w-1.5 bg-[#43E58A]" />
          <span className="font-mono text-[6px] text-[#f0e7d5]">in-sync</span>
        </div>
      </div>
      {/* arrows from characters to card */}
      <div
        className="absolute bottom-[30px] left-[27%] right-[27%] border-t border-dashed border-[#494033] opacity-60"
        aria-hidden
      />
      <PixelCharacter def={ALICE} className="h-[68px]" animate />
      <PixelCharacter def={DAVE} className="h-[68px]" animate />
    </div>
  );
}
