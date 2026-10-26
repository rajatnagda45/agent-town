"use client";
import { useEffect, useState } from "react";
import { runtimeRequest } from "@/lib/store";

interface Member {
  nodeId: string;
  role: string;
  seatId: string | null;
  phase: string;
  attempts: number;
  dependsOn: string[];
  handoffChars: number;
  steers: number;
  missedSteers: number;
  stopped: boolean;
  uncertainty: string | null;
  waitReason?: string | null;
}
export interface TeamRun {
  id: string;
  goal: string;
  status: string;
  reason?: string;
  answer?: string;
  assignments: Array<{ id: string; title: string; role: string; dependsOn: string[] }>;
  team: { status: string; members: Member[] } | null;
}

const display = (value: string) => value.replaceAll(/[-_]/g, " ");
const active = (phase: string) => !["completed", "failed", "blocked", "stopped"].includes(phase);

export function TeamBoardView({
  run,
  onSteer,
  onStop,
}: {
  run: TeamRun;
  onSteer: (nodeId: string, message: string) => void;
  onStop: (nodeId: string) => void;
}) {
  const [guidance, setGuidance] = useState<Record<string, string>>({});
  const titles = new Map(run.assignments.map((item) => [item.id, item.title]));
  return (
    <article className="work-report" aria-label="Team board">
      <header>
        <p className="work-report__kicker">Team run · {run.id}</p>
        <h1>{run.goal}</h1>
        <p>
          <strong>{display(run.status)}</strong>
          {run.reason && ` · ${run.reason}`}
        </p>
      </header>
      <section aria-label="Assignments">
        <h2>Who does what</h2>
        {!run.team && <p>The Team Lead is splitting the work…</p>}
        <ul>
          {run.team?.members.map((member) => (
            <li key={member.nodeId}>
              <strong>{titles.get(member.nodeId) ?? display(member.nodeId)}</strong> ·{" "}
              {display(member.role)} · {member.seatId ?? "unassigned"} · {display(member.phase)}
              {member.dependsOn.length > 0 &&
                ` · after ${member.dependsOn.map((id) => titles.get(id) ?? id).join(", ")}`}
              {member.handoffChars > 0 && ` · handed on ${member.handoffChars} chars`}
              {member.missedSteers > 0 && ` · ${member.missedSteers} guidance arrived too late`}
              {member.waitReason && (
                <>
                  <br />
                  <small>{member.waitReason}</small>
                </>
              )}
              {member.uncertainty && (
                <>
                  <br />
                  <small>{member.uncertainty}</small>
                </>
              )}
              {active(member.phase) && !member.stopped && (
                <div>
                  <input
                    aria-label={`Guidance for ${member.nodeId}`}
                    maxLength={1000}
                    value={guidance[member.nodeId] ?? ""}
                    onChange={(event) =>
                      setGuidance({ ...guidance, [member.nodeId]: event.target.value })
                    }
                  />
                  <button
                    type="button"
                    disabled={!guidance[member.nodeId]?.trim()}
                    onClick={() => {
                      onSteer(member.nodeId, guidance[member.nodeId].trim());
                      setGuidance({ ...guidance, [member.nodeId]: "" });
                    }}
                  >
                    Steer
                  </button>
                  <button type="button" onClick={() => onStop(member.nodeId)}>
                    Stop
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      {run.answer && (
        <section aria-label="Team answer">
          <h2>Consolidated answer</h2>
          <p>{run.answer}</p>
        </section>
      )}
    </article>
  );
}

export default function TeamBoard({ id }: { id: string }) {
  const [run, setRun] = useState<TeamRun | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const result = await runtimeRequest<{ run: TeamRun }>(`team/${encodeURIComponent(id)}`);
        if (live) setRun(result.run);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "Team run unavailable");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [id]);
  const control = async (action: "steer" | "stop", body: Record<string, string>) => {
    try {
      await runtimeRequest(`team/${encodeURIComponent(id)}/${action}`, body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed");
    }
  };
  if (error && !run) return <p role="alert">{error}</p>;
  if (!run) return <p>Loading team…</p>;
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <TeamBoardView
        run={run}
        onSteer={(nodeId, message) => void control("steer", { nodeId, message })}
        onStop={(nodeId) => void control("stop", { nodeId, reason: "Stopped from the team board" })}
      />
    </>
  );
}
