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
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${process.env.OFFICE_CHECK_URL ?? "http://localhost:3000"}/app/chat`);
  await page.waitForSelector(".center-conversation");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewport({ width, height: 1000 });
    await new Promise((r) => setTimeout(r, 500));
    const bounds = await page.$eval(".center-composer", (e) => {
      const b = e.getBoundingClientRect();
      return { bottom: b.bottom, right: b.right, left: b.left };
    });
    assert(bounds.bottom <= 1000 && bounds.left >= 0 && bounds.right <= width);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/chat-center-${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: dedicated chat responsive layout, composer bounds and no browser exceptions");
} finally {
  await browser.close();
}
