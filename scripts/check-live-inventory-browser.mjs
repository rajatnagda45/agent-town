import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer";

const origin = process.env.AGENT_TOWN_LIVE_URL ?? "http://127.0.0.1:3108";
const artifactDir = join(process.cwd(), "..", "artifacts", "nightshift-inventory");
const executablePath =
  process.env.AGENT_TOWN_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const goal =
  "Explain the 3-unit shortage for SKU-17 at BIN-A using evidence. Do not modify inventory.";
const timeout = 240_000;
const resumeIncidentId = process.env.AGENT_TOWN_RESUME_INCIDENT_ID;

const preflight = await (await fetch(`${origin}/api/runtime/inventory-eligibility`)).json();
assert.equal(preflight.ready, true, JSON.stringify(preflight));
assert.equal(preflight.readerConfigured, true);
assert.deepEqual(
  preflight.roles.map((item) => [item.role, item.seatId, item.enforcementApproved]),
  [
    ["nightshift-planner", "plan", true],
    ["nightshift-analyst", "analyze", true],
    ["nightshift-critic", "review", true],
  ],
);
const initial = await (await fetch(`${origin}/api/runtime/state`)).json();
assert.equal(initial.provider, "nightshift");
assert.equal(initial.connection, "connected");
console.log(
  JSON.stringify({ browser: "Chrome", provider: initial.provider, model: initial.model }),
);

let browser;
let firstIncidentId;
let revisionIncidentId;
try {
  browser = await puppeteer.launch({
    headless: false,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  assert.match(await browser.version(), /^Chrome\//);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.request().method() === "POST" && !response.ok())
      console.error(`browser POST ${response.status()} ${response.url()}`);
  });
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".office-stage--classic") ||
      document.querySelector('.office-stage--3d [title="Switch office view"]:not(:disabled)'),
    { timeout: 60_000 },
  );
  const view = await page.$('.office-stage--3d [title="Switch office view"]:not(:disabled)');
  if (view) await view.click();
  await page.waitForSelector('[data-dock-id="operations"]', { timeout: 60_000 });
  await page.click('[data-dock-id="operations"]');
  if (!(await page.$eval(".legacy-inventory", (node) => node.open)))
    await page.click(".legacy-inventory > summary");
  await page.waitForSelector(".inventory-workspace__form", { timeout: 30_000 });
  if (resumeIncidentId) {
    await page.waitForSelector(".inventory-workspace__select select", { timeout: 30_000 });
    await page.select(".inventory-workspace__select select", resumeIncidentId);
    await page.waitForFunction(
      (id) => document.querySelector(".inventory-workspace__scope")?.textContent.includes(id),
      { timeout: 30_000 },
      resumeIncidentId,
    );
    firstIncidentId = resumeIncidentId;
  } else {
    await page.type(".inventory-workspace textarea", goal);
    const fields = await page.$$(".inventory-workspace__form input");
    const values = ["incomplete", "SKU-17", "BIN-A", "12", "9", "0"];
    assert.equal(fields.length, values.length);
    for (let i = 0; i < fields.length; i++) {
      await fields[i].click({ clickCount: 3 });
      await fields[i].type(values[i]);
    }
    const submitted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/runtime/investigations" &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await page.click('.inventory-workspace__form button[type="submit"]');
    const response = await submitted;
    assert.equal(response.status(), 201, await response.text());
    firstIncidentId = (await response.json()).investigation.incidentId;
    await page.waitForFunction(
      (id) =>
        [...(document.querySelector(".inventory-workspace__select select")?.options ?? [])].some(
          (option) => option.value === id,
        ),
      { timeout: 30_000 },
      firstIncidentId,
    );
    await page.select(".inventory-workspace__select select", firstIncidentId);
    await page.waitForFunction(
      (id) => document.querySelector(".inventory-workspace__scope")?.textContent.includes(id),
      { timeout: 30_000 },
      firstIncidentId,
    );
  }
  assert.match(firstIncidentId, /^inventory_/);
  console.log(JSON.stringify({ firstIncidentId }));

  async function clickStage(label) {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll(".inventory-workspace__case button")].some(
          (button) => button.textContent.trim() === text && !button.disabled,
        ) || !!document.querySelector(".inventory-workspace [role='alert']"),
      { timeout },
      label,
    );
    const alert = await page
      .$eval(".inventory-workspace [role='alert']", (node) => node.textContent)
      .catch(() => null);
    if (alert) throw new Error(alert);
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll(".inventory-workspace__case button")]
          .find((button) => button.textContent.trim() === text)
          .click(),
      label,
    );
    console.log(`clicked: ${label}`);
  }
  async function viewIncident(id) {
    const response = await fetch(`${origin}/api/runtime/investigations/${id}`);
    assert.equal(response.status, 200);
    return (await response.json()).investigation;
  }
  async function finishCase(id, expectedVerdict, expectedExplained) {
    const before = await viewIncident(id);
    if (before.tasks.some((task) => task.status === "waiting_planner_validation"))
      await clickStage("Validate Planner output");
    if (!before.readsCollected) await clickStage("Collect inventory evidence");
    await page.waitForSelector(".inventory-workspace__synthetic", { timeout: 30_000 });
    assert.equal(
      await page.$eval(".inventory-workspace__synthetic", (node) => node.textContent.trim()),
      "SYNTHETIC DATA",
    );
    const collected = await viewIncident(id);
    assert.equal(collected.readsCollected, true);
    assert(collected.evidence.length >= 4);
    assert(
      collected.evidence.every(
        (item) => item.syntheticLabel && item.source.startsWith("synthetic:"),
      ),
    );
    if (!collected.evidenceConfirmed) await clickStage("Check evidence and dispatch Analyst");
    if (!collected.analystValidated) await clickStage("Validate Analyst result");
    if (!collected.report) await clickStage("Check evidence and record verdict");
    await page.waitForFunction(() => !!document.querySelector(".inventory-workspace__report"), {
      timeout: 30_000,
    });
    const result = await viewIncident(id);
    assert.equal(result.report?.verdict, expectedVerdict, JSON.stringify(result.report));
    assert.equal(result.report.reconciliation?.discrepancy, 3);
    assert.equal(result.report.reconciliation?.explained, expectedExplained);
    assert(result.report.evidenceIds.length > 0);
    assert(
      result.report.evidenceIds.every((evidenceId) =>
        result.evidence.some((item) => item.evidenceId === evidenceId),
      ),
    );
    console.log(
      JSON.stringify({
        incidentId: id,
        verdict: result.report.verdict,
        reconciliation: result.report.reconciliation,
        evidenceCount: result.evidence.length,
        citedCount: result.report.evidenceIds.length,
        synthetic: result.synthetic,
      }),
    );
    return result;
  }

  const first = await finishCase(firstIncidentId, "revise", 2);
  assert.equal(first.report.reconciliation?.unexplained, 1);
  await page.type(".inventory-workspace__report input", "complete");
  const revised = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/runtime/investigations/${firstIncidentId}/revise` &&
      response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await clickStage("Start one revision");
  const revisionResponse = await revised;
  assert.equal(revisionResponse.status(), 200, await revisionResponse.text());
  revisionIncidentId = (await revisionResponse.json()).investigation.incidentId;
  await page.waitForFunction(
    (id) =>
      [...(document.querySelector(".inventory-workspace__select select")?.options ?? [])].some(
        (option) => option.value === id,
      ),
    { timeout: 30_000 },
    revisionIncidentId,
  );
  await page.select(".inventory-workspace__select select", revisionIncidentId);
  await page.waitForFunction(
    (id) => document.querySelector(".inventory-workspace__scope")?.textContent.includes(id),
    { timeout: 30_000 },
    revisionIncidentId,
  );
  console.log(JSON.stringify({ revisionIncidentId }));
  const final = await finishCase(revisionIncidentId, "pass", 3);
  assert.equal(final.report.reconciliation?.unexplained, 0);
  assert.equal(final.revisionOf, firstIncidentId);
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: join(artifactDir, "live-chrome-final.png"), fullPage: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-dock-id="operations"]', { timeout: 60_000 });
  await page.click('[data-dock-id="operations"]');
  await page.waitForSelector(".inventory-workspace__select select", { timeout: 30_000 });
  await page.select(".inventory-workspace__select select", revisionIncidentId);
  await page.waitForFunction(
    () =>
      document.querySelector(".inventory-workspace__report")?.textContent.includes("pass") &&
      document.querySelector(".inventory-workspace__synthetic")?.textContent === "SYNTHETIC DATA",
    { timeout: 30_000 },
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify({ recovery: "passed", firstIncidentId, revisionIncidentId, url: page.url() }),
  );
} catch (error) {
  console.error(JSON.stringify({ firstIncidentId, revisionIncidentId, error: String(error) }));
  if (browser) {
    await mkdir(artifactDir, { recursive: true });
    const pages = await browser.pages();
    await pages
      .at(-1)
      ?.screenshot({ path: join(artifactDir, "live-chrome-failure.png"), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
}
