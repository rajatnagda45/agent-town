import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";

// Real gateway and simulation in an isolated profile. Add --task for a harmless live task.
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
  let blocked = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.text().includes("Office route unavailable")) {
      blocked++;
      console.log(m.text());
    }
  });
  await page.setViewport({ width: 1680, height: 1000 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "networkidle2" });
  const click = async (text) => {
    const handle = await page.evaluateHandle(
      (text) =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim().toLowerCase() === text.toLowerCase(),
        ),
      text,
    );
    await handle.asElement().click();
    await handle.dispose();
  };
  await page.click('[data-dock-id="connection"]');
  await click("Connect");
  await page.waitForFunction(() =>
    document.querySelector(".hud-pill--connection")?.textContent.includes("Online"),
  );
  await page.click('[data-dock-id="connection"]');
  await page.click('[aria-label="Ambient office life"]');
  await page.click(".office-control-option:last-child");
  const activities = new Set();
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20000));
    const current = await page.$$eval(".office-actor-label", (nodes) =>
      nodes.map((n) => n.dataset.activity),
    );
    current.forEach((a) => activities.add(a));
    console.log(
      `Office observation ${(i + 1) * 20}s: ${[...activities].join(", ")}; blocked routes ${blocked}`,
    );
  }
  assert(activities.size >= 3, "Expected varied real ambient states");
  assert.equal(blocked, 0, "Unexpected blocked route during observation");
  await page.click('[aria-label="Ambient office life"]');
  await page.click(".office-control-option");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".office-actor-label")].every(
      (n) => n.dataset.activity === "idle",
    ),
  );
  await page.click('[aria-label="Exterior lighting"]');
  await page.click(".office-control-option:last-child");
  await page.click('[aria-label="Exterior lighting"]');
  await page.click(".office-control-option");
  if (process.argv.includes("--task")) {
    await click("Chat");
    await page.type(
      "textarea",
      "Reply with exactly OFFICE_POLISH_OK. This is an integration check.",
    );
    await page.click('button[title="Send"]');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".hud-chat__bubble--assistant .hud-chat__content")].some(
          (n) => n.textContent.trim() === "OFFICE_POLISH_OK",
        ),
      { timeout: 60000 },
    );
    console.log("PASS: genuine gateway task returned OFFICE_POLISH_OK.");
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: autonomous routines, destination recovery, pause setting, lighting controls, and no browser errors.",
  );
  console.log("Measured renderer:", await page.$eval(".office-three", (n) => ({ ...n.dataset })));
} finally {
  await browser.close();
}
