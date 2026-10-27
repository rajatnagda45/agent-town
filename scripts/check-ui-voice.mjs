import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";

// Real provider audio, isolated profile, synthetic microphone; no user audio is recorded.
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined),
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("agent-town:onboarding-done", "true");
    window.__uiAudio = { chunks: 0, ended: 0, peak: 0 };
    const Context = window.AudioContext;
    window.AudioContext = class extends Context {
      constructor(...args) {
        super(...args);
        const create = this.createBufferSource.bind(this);
        this.createBufferSource = () => {
          const source = create();
          const start = source.start.bind(source);
          source.start = (...args) => {
            window.__uiAudio.chunks++;
            if (source.buffer)
              for (const value of source.buffer.getChannelData(0))
                window.__uiAudio.peak = Math.max(window.__uiAudio.peak, Math.abs(value));
            source.addEventListener("ended", () => window.__uiAudio.ended++);
            return start(...args);
          };
          return source;
        };
      }
    };
  });
  await page.goto(`${process.env.OFFICE_CHECK_URL ?? "http://localhost:3000"}/app`, {
    waitUntil: "networkidle2",
  });
  await page.click(".hud-chat-dock__btn");
  await page.click(".chat-mode-switch button:nth-child(2)");
  await page.waitForFunction(() => !document.querySelector(".chat-voice-buttons button")?.disabled);
  await page.click(".chat-voice-buttons button");
  await page.waitForFunction(() => window.__uiAudio.ended > 0 && window.__uiAudio.peak > 0, {
    timeout: 45000,
  });
  await page.waitForFunction(
    () => document.querySelector(".chat-voice-state")?.textContent.includes("Listening"),
    { timeout: 20000 },
  );
  await page.click(".chat-voice-buttons button:first-child");
  await page.waitForFunction(() =>
    document.querySelector(".chat-voice-state")?.textContent.includes("muted"),
  );
  await page.click(".chat-end-call");
  await page.waitForFunction(() =>
    document.querySelector(".chat-voice-state")?.textContent.includes("Ready to talk"),
  );
  assert.equal(await page.$(".chat-end-call"), null);
  console.log(
    "PASS: real voice audio played, microphone mute and end-call returned to ready state.",
    await page.evaluate(() => window.__uiAudio),
  );
} finally {
  await browser.close();
}
