import assert from "node:assert/strict";
import puppeteer from "puppeteer";
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto("http://localhost:3000/app");
  await page.waitForFunction(
    () => document.querySelector('[title="Switch office view"]')?.disabled === false,
    { timeout: 60000 },
  );
  const pause = () => new Promise((r) => setTimeout(r, 500));
  const width = () => page.$eval(".office-world", (e) => e.getBoundingClientRect().width);
  const clickText = async (text) => {
    await page.evaluate((t) => {
      const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === t);
      if (!b) throw Error(t);
      b.click();
    }, text);
    await pause();
  };
  for (const w of [1920, 1440, 1024, 768, 390]) {
    await page.setViewport({ width: w, height: 1000 });
    await pause();
    assert.equal(Math.round(await width()), w, "closed rail width");
    await page.click('[data-dock-id="workers"]');
    await pause();
    if (w >= 1280) assert((await width()) < w - 300);
    await clickText("Full View");
    assert.equal(Math.round(await width()), w, "immersive width");
    await page.click(".hud-chat-dock__btn");
    await pause();
    await page.keyboard.press("Escape");
    await pause();
    await page.keyboard.press("Escape");
    await pause();
    assert(await page.$(".team-directory"), "restores previous panel");
    await page.click('[data-dock-id="workers"]');
    await pause();
    const sizes = await page.$eval(".office-three canvas", (c) => ({
      css: c.clientWidth,
      buffer: c.width,
    }));
    assert.equal(sizes.css, w);
    assert(sizes.buffer >= w && sizes.buffer <= w * 1.5 + 1);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/viewport-${w}.png` });
  }
  await page.setViewport({ width: 1440, height: 1000 });
  await pause();
  await clickText("Full View");
  await page.click('[aria-label="Browser fullscreen"]');
  await pause();
  assert(await page.evaluate(() => !!document.fullscreenElement));
  await page.evaluate(() => document.exitFullscreen());
  await pause();
  assert.equal(await page.$(".office-app--immersive"), null);
  await page.click('[data-dock-id="workers"]');
  await pause();
  await clickText("Manage Seats");
  await page.screenshot({ path: "/tmp/viewport-team.png" });
  const layout = await page.evaluate(() => {
    const editor = document.querySelector(".team-editor__scroll");
    return {
      scroll: editor.scrollHeight > editor.clientHeight,
      profile: document.querySelector(".team-detail").clientHeight,
    };
  });
  assert(layout.scroll && layout.profile > 250);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewport widths, panel restoration, immersive Escape, fullscreen external exit, drawing buffers, team scrolling; no page exceptions",
  );
} finally {
  await browser.close();
}
