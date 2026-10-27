import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({ headless: true });
try {
  for (const onboardingDone of [true, false]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewport({ width: 800, height: 760 });
    await page.evaluateOnNewDocument((done) => {
      if (done) localStorage.setItem("agent-town:onboarding-done", "true");
    }, onboardingDone);
    await page.goto("http://localhost:3000/app", { waitUntil: "networkidle0" });
    const button = '[data-dock-id="connection"]';
    await page.waitForSelector(button);
    const before = await page.$eval(button, (el) => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { pressed: el.getAttribute("aria-pressed"), hit: hit?.outerHTML };
    });
    await page.click(`${button} img`);
    console.log(
      JSON.stringify({
        onboardingDone,
        before,
        after: await page.evaluate(() => ({
          pressed: document
            .querySelector('[data-dock-id="connection"]')
            .getAttribute("aria-pressed"),
          panel: document.querySelector(".hud-topright-flyout")?.innerText,
        })),
        errors,
      }),
    );
    assert.equal(await page.$eval(button, (el) => el.getAttribute("aria-pressed")), "true");
    assert.match(
      await page.$eval(".hud-topright-flyout", (el) => el.innerText),
      /Server-managed gateway/i,
    );
    await page.click(button);
    assert.equal(await page.$(".hud-topright-flyout"), null);
    await page.click(".hud-chat-dock__btn");
    await page.click(button);
    assert.equal(await page.$(".hud-chat-dock__panel"), null);
    assert.equal(await page.$eval(button, (el) => el.getAttribute("aria-pressed")), "true");
    await page.setViewport({ width: 390, height: 760 });
    await page.click(button);
    await page.click(`${button} img`);
    assert.equal(await page.$eval(button, (el) => el.getAttribute("aria-pressed")), "true");
    if (onboardingDone) {
      const connect = await page.$(".hud-topright-flyout .pixel-button");
      await connect.click();
      await page
        .waitForFunction(
          () => {
            const text = document.querySelector(".hud-topright-flyout")?.innerText;
            return !text || /failed|requires|unreachable|too many|not supported/i.test(text);
          },
          { timeout: 25000 },
        )
        .catch(() => {});
      console.log(
        "Gateway result:",
        await page.evaluate(() => ({
          panel:
            document.querySelector(".hud-topright-flyout")?.innerText ??
            "Panel closed after successful connection",
          status: document.querySelector(".layout-bottombar")?.innerText,
        })),
      );
    }
    await context.close();
  }
} finally {
  await browser.close();
}
