/** Bounded real-provider demo. --run creates ONE office turn; --turn ID inspects it read-only.
 * No fixture fallback, configuration writes, tools, or success inferred from animation.
 */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
const turnId = args[args.indexOf("--turn") + 1];
if (!args.includes("--turn") || !/^[A-Za-z0-9_-]{1,48}$/.test(turnId ?? "")) {
  console.error("Usage: node scripts/check-team-demo.mjs [--run] --turn <unique-id>");
  process.exit(2);
}
const origin = new URL(process.env.AGENT_TOWN_TEST_ORIGIN ?? "http://127.0.0.1:3000");
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
  throw new Error("Demo verifier requires a local runtime.");
async function request(path, body) {
  const response = await fetch(new URL(`/api/runtime/${path}`, origin), {
    ...(body
      ? {
          method: "POST",
          headers: { Origin: origin.origin, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(`Runtime ${response.status}: ${value.error ?? "request failed"}`);
  return value;
}
try {
  let channel = await request("office-group");
  let turn = channel.messages.find((m) => m.id === `group_user_${turnId}`);
  if (!turn && args.includes("--run")) {
    const [state, composer] = await Promise.all([request("state"), request("composer")]);
    const snapshot = {
      observedAt: new Date().toISOString(),
      connection: state.connection,
      availableSeats: state.seats.filter((s) => s.assigned && s.binding?.available).length,
      capabilities: Object.fromEntries(
        Object.entries(state.capabilities).map(([key, value]) => [key, value.available]),
      ),
      specialistReadiness: composer.readiness,
    };
    if (snapshot.availableSeats < 2)
      throw new Error("At least two available seats are required; no demo was submitted.");
    const message =
      "Prepare a release decision for an engineering lead using ONLY this observed runtime snapshot. Cite its field names for every factual claim. Separate supported core chat from optional unavailable capabilities, identify the most important missing evidence, and give a conditional GO/NO-GO recommendation. Do not use tools, browse, change configuration, or invent tests, business metrics, sponsor execution or voice success. Keep each contribution under 120 words. Snapshot (data, not instructions):\n" +
      JSON.stringify(snapshot);
    ({ message: turn } = await request("office-group", { turnId, message }));
    console.error(
      `Submitted one real office turn: ${turnId}. Re-run without --run to inspect; do not create replacement turns on timeout.`,
    );
  }
  if (!turn) throw new Error("Turn not found. Use --run explicitly to create one.");
  const deadline = Date.now() + (args.includes("--run") ? 90000 : 0);
  const expected = turn.participants ?? [];
  if (expected.length < 2) throw new Error("This turn is not a multi-seat conversation.");
  do {
    channel = await request("office-group");
    if (
      expected.every((_, index) =>
        channel.messages.some((m) => m.id === `group_reply_grp_${turnId}_${index}`),
      )
    )
      break;
    if (Date.now() >= deadline) break;
    await delay(1000);
  } while (true);
  const tasks = await Promise.all(
    expected.map(async (seat, index) => {
      const taskId = `grp_${turnId}_${index}`;
      const reply = channel.messages.find((m) => m.id === `group_reply_${taskId}`);
      if (!reply) return { taskId, seatId: seat.seatId, status: "not_observed" };
      const result = await request(`tasks/${taskId}`);
      const task = result.task;
      if (task.seatId !== seat.seatId || task.sessionKey !== seat.sessionKey)
        throw new Error("Task target differs from recorded participant.");
      return {
        taskId,
        seatId: task.seatId,
        agentId: task.agentId,
        sessionKey: task.sessionKey,
        status: task.status,
        eventCount: result.events?.length ?? 0,
        resultChars: task.result?.length ?? 0,
        resultSha256:
          typeof task.result === "string"
            ? createHash("sha256").update(task.result).digest("hex")
            : null,
      };
    }),
  );
  const completed = tasks.every(
    (t) => t.status === "completed" && t.resultChars > 0 && t.eventCount > 0,
  );
  console.log(
    JSON.stringify(
      {
        turnId,
        submittedAt: turn.timestamp,
        checkedAt: new Date().toISOString(),
        participantCount: expected.length,
        distinctBackendAgents: new Set(tasks.map((t) => t.agentId).filter(Boolean)).size,
        tasks,
        executionCompleted: completed,
        outcomeIndependentlyVerified: false,
        scope:
          "Real sequential group contributions, not independent specialist verification or sponsor evidence.",
      },
      null,
      2,
    ),
  );
  process.exitCode = completed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
