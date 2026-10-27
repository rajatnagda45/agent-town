"use client";

import { ArrowDown, ArrowRight } from "lucide-react";

const nodes = [
  {
    title: "Scene definitions",
    file: "officeData.ts",
    text: "Rooms, desks, routes and six role-based characters.",
  },
  {
    title: "Office engine",
    file: "engine.ts",
    text: "Seeded routines, grid pathfinding and workstation rendering.",
  },
  {
    title: "Worker snapshot",
    file: "status.ts",
    text: "One shared record of activity, availability and desk occupancy.",
  },
  {
    title: "Visible workspace",
    file: "React + Canvas",
    text: "The office, status counter and crew read the same simulation.",
  },
];

export function Architecture() {
  return (
    <section id="architecture" className="mx-auto max-w-7xl px-6 pb-24">
      <div className="mb-12">
        <p className="font-pixel text-[9px] tracking-[0.2em] text-gold">UNDER THE HOOD</p>
        <h2 className="mt-5 max-w-2xl text-3xl font-bold text-cream lg:text-4xl">
          An office on the surface.
          <br />A shared state engine underneath.
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
          What runs here: a typed React experience and a code-rendered Canvas 2D office. The task
          walkthrough is a separate, explicitly labeled sample.
        </p>
      </div>
      <div className="grid gap-6 border-y border-border py-10 md:grid-cols-4">
        {nodes.map((node, i) => (
          <div key={node.title} className="relative pr-5">
            <p className="font-pixel text-[9px] text-crimson">0{i + 1}</p>
            <h3 className="mt-3 font-bold text-cream">{node.title}</h3>
            <code className="mt-2 block text-[11px] text-gold">{node.file}</code>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{node.text}</p>
            {i < nodes.length - 1 && (
              <>
                <ArrowRight
                  aria-hidden
                  className="absolute right-0 top-8 hidden h-4 w-4 text-gold md:block"
                />
                <ArrowDown aria-hidden className="mt-4 h-4 w-4 text-gold md:hidden" />
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 text-xs text-muted-foreground">
        <span>
          <span className="text-cream">Rendering:</span> requestAnimationFrame
        </span>
        <span>
          <span className="text-cream">Pathfinding:</span> BFS grid
        </span>
        <span>
          <span className="text-cream">State:</span> in-memory snapshot
        </span>
        <span>
          <span className="text-cream">Demo task:</span> deterministic sample
        </span>
      </div>
    </section>
  );
}
