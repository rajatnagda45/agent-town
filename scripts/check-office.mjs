import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer";

// Uses an isolated browser profile and the real app. No fake agent or voice responses.
const origin = process.env.OFFICE_CHECK_URL ?? "http://localhost:3000";
const installedChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH ??
  (existsSync(installedChrome) ? installedChrome : undefined);
const browser = await puppeteer.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width: 1680, height: 1000 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".office-actor-label");
  const names = await page.$$eval(".topbar-agent-pill__name", (nodes) =>
    nodes.map((n) => n.textContent),
  );
  const actorNames = await page.$$eval(".office-actor-label strong", (nodes) =>
    nodes.map((n) => n.textContent),
  );
  for (const name of names) assert(actorNames.includes(name), `Missing 3D coworker: ${name}`);
  const click = async (text) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim().toLowerCase() === text.toLowerCase(),
      );
      if (!button) throw new Error(`Missing button: ${text}`);
      button.click();
    }, text);
  for (const name of names) {
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll(".topbar-agent-pill")]
          .find((b) => b.querySelector(".topbar-agent-pill__name")?.textContent === name)
          .click(),
      name,
    );
    await page.waitForFunction(
      (name) =>
        document
          .querySelector(".hud-topright-flyout")
          ?.textContent.toLowerCase()
          .includes(`talk to ${name.toLowerCase()}`),
      {},
      name,
    );
  }
  await page.click('[data-dock-id="workers"]');
  await click("Manage seats");
  await page.waitForSelector('[role="dialog"]');
  await page.keyboard.press("Escape");
  await click("2D view");
  await page.waitForSelector(".office-stage--classic");
  await click("3D view");
  await page.waitForSelector(".office-stage--3d");
  await click("Chat");
  await page.waitForSelector(".hud-chat-dock__panel");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: join(tmpdir(), "agent-town-office-phone.png") });
  await click("Chat");
  await page.setViewport({ width: 1680, height: 1000 });
  await page.waitForFunction(
    () => Number(document.querySelector(".office-three")?.dataset.frameMs) > 0,
  );
  await page.screenshot({ path: join(tmpdir(), "agent-town-office.png") });
  assert.deepEqual(errors, []);
  const metrics = await page.$eval(".office-three", (node) => ({ ...node.dataset }));
  console.log(
    "PASS: live actor identities, all worker profiles, management dismissal, 2D/3D switch, chat, reduced motion, phone layout, and no page errors.",
  );
  console.log("Local render measurements (not a hardware guarantee):", metrics);
  console.log(
    "Screenshots:",
    join(tmpdir(), "agent-town-office.png"),
    join(tmpdir(), "agent-town-office-phone.png"),
  );
} finally {
  await browser.close();
}
