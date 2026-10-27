export const demoStages = ["Request", "Plan", "Execute", "Deliver"] as const;
export const samplePrompt =
  "Review the Agent Town landing page for conflicting worker statuses and propose a shared source of truth.";
export const demoEvents = [
  { stage: 0, agent: "You", action: "Request captured", detail: samplePrompt },
  {
    stage: 1,
    agent: "Carol",
    action: "Split the review",
    detail: "Alice: inspect labels. Bob: trace display state. Dave: propose checks.",
  },
  {
    stage: 2,
    agent: "Alice",
    action: "Compare indicators",
    detail: "Sample finding: a fixed busy counter can disagree with animated desks.",
  },
  {
    stage: 2,
    agent: "Bob",
    action: "Trace one shared snapshot",
    detail: "Proposed flow: office state → worker snapshot → hero and crew.",
  },
  {
    stage: 2,
    agent: "Dave",
    action: "Define verification",
    detail: "Check working counts, breaks, desk occupancy and walking states.",
  },
  {
    stage: 3,
    agent: "Carol",
    action: "Collect review notes",
    detail: "Sample review ready for inspection. No repository was accessed or changed.",
  },
] as const;
export const sampleReport = `AGENT TOWN / SAMPLE REVIEW

Observation
Fixed status labels can contradict the office animation.

Proposed change
Publish a typed snapshot from the office engine.
Derive the busy count and crew labels from that snapshot.
Keep desk occupancy separate from worker availability.

Review checklist
[ ] Busy count equals workers marked working
[ ] Walking workers are marked unavailable
[ ] Breaks are idle; empty desks have no occupant
[ ] Demo activity is not presented as tool execution

Scope: illustrative review, not a recorded agent run.
No tools invoked. No files modified.`;
export function nextDemoStage(stage: number) {
  return Math.min(stage + 1, demoStages.length - 1);
}
export function eventsAtStage(stage: number) {
  return demoEvents.filter((e) => e.stage <= stage);
}
