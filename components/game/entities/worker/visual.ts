import { activityNames, type OfficeActivity } from "../../systems/AmbientRoutine";
import type { ConnectionStatus } from "@/types/game";
import type { VoiceStatus } from "@/lib/voice/client";
import type { WorkerStatus } from "./types";

/** Presentation only: never writes task or seat state. */
export function activityLabel(input: {
  status: WorkerStatus;
  moving: boolean;
  blocked: boolean;
  connection: ConnectionStatus;
  voice: VoiceStatus;
  role: string;
  ambient?: OfficeActivity;
}): string {
  if (input.voice !== "idle")
    return {
      connecting: "Connecting call",
      listening: "Listening",
      speaking: "Speaking",
      thinking: "Thinking",
      muted: "Call · muted",
    }[input.voice];

  if (input.status === "done") return "Complete";
  if (input.status === "failed") return "Task failed";
  if (input.connection !== "connected") return "Offline";
  if (input.moving) return input.status === "working" ? "Returning to desk" : "On a break";
  if (input.status !== "working")
    return input.ambient && input.ambient !== "idle" ? activityNames[input.ambient] : "";
  if (/research|analyst/i.test(input.role)) return "Researching";
  if (/qa|test/i.test(input.role)) return "Reviewing";
  if (/design/i.test(input.role)) return "Designing";
  if (/product|manager/i.test(input.role)) return "Planning";
  if (/engineer|developer/i.test(input.role)) return "Building";
  return "Working";
}
