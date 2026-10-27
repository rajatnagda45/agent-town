/** Browser acceptance with the real Office UI/runtime and an isolated fake provider.
 * All inventory rows are synthetic. This does not verify live Nightshift or Zetaris. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import next from "next";
import puppeteer from "puppeteer";
import { createTaskService } from "../lib/server/runtime-api.mjs";
import { createSyntheticDataSource } from "../lib/server/data-synthetic.mjs";
import { createInventoryReader } from "../lib/server/inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "../lib/server/inventory-synthetic.mjs";

const port = 3118;
const origin = `http://127.0.0.1:${port}`;
const fixtureOptions = {
  sku: "SKU-17",
  locationId: "BIN-A",
  openingQuantity: 10,
  countedQuantity: 9,
  now: new Date(),
};
const sources = Object.fromEntries(
  ["incomplete", "complete"].map((scenarioId) => [
    scenarioId,
    createSyntheticDataSource(createSyntheticInventoryFixtures(scenarioId, fixtureOptions)),
  ]),
);
const reader = createInventoryReader({
  mode: "synthetic",
  synthetic: {
    query(input) {
      const source = sources[input.parameters?.scenarioId];
      if (!source) throw new Error("No synthetic fixture matches this evidence scenario.");
      return source.query(input);
    },
  },
});
const grants = [
  {
    manifestId: "nightshift-planner",
    seatId: "plan",
    sessionKey: "agent:main:nightshift-planner-context01",
  },
  {
    manifestId: "nightshift-analyst",
    seatId: "analyze",
    sessionKey: "agent:main:nightshift-analyst-context02",
  },
  {
    manifestId: "nightshift-critic",
    seatId: "review",
    sessionKey: "agent:main:nightshift-critic-context03",
  },
];
const json = (value) => new Response(JSON.stringify(value));
const prompts = [];
function suppliedEvidence(message) {
  const marker = "Current authorized evidence (cite only these IDs): ";
  return JSON.parse(
    message
      .split(marker)[1]
      ?.split("\nServer count-cutoff reconciliation")[0]
      .split("\nVersioned reasoning evidence bundle")[0]
      .split("\nValidated prior reasoning:")[0] ?? "[]",
  );
}
async function fakeNightshift(input, init) {
  if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
  const body = JSON.parse(String(init?.body));
  const system = String(body.messages[0].content);
  const message = String(body.messages.at(-1).content);
  const role = /the (planner|analyst|critic) in/.exec(system)?.[1] ?? "unknown";
  const bundleText = message
    .split("\nVersioned reasoning evidence bundle (proposals are not verified facts): ")[1]
    ?.split("\nValidated prior reasoning:")[0];
  const bundle = bundleText ? JSON.parse(bundleText) : null;
  prompts.push(role);
  let content;
  if (role === "planner") {
    content = JSON.stringify({
      goal: JSON.parse(
        message
          .split("The reviewed task graph and criteria are ")[1]
          ?.split(". Return exactly")[0] ?? "{}",
      ).goal,
      acceptanceCriteria: ["inventory-count", "inventory-reconciliation"],
      tasks: [
        { taskId: "reader", role: "nightshift-analyst", dependencies: ["planner"] },
        { taskId: "analyst", role: "nightshift-analyst", dependencies: ["reader"] },
        { taskId: "critic", role: "nightshift-critic", dependencies: ["reader", "analyst"] },
      ],
    });
  } else if (message.includes("Prepare the server-scoped inventory evidence read")) {
    content = '{"prepared":true}';
  } else if (role === "analyst") {
    const evidence = suppliedEvidence(message);
    const hasReceipt = evidence.some((item) => item.source.endsWith("inventory_receipts"));
    const explanations = evidence.filter((item) => {
      const row = JSON.parse(item.content);
      return (
        item.source.endsWith("inventory_transfers") ||
        item.source.endsWith("inventory_receipts") ||
        (item.source.endsWith("inventory_ledger_movements") &&
          row.movement_type === "posted_receipt" &&
          hasReceipt)
      );
    });
    const explained = evidence.reduce((sum, item) => {
      const row = JSON.parse(item.content);
      if (item.source.endsWith("inventory_transfers")) return sum + row.quantity;
      if (item.source.endsWith("inventory_receipts"))
        return sum + row.expected_quantity - row.received_quantity;
      return sum;
    }, 0);
    const hypothesis =
      "Applicable transfer and receipt records explain the supported shortage units.";
    content = JSON.stringify(
      bundle
        ? {
            bundleId: bundle.bundleId,
            primaryHypothesisId: "inventory-explanation",
            hypotheses: [
              {
                hypothesisId: "inventory-explanation",
                statement: hypothesis,
                supportingEvidenceIds: explanations.map((item) => item.evidenceId),
                contradictingEvidenceIds: [],
                claimedExplainedUnits: explained,
                missingEvidence: [],
              },
            ],
          }
        : {
            hypothesis,
            explanationEvidenceIds: explanations.map((item) => item.evidenceId),
            claimedExplainedUnits: explained,
            missingEvidence: [],
          },
    );
  } else {
    const prior = JSON.parse(message.split("\nValidated prior reasoning: ")[1]);
    const analysis = JSON.parse(prior.result);
    const explained = bundle
      ? analysis.hypotheses[0].claimedExplainedUnits
      : analysis.claimedExplainedUnits;
    content = JSON.stringify(
      bundle
        ? {
            bundleId: bundle.bundleId,
            decision: explained === 3 ? "ACCEPT" : "REVISE",
            hypothesisIds: ["inventory-explanation"],
            evidenceIds: bundle.checks.applicableEvidenceIds,
            reasoning: "Checked source quantities, cutoff and explanation citations",
            missingEvidence: explained === 3 ? [] : ["One unit lacks source support."],
            nextTasks:
              explained === 3
                ? []
                : [
                    {
                      templateId: "inventory-receipts",
                      parameters: bundle.scope,
                      reason: "Seek a receipt supporting the remaining unit",
                    },
                  ],
          }
        : {
            hypothesisSupported: explained === 3,
            missingEvidence: explained === 3 ? [] : ["One unit lacks source support."],
            conflictingEvidenceIds: [],
          },
    );
  }
  return json({ model: "meterless/auto", choices: [{ message: { content } }] });
}

const app = next({ dev: false, dir: process.cwd() });
let tasks;
let server;
let browser;
try {
  await app.prepare();
  tasks = await createTaskService({
    gatewayUrl: "ws://127.0.0.1:18789/",
    provider: "nightshift",
    nightshiftFetch: fakeNightshift,
    dataReader: reader,
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_TOWN_DB_PATH: join(tmpdir(), `agent-town-inventory-browser-${randomUUID()}.sqlite`),
      AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify(grants),
      AGENT_TOWN_SPECIALIST_PROFILES: "{}",
      NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1",
      NIGHTSHIFT_API_KEY: "isolated-mock-only",
      NIGHTSHIFT_MODEL: "meterless/auto",
      AGENT_TOWN_INVENTORY_MODE: "synthetic",
      AGENT_TOWN_INVENTORY_SYNTHETIC_CASE: "demo-pair",
    },
  });
  const nextHandler = app.getRequestHandler();
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api/runtime/") || req.url?.startsWith("/api/agents/discover"))
      void tasks.handler(req, res);
    else void nextHandler(req, res);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  await tasks.start();
  await tasks.runtime.refresh();
  for (const seatId of ["plan", "analyze", "review"])
    tasks.runtime.saveSeat({
      seatId,
      label: seatId,
      seatType: "worker",
      assigned: true,
      revision: 0,
    });
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".office-stage--classic") ||
      document.querySelector('.office-stage--3d [title="Switch office view"]:not(:disabled)'),
    { timeout: 60000 },
  );
  const view = await page.$('.office-stage--3d [title="Switch office view"]:not(:disabled)');
  if (view) await view.click();
  await page.waitForSelector(".hud-chat-dock__btn", { timeout: 60000 });
  await page.click(".hud-chat-dock__btn");
  await page.waitForSelector(".hud-chat-input-row textarea:not([disabled])", { timeout: 30000 });
  await page.type(
    ".hud-chat-input-row textarea",
    "Explain the 3-unit shortage for SKU-17 at BIN-A using evidence. Do not modify inventory. Ledger 12, physical 9, max unexplained 0.",
  );
  await page.click(".hud-chat-input-row button");
  await page.waitForFunction(
    () => document.querySelector(".hud-chat")?.textContent.includes("Investigation started"),
    { timeout: 30000 },
  );
  const groupBefore = await (await fetch(`${origin}/api/runtime/office-group`)).json();
  const started = groupBefore.messages.find((message) =>
    message.content.includes("Investigation started"),
  );
  assert.match(started.incidentId, /^inventory_/);
  const openInvestigation = await page.waitForSelector(
    ".hud-chat__bubble--assistant .hud-chat__content > button",
  );
  assert.equal(
    await openInvestigation.evaluate((node) => node.textContent.trim()),
    "Open investigation",
  );
  await openInvestigation.click();
  await page.waitForSelector("#team-goal");
  await page.type("#team-goal", "Change inventory by three units");
  await page.click('.task-composer button[type="submit"]');
  await page.waitForFunction(() =>
    document.querySelector(".task-composer article")?.textContent.includes("approval required"),
  );
  assert.match(
    await page.$eval(".task-composer article", (node) => node.textContent),
    /not executed/,
  );
  console.log("PASS: single goal routes mutations to a persisted, unexecuted approval proposal");
  assert.equal(await page.$eval(".legacy-inventory", (node) => node.open), true);
  await page.waitForSelector(".inventory-workspace__form", { timeout: 30000 });
  await page.waitForSelector(".inventory-workspace__case", { timeout: 30000 });
  let incidentId = await page.$eval(".inventory-workspace__scope", (node) =>
    node.textContent.trim().split(" · ").at(-1),
  );
  assert.match(incidentId, /^inventory_/);
  assert.equal(incidentId, started.incidentId);
  console.log("PASS: Text office group routed one request to a structured incident");

  async function step(label, visibleText, ready) {
    await page.waitForFunction(
      (buttonText) =>
        [...document.querySelectorAll(".inventory-workspace__case button")].some(
          (node) => node.textContent.trim() === buttonText,
        ),
      { timeout: 30000 },
      visibleText,
    );
    await page.evaluate(
      (buttonText) =>
        [...document.querySelectorAll(".inventory-workspace__case button")]
          .find((node) => node.textContent.trim() === buttonText)
          .click(),
      visibleText,
    );
    await page.waitForFunction(ready, { timeout: 30000 });
    console.log(`PASS: ${label}`);
  }
  await step(
    "Planner validated",
    "Validate Planner output",
    () => !!document.querySelector(".inventory-workspace__tasks li:nth-child(2)"),
  );
  await step(
    "Four scoped source reads",
    "Collect inventory evidence",
    () => document.querySelectorAll(".inventory-workspace__evidence").length >= 4,
  );
  await page.waitForSelector(".inventory-workspace__synthetic");
  assert.equal(
    await page.$eval(".inventory-workspace__synthetic", (node) => node.textContent.trim()),
    "SYNTHETIC DATA",
  );
  const firstEvidence = await page.$eval(".inventory-workspace__evidence", (node) =>
    node.textContent.trim(),
  );
  assert.match(firstEvidence, /synthetic:/);
  await page.click(".inventory-workspace__evidence");
  await page.waitForSelector(".inventory-workspace__detail pre");
  assert.match(
    await page.$eval(".inventory-workspace__detail pre", (node) => node.textContent),
    /SKU-17/,
  );
  await page.click(".inventory-workspace__detail button");
  console.log("PASS: scoped server evidence detail opened on demand");
  await step(
    "Evidence confirmed",
    "Check evidence and dispatch Analyst",
    () =>
      !![...document.querySelectorAll(".inventory-workspace__case button")].find(
        (node) => node.textContent.trim() === "Validate Analyst result",
      ),
  );
  await step(
    "Analyst validated",
    "Validate Analyst result",
    () =>
      !![...document.querySelectorAll(".inventory-workspace__case button")].find(
        (node) => node.textContent.trim() === "Check evidence and record verdict",
      ),
  );
  await step(
    "First verdict recorded",
    "Check evidence and record verdict",
    () => !!document.querySelector(".inventory-workspace__report"),
  );
  const firstReport = await page.$eval(".inventory-workspace__report", (node) => node.innerText);
  assert.match(firstReport, /Final report · revise/);
  assert.match(firstReport, /Discrepancy 3 · Explained 2 · Unexplained 1/);
  await page.type(".inventory-workspace__report input", "complete");
  await page.evaluate(() =>
    [...document.querySelectorAll(".inventory-workspace__report button")]
      .find((node) => node.textContent.trim() === "Start one revision")
      .click(),
  );
  await page.waitForFunction(
    (oldId) =>
      document.querySelector(".inventory-workspace__scope")?.textContent.includes("inventory_") &&
      !document.querySelector(".inventory-workspace__scope")?.textContent.includes(oldId),
    { timeout: 30000 },
    incidentId,
  );
  incidentId = await page.$eval(".inventory-workspace__scope", (node) =>
    node.textContent.trim().split(" · ").at(-1),
  );
  assert.match(incidentId, /^inventory_/);
  await step(
    "Revision Planner validated",
    "Validate Planner output",
    () => !!document.querySelector(".inventory-workspace__tasks li:nth-child(2)"),
  );
  await step(
    "Revision source reads",
    "Collect inventory evidence",
    () => document.querySelectorAll(".inventory-workspace__evidence").length >= 4,
  );
  await step(
    "Revision evidence confirmed",
    "Check evidence and dispatch Analyst",
    () =>
      !![...document.querySelectorAll(".inventory-workspace__case button")].find(
        (node) => node.textContent.trim() === "Validate Analyst result",
      ),
  );
  await step(
    "Revision Analyst validated",
    "Validate Analyst result",
    () =>
      !![...document.querySelectorAll(".inventory-workspace__case button")].find(
        (node) => node.textContent.trim() === "Check evidence and record verdict",
      ),
  );
  await step(
    "Final verdict recorded",
    "Check evidence and record verdict",
    () => !!document.querySelector(".inventory-workspace__report"),
  );
  const report = await page.$eval(".inventory-workspace__report", (node) => node.innerText);
  assert.match(report, /Final report · pass/);
  assert.match(
    await page.$eval(".inventory-workspace__headline", (node) => node.textContent),
    /Verdict: pass/,
  );
  assert.match(report, /Discrepancy 3/);
  assert.match(report, /Unexplained 0/);
  assert.deepEqual(prompts, [
    "planner",
    "analyst",
    "analyst",
    "critic",
    "planner",
    "analyst",
    "analyst",
    "critic",
  ]);
  const persisted = await (
    await fetch(`${origin}/api/runtime/investigations/${incidentId}`)
  ).json();
  assert.equal(persisted.investigation.report.verdict, "pass");
  assert.equal(persisted.investigation.synthetic, true);
  assert.equal(persisted.investigation.reasoning.stage, "verified");
  assert.equal(persisted.investigation.reasoning.attempt, 2);
  assert.equal(persisted.investigation.reasoning.remainingAttempts, 0);
  const groupAfter = await (await fetch(`${origin}/api/runtime/office-group`)).json();
  assert(
    groupAfter.messages.some(
      (message) => message.incidentId === started.incidentId && message.content.includes("REVISE"),
    ),
  );
  assert(
    groupAfter.messages.some(
      (message) => message.incidentId === incidentId && message.content.includes("PASS"),
    ),
  );
  assert(groupAfter.messages.some((message) => message.content.includes("SYNTHETIC DATA")));
  const reasoningText = await page.$eval(
    '[aria-label="Persisted reasoning"]',
    (node) => node.textContent,
  );
  for (const text of [
    "Reasoning attempt 2 of 2",
    "Deterministic checks",
    "Competing hypotheses",
    "ACCEPT",
    "Revision history",
    "Trusted verification reference",
  ])
    assert(reasoningText.includes(text), `Missing reasoning visibility: ${text}`);
  const screenshotPath = join(process.cwd(), "..", "artifacts", "inventory-browser-acceptance.png");
  await mkdir(join(process.cwd(), "..", "artifacts"), { recursive: true });
  await (
    await page.$(".inventory-workspace__report")
  ).screenshot({
    path: screenshotPath,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-dock-id="operations"]', { timeout: 60000 });
  await page.click('[data-dock-id="operations"]');
  await page.waitForFunction(() =>
    document.querySelector(".task-composer article")?.textContent.includes("approval required"),
  );
  assert.equal(await page.$eval(".legacy-inventory", (node) => node.open), true);
  console.log("PASS: composer route and selected task survive reload");
  await page.waitForFunction(
    () => document.querySelector(".inventory-workspace__report")?.textContent.includes("pass"),
    { timeout: 30000 },
  );
  const summary = await page.$eval(".office-ledger__summary", (node) => node.textContent.trim());
  assert.match(summary, /0 running/);
  console.log("PASS: reconnect recovered persisted verdict");
  assert.equal(
    await page.$eval(".inventory-workspace__select select", (node) => node.value),
    incidentId,
  );
  assert.match(
    await page.$eval('[aria-label="Persisted reasoning"]', (node) => node.textContent),
    /Reasoning attempt 2 of 2/,
  );
  console.log("PASS: persisted reasoning and selected revision recovered after reload");
  const groupRecovered = await (await fetch(`${origin}/api/runtime/office-group`)).json();
  assert.equal(groupRecovered.messages.filter((message) => message.id === started.id).length, 1);
  assert.equal(
    (await (await fetch(`${origin}/api/runtime/investigations`)).json()).investigations.filter(
      (item) => item.incidentId === started.incidentId,
    ).length,
    1,
  );
  await page.click(".hud-chat-dock__btn");
  await page.waitForSelector(".hud-chat-input-row textarea:not([disabled])");
  await page.type(".hud-chat-input-row textarea", "Outline team roles for tomorrow");
  await page.click(".hud-chat-input-row button");
  await page.waitForFunction(
    () =>
      document.querySelector(".hud-chat")?.textContent.includes("Outline team roles for tomorrow"),
    { timeout: 30000 },
  );
  const general = await (await fetch(`${origin}/api/runtime/office-group`)).json();
  const generalTurn = general.messages.find(
    (message) => message.content === "Outline team roles for tomorrow",
  );
  assert(generalTurn && generalTurn.participants.length > 0 && !generalTurn.officeIntent);
  console.log("PASS: ordinary Text message still uses the office group");
  await page.click('[data-dock-id="operations"]');
  await page.waitForSelector(".office-ledger");
  await page.setViewport({ width: 390, height: 844 });
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    panel: document.querySelector(".office-ledger").getBoundingClientRect().toJSON(),
  }));
  assert(
    layout.pageWidth <= layout.width &&
      layout.panel.left >= 0 &&
      layout.panel.right <= layout.width,
  );
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
  console.log("PASS: mobile verdict fits viewport", layout);
  console.log(
    JSON.stringify({
      incidentId,
      report,
      synthetic: true,
      provider: "isolated-mock",
      screenshot: "../artifacts/inventory-browser-acceptance.png",
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  tasks?.close();
  await app.close();
}
