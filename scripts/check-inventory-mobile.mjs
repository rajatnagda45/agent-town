import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const origin = process.env.OFFICE_CHECK_URL ?? "http://127.0.0.1:3107";
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".office-stage--classic") ||
      document.querySelector('.office-stage--3d [title="Switch office view"]:not(:disabled)'),
    { timeout: 60000 },
  );
  const view = await page.$('.office-stage--3d [title="Switch office view"]:not(:disabled)');
  if (view) await view.click();
  await page.waitForSelector(".office-stage--classic", { timeout: 30000 });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  try {
    await page.waitForSelector('[data-dock-id="operations"]', { timeout: 30000 });
  } catch {
    throw new Error(
      `Office controls did not render: ${await page.title()}; ${(
        await page.evaluate(() => document.body.innerText)
      ).slice(0, 300)}; errors: ${errors.join(" | ")}`,
    );
  }
  await page.click('[data-dock-id="operations"]');
  if (!(await page.$eval(".legacy-inventory", (node) => node.open)))
    await page.click(".legacy-inventory > summary");
  await page.waitForSelector(".inventory-workspace__form");
  const layout = await page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      flyout: box(".hud-topright-flyout"),
      panel: box(".office-ledger"),
      form: box(".inventory-workspace__form"),
      input: box(".inventory-workspace__fields input"),
      button: box(".inventory-workspace__form button"),
    };
  });
  assert(layout.pageWidth <= layout.viewport, "Page overflows the mobile viewport");
  for (const [name, rect] of Object.entries(layout)) {
    if (typeof rect !== "object") continue;
    assert(rect.left >= 0 && rect.right <= layout.viewport, `${name} is clipped on mobile`);
    assert(rect.width >= 100, `${name} is too narrow on mobile`);
  }
  console.log("PASS: inventory form, panel and controls fit a 390px viewport", layout);
} finally {
  await browser.close();
}
