/** Bounded live Nightshift check. Warehouse inputs are labelled synthetic fixtures.
 * Preserve the SQLite audit, including unsuccessful and uncertain runs. Never auto-retry. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createTaskService } from "../lib/server/runtime-api.mjs";
import { createInventoryReader } from "../lib/server/inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "../lib/server/inventory-synthetic.mjs";
import { createSyntheticDataSource } from "../lib/server/data-synthetic.mjs";
import { InventoryReasoningLoop } from "../lib/server/inventory-reasoning-loop.mjs";
import { investigationView } from "../lib/server/inventory-office-api.mjs";

if (!process.env.NIGHTSHIFT_API_KEY)
  throw new Error("NIGHTSHIFT_API_KEY must be supplied privately.");
const incidentId = process.env.AGENT_TOWN_LIVE_INCIDENT_ID ?? "phase3-live-inventory";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(incidentId))
  throw new Error("Invalid live check incident ID.");
const directory = resolve(
  process.env.AGENT_TOWN_LIVE_ARTIFACT_DIR ?? "../artifacts/phase3-live-reasoning",
);
mkdirSync(directory, { recursive: true });
const options = {
  now: new Date(),
  sku: "DEMO-902",
  locationId: "DEMO-DEPOT",
  openingQuantity: 30,
  countedQuantity: 29,
};
const sources = Object.fromEntries(
  ["incomplete", "complete"].map((scenario) => [
    scenario,
    createSyntheticDataSource(createSyntheticInventoryFixtures(scenario, options)),
  ]),
);
const reader = createInventoryReader({
  mode: "synthetic",
  synthetic: {
    query(input) {
      return sources[input.parameters.scenarioId].query(input);
    },
  },
});
const service = await createTaskService({
  gatewayUrl: "ws://127.0.0.1:18789/",
  provider: "nightshift",
  dataReader: reader,
  env: {
    ...process.env,
    PORT: "3119",
    AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
    AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify(
      ["planner", "analyst", "critic"].map((role) => ({
        manifestId: `nightshift-${role}`,
        seatId: role,
        sessionKey: `agent:main:nightshift-${role}-phase3-live`,
      })),
    ),
    AGENT_TOWN_SPECIALIST_PROFILES: "{}",
  },
});
let stage = "preflight";
let currentId = incidentId;
const deadline = Date.now() + 240_000;
const loop = new InventoryReasoningLoop(service.operations);
async function waitFor(nodeId) {
  while (Date.now() < deadline) {
    const plan = service.operations.reconcile(currentId);
    const child = plan.children.find((c) => c.nodeId === nodeId);
    const task = service.runtime.db.getTask(child.operation.taskId);
    if (task?.status === "completed") return;
    if (
      ["failed", "outcome_unknown", "stopped", "interrupted"].includes(task?.status) ||
      ["blocked", "unresolved", "failed"].includes(child.phase)
    )
      throw new Error(
        `Current ${nodeId} execution is ${task?.status ?? child.phase}; operator review required.`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Bounded live deadline expired; audit preserved and no duplicate action started.",
  );
}
async function attempt() {
  stage = "planner";
  await waitFor("planner");
  loop.acceptPlanner(currentId);
  stage = "reader";
  await waitFor("reader");
  await loop.collectEvidence(currentId);
  loop.confirmEvidence(currentId);
  stage = "analyst";
  await waitFor("analyst");
  loop.acceptAnalyst(currentId);
  stage = "critic";
  await waitFor("critic");
  stage = "verification";
  const result = loop.finish(currentId);
  console.log(
    JSON.stringify({
      incidentId: currentId,
      verdict: result.verification.verdict,
      issues: result.review.issues,
    }),
  );
  return result;
}
try {
  await service.start();
  await service.runtime.refresh();
  if (service.runtime.gateway.status !== "connected")
    throw new Error(
      `Nightshift discovery: ${service.runtime.gateway.status} (${service.runtime.gateway.lastError ?? "unknown"}).`,
    );
  for (const role of ["planner", "analyst", "critic"])
    if (!service.runtime.db.getSeat(role))
      service.runtime.saveSeat({
        seatId: role,
        label: role,
        seatType: "worker",
        assigned: true,
        revision: 0,
      });
  loop.start({
    incidentId,
    reasoningVersion: 3,
    goal: "Explain this labelled synthetic inventory shortage using current source records; do not adjust stock.",
    criteria: {
      scenarioId: "incomplete",
      sku: options.sku,
      locationId: options.locationId,
      ledgerQuantity: 32,
      physicalQuantity: 29,
      maxUnexplainedUnits: 0,
    },
  });
  const first = await attempt();
  if (first.verification.verdict === "revise") {
    currentId = `${incidentId}-revision`;
    loop.revise(incidentId, currentId, { scenarioId: "complete" });
    const final = await attempt();
    if (final.verification.verdict !== "pass") process.exitCode = 1;
  } else process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ incidentId: currentId, stage, error: error.message }));
  process.exitCode = 1;
} finally {
  const views = service.operations.orchestration
    .all()
    .filter((p) => p.incident.incidentId === incidentId || p.revisionOf === incidentId)
    .map((p) => investigationView(service.runtime, p.incident.incidentId));
  writeFileSync(
    join(directory, `${incidentId}.json`),
    JSON.stringify(
      {
        provider: "live-nightshift",
        model: service.runtime.gateway.model,
        data: "SYNTHETIC DATA from local fixtures, not Zetaris",
        views,
      },
      null,
      2,
    ),
  );
  service.close();
}
