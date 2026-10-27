import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { existsSync } from "node:fs";
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
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(process.env.OFFICE_CHECK_URL ?? "http://localhost:3000/app", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(".office-controlbar", { timeout: 60000 });
  await page.waitForFunction(
    () => !document.querySelector('[title="Switch office view"]').disabled,
  );
  const pause = () => new Promise((r) => setTimeout(r, 300));
  const check = async (label) => {
    await pause();
    const bad = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          ".hud-flyout, .inventory-workspace input, .inventory-workspace textarea, .inventory-workspace button, .review-indicator",
        ),
      ]
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width && b.height && (b.right > innerWidth + 2 || b.left < -2);
        })
        .map((e) => e.className || e.tagName),
    );
    assert.deepEqual(bad, [], label + ": horizontal clipping");
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      label + ": page overflow",
    );
  };
  for (const id of ["connection", "music", "tasks", "operations", "workers"]) {
    await page.click('[data-dock-id="' + id + '"]');
    await check(id);
    await page.screenshot({ path: "/tmp/product-" + id + ".png" });
  }
  await page.type('[aria-label="Search team"]', "zzzz-no-person");
  assert(
    await page.$eval(".team-directory__list", (el) => el.textContent.includes("No seats match")),
  );
  await page.$eval('[aria-label="Search team"]', (el) => {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click('[data-dock-id="workers"]');
  await page.click(".review-indicator");
  await page.waitForSelector('[aria-label="Pending requests"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.$('[aria-label="Pending requests"]'), null);
  await page.click('[title="Switch office view"]');
  await page.waitForSelector(".office-stage--classic");
  assert(await page.$eval(".office-simulation", (el) => getComputedStyle(el).opacity !== "0"));
  await page.screenshot({ path: "/tmp/product-2d.png" });
  await page.click('[title="Switch office view"]');
  await page.waitForSelector(".office-stage--3d");
  for (const width of [1024, 768, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.click('[data-dock-id="operations"]');
    await check("operations " + width);
    await page.screenshot({ path: "/tmp/product-operations-" + width + ".png" });
    // Browser validation must reject an empty investigation without submitting.
    assert.equal(await page.$eval(".inventory-workspace__form", (el) => el.checkValidity()), false);
    await page.click('[data-dock-id="operations"]');
    await page.click(".hud-chat-dock__btn");
    await check("chat " + width);
    await page.screenshot({ path: "/tmp/product-chat-" + width + ".png" });
    await page.click(".hud-chat-dock__btn");
  }
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.click('[data-dock-id="workers"]');
  await check("reduced motion");
  assert.deepEqual(errors, [], "browser exceptions");
  console.log(
    "PASS: major panels, directory search, reviews Escape, real 2D/3D pointer switching, responsive bounds at 1440/1024/768/390, invalid form, reduced motion; no page exceptions",
  );
} finally {
  await browser.close();
}
