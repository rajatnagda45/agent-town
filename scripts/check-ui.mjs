import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
const origin = process.env.OFFICE_CHECK_URL ?? "http://localhost:3000";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".topbar-agent-pill");
  await page.click('[data-dock-id="connection"]');
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Connect"),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Connect")
      .click(),
  );
  await page.waitForFunction(
    () => document.querySelector(".hud-pill--connection")?.textContent.includes("Online"),
    { timeout: 20000 },
  );

  await page.click('[data-dock-id="workers"]');
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "Manage Seats")
      .click(),
  );
  await page.waitForSelector("#team-name");
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: join(tmpdir(), "agent-town-team-desktop.png") });
  await page.click("#team-name");
  await page.keyboard.press("End");
  await page.keyboard.type(" draft");
  await page.click(".team-roster .seat-card:nth-child(2)");
  assert.equal(await page.$eval("#team-name", (e) => e.value), "Bob");
  await page.click(".team-roster .seat-card:first-child");
  assert.equal(await page.$eval("#team-name", (e) => e.value), "Alice draft");
  await page.click('[aria-label="Close seat manager"]');
  await page.waitForSelector('[role="alertdialog"]');
  await page.evaluate(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Keep editing").click(),
  );
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(tmpdir(), "agent-town-team-phone.png") });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click('[aria-label="Close seat manager"]');
  await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Discard changes")
      .click(),
  );
  await page.setViewport({ width: 1440, height: 1000 });
  const clickText = (text) =>
    page.evaluate(
      (text) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text).click(),
      text,
    );
  await clickText("Manage Seats");
  await page.click(".team-roster .seat-card:nth-child(5)");
  await page.type("#team-name", "UI test colleague");
  await page.type("#team-role", "Reviewer");
  await clickText("Assign Character");
  await page.waitForFunction(() =>
    document
      .querySelector(".team-roster .seat-card:nth-child(5)")
      .textContent.includes("UI test colleague"),
  );
  await page.click('[aria-label="Close seat manager"]');
  await page.reload({ waitUntil: "networkidle2" });
  await page.click('[data-dock-id="workers"]');
  await clickText("Manage Seats");
  await page.click(".team-roster .seat-card:nth-child(5)");
  assert.equal(await page.$eval("#team-name", (e) => e.value), "UI test colleague");
  await clickText("Unassign");
  await clickText("Unassign seat");
  await page.waitForFunction(() =>
    document
      .querySelector(".team-roster .seat-card:nth-child(5)")
      .textContent.includes("Vacant Seat"),
  );
  await page.click('[aria-label="Close seat manager"]');
  await page.click(".hud-chat-dock__btn");
  await page.click('[title="Switch session"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".session-dropdown"), null);
  await page.type('[aria-label="Message"]', "Reply with exactly UI_CHECK_OK");
  await page.click('[aria-label="Send message"]');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".hud-chat__bubble--assistant")].some((el) =>
        el.textContent.includes("UI_CHECK_OK"),
      ),
    { timeout: 45000 },
  );
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: join(tmpdir(), "agent-town-chat-desktop.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: isolated drafts, discard cancellation, responsive management, session Escape, real gateway chat, no page errors. Screenshots in",
    tmpdir(),
  );
} finally {
  await browser.close();
}
