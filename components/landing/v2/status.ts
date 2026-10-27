import { activityLabel, agentDefs, type Activity } from "./officeData";

export type WorkerStatus = "working" | "idle" | "unavailable";
export type WorkerSnapshot = {
  name: string;
  role: string;
  activity: string;
  status: WorkerStatus;
  seated: boolean;
};
export function workerSnapshot(
  name: string,
  role: string,
  activity: Activity,
  seated: boolean,
  returning = false,
): WorkerSnapshot {
  const status: WorkerStatus =
    activity === "walking" || returning
      ? "unavailable"
      : activity === "taking_break" || activity === "thinking"
        ? "idle"
        : "working";
  return {
    name,
    role,
    status,
    seated,
    activity: returning ? "Returning to desk" : activityLabel[activity] || "Walking between rooms",
  };
}
export const initialWorkers = agentDefs.map((a) =>
  workerSnapshot(a.name, a.role, a.deskStates[0] ?? "typing", true),
);
export function summarizeWorkers(workers: WorkerSnapshot[]) {
  return {
    total: workers.length,
    working: workers.filter((a) => a.status === "working").length,
    seated: workers.filter((a) => a.seated).length,
  };
}
