/** Visual routines only. This state never creates backend tasks or changes worker status. */
export type OfficeActivity =
  | "idle"
  | "thinking"
  | "coding"
  | "reading"
  | "researching"
  | "reviewing"
  | "planning"
  | "taking_break"
  | "getting_coffee"
  | "walking"
  | "exploring"
  | "looking_out_window"
  | "stretching"
  | "collaborating"
  | "returning_to_desk"
  | "working_on_task"
  | "waiting_for_input";
export type AmbientIntensity = "off" | "calm" | "lively";
export const activityNames: Record<OfficeActivity, string> = {
  idle: "Available",
  thinking: "Thinking",
  coding: "At workstation",
  reading: "Reading",
  researching: "Browsing references",
  reviewing: "Reviewing notes",
  planning: "Planning",
  taking_break: "On a break",
  getting_coffee: "Coffee break",
  walking: "Walking",
  exploring: "Exploring",
  looking_out_window: "Looking outside",
  stretching: "Stretching",
  collaborating: "At meeting area",
  returning_to_desk: "Returning to desk",
  working_on_task: "Working",
  waiting_for_input: "Waiting for input",
};
export class AmbientRoutine {
  activity: OfficeActivity = "idle";
  nextAt = Infinity;
  until = Infinity;
  visits = new Map<string, number>();
  private seed: number;
  readonly preference: OfficeActivity;
  readonly tripBias: number;
  constructor(id: string) {
    this.seed =
      [...id].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;
    this.preference = (
      ["coding", "reading", "thinking", "reviewing", "planning"] as OfficeActivity[]
    )[this.seed % 5];
    this.tripBias = 0.85 + (this.seed % 7) * 0.05;
  }
  random() {
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  reset(now: number, intensity: AmbientIntensity) {
    this.activity = "idle";
    this.until = Infinity;
    this.nextAt =
      intensity === "off"
        ? Infinity
        : now + (intensity === "calm" ? 18000 : 9000) + this.random() * 22000;
  }
  begin(activity: OfficeActivity, now: number) {
    this.activity = activity;
    this.until = now + 12000 + this.random() * 18000;
    this.nextAt = Infinity;
  }
  deskActivity(): OfficeActivity {
    const options: OfficeActivity[] = [
      this.preference,
      this.preference,
      "coding",
      "thinking",
      "reviewing",
      "planning",
      "stretching",
    ];
    return options[Math.floor(this.random() * options.length)];
  }
  destinationActivity(name: string): OfficeActivity {
    if (/window/i.test(name)) return "looking_out_window";
    if (/book/i.test(name)) return this.random() > 0.5 ? "reading" : "researching";
    if (/coffee/i.test(name)) return "getting_coffee";
    if (/meeting/i.test(name)) return "collaborating";
    if (/water|sofa/i.test(name)) return "taking_break";
    return "exploring";
  }
}
