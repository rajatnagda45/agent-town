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
  const errors = [],
    failed = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url().split("?")[0]}`);
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto("http://localhost:3000/app/chat");
  await page.waitForSelector(".center-conversation");
  const pause = () => new Promise((r) => setTimeout(r, 350));
  const clickText = async (text) => {
    await page.evaluate((text) => {
      const el = [...document.querySelectorAll("button")].find(
        (e) => e.textContent.trim() === text,
      );
      if (!el) throw Error(`Missing button ${text}`);
      el.click();
    }, text);
    await pause();
  };
  await pause();
  const agents = await page.$$eval(".center-conversation", (els) =>
    els.map((e) => e.querySelector("strong")?.textContent),
  );
  for (const name of agents) {
    await page.evaluate(
      (name) =>
        [...document.querySelectorAll(".center-conversation")]
          .find((e) => e.querySelector("strong")?.textContent === name)
          ?.click(),
      name,
    );
    await pause();
    assert.equal(await page.$eval("h1", (e) => e.textContent), name);
  }
  await page.click('[aria-label="Toggle task inspector"]');
  assert(await page.$(".chat-center--wide"));
  await page.click('[aria-label="Toggle task inspector"]');
  await clickText("Refresh history");
  await page.type('[aria-label="Search message history"]', "no-such-message-934985");
  await pause();
  assert(await page.$eval(".center-empty", (e) => e.textContent.includes("No matching messages")));
  await clickText("Clear search");
  await page.evaluate(() =>
    [...document.querySelectorAll(".center-tabs button")]
      .find((e) => e.textContent.startsWith("All tasks"))
      .click(),
  );
  await pause();
  await page.select('[aria-label="Sort tasks"]', "oldest");
  await page.select('[aria-label="Filter tasks by agent"]', "");
  await page.type('[aria-label="Search conversations and tasks"]', "no-task-657432");
  await pause();
  assert.equal(await page.$$(".center-task-card").then((a) => a.length), 0);
  await page.click('[aria-label="Search conversations and tasks"]', { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await pause();
  const count = await page.$$(".center-task-card").then((a) => a.length);
  if (count) {
    await page.click(".center-task-card");
    await pause();
    await page.waitForSelector(".center-task-detail");
    await clickText("Open related conversation");
    await pause();
  }
  await clickText("Conversation");
  await pause();
  // Copy the stable task ID and verify the real clipboard result.
  await browser
    .defaultBrowserContext()
    .overridePermissions("http://localhost:3000", [
      "clipboard-read",
      "clipboard-write",
      "clipboard-sanitized-write",
    ]);
  const copy = await page.$('[aria-label="Copy task ID"]');
  if (copy) {
    await page.bringToFront();
    await copy.click();
    await pause();
    console.log("Clipboard control:", await copy.evaluate((e) => e.textContent));
    const id = await page.$eval(".center-id code", (e) => e.textContent);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id);
  }
  const inventory = await page.evaluate(async () => {
    let offset = 0,
      rows = [];
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`/api/runtime/tasks?limit=200&offset=${offset}`).then((r) => r.json());
      rows.push(...r.tasks);
      offset = r.nextOffset;
      if (r.tasks.length < 200) break;
    }
    const ids = new Set(rows.map((t) => t.taskId));
    const requests = new Map();
    for (const t of rows) requests.set(t.message, (requests.get(t.message) || 0) + 1);
    return {
      records: rows.length,
      distinctIds: ids.size,
      repeatedRequestGroups: [...requests.values()].filter((n) => n > 1).length,
    };
  });
  assert.equal(inventory.records, inventory.distinctIds);
  console.log("Task identity audit:", JSON.stringify(inventory));
  await page.screenshot({ path: "/tmp/readiness-desktop.png" });
  // Read diagnostics after populated historical task/related conversation selection.
  const diagnostic = await page.evaluate(() => {
    const root = document.querySelector("nextjs-portal")?.shadowRoot;
    root?.querySelector("[data-issues-open]")?.click();
    return root?.querySelector("[data-issues-count]")?.textContent ?? "0";
  });
  await pause();
  const issueText = await page.evaluate(() => {
    const root = document.querySelector("nextjs-portal")?.shadowRoot;
    return root?.querySelector("[data-nextjs-dialog]")?.textContent ?? "";
  });
  console.log(JSON.stringify({ diagnostic, issueText, errors, failed }));
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  assert.equal(diagnostic, "0");
  await page.keyboard.press("Escape");
  for (const width of [1024, 768, 390]) {
    await page.setViewport({ width, height: 1000 });
    await pause();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/readiness-${width}.png` });
  }
  // Inject a recoverable read failure only; no runtime records are changed.
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluate(() =>
    [...document.querySelectorAll(".center-conversation")]
      .find((e) => e.querySelector("strong")?.textContent === "Office Group")
      .click(),
  );
  await pause();
  await page.type("#center-draft", "Preserve this unsent draft");
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    if (r.url().includes("/api/runtime/office-group") && r.method() === "GET")
      r.respond({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected history outage" }),
      });
    else r.continue();
  });
  await clickText("Refresh history");
  await pause();
  assert(
    await page.$eval(".center-messages", (e) => e.textContent.includes("Injected history outage")),
  );
  assert.equal(await page.$eval("#center-draft", (e) => e.value), "Preserve this unsent draft");
  page.removeAllListeners("request");
  await page.setRequestInterception(false);
  await clickText("Refresh history");
  assert.equal(await page.$eval("#center-draft", (e) => e.value), "Preserve this unsent draft");
  console.log(
    `PASS: ${agents.join(", ")}, refresh, empty search, task search/sort/inspector/related conversation, diagnostic panel and responsive bounds; ${count} loaded task cards inspected`,
  );
} finally {
  await browser.close();
}
