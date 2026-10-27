import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer";
import { prepareFunctionalOffice } from "./browser-functional-office.mjs";
import { browserCheckOptions } from "./browser-check-options.mjs";

// Isolated headless browser, synthetic microphone, fake Gemini transport: no paid calls or user audio.
const origin = process.env.AGENT_TOWN_TEST_ORIGIN ?? "http://127.0.0.1:3000";
assert(
  process.env.AGENT_TOWN_MOCK_VOICE === "1" && process.env.AGENT_TOWN_MOCK_VOICE_NONCE,
  "Run pnpm phase3:check against its isolated mocked server. This check refuses personal/live servers.",
);
const proof = await fetch(`${origin}/api/__test/mock-voice`);
assert(proof.ok, "The target server does not have a mocked voice provider.");
const identity = await proof.json();
assert(
  identity.mocked === true && identity.nonce === process.env.AGENT_TOWN_MOCK_VOICE_NONCE,
  "The target server's mock-provider proof does not match.",
);
const browser = await puppeteer.launch(
  browserCheckOptions(["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]),
);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width: 800, height: 760 });
  await page.setRequestInterception(true);
  let provisions = 0;
  const transcripts = [];
  page.on("request", async (request) => {
    if (request.url() === `${origin}/api/voice/session`) {
      if (request.method() === "POST") {
        provisions++;
        const selection = JSON.parse(request.postData());
        assert.equal(typeof selection.bindingRevision, "number");
        assert.equal(selection.agent, undefined, "Client supplied authoritative context");
        const provision = await fetch(`${origin}/api/voice/session`, {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(selection),
        });
        assert.equal(provision.status, 200, "Mocked server voice provisioning failed");
        const data = await provision.json();
        assert(
          data.callId && data.token.startsWith("auth_tokens/test-"),
          "Expected mocked provider token and durable call identity",
        );
        await request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      } else
        await request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured: true }),
        });
    } else if (request.url() === `${origin}/api/runtime/voice/transcripts`) {
      transcripts.push(JSON.parse(request.postData()));
      await request.continue();
    } else await request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem("agent-town:onboarding-done", "true");
    localStorage.setItem("agent-town:active-session-key", JSON.stringify("agent:main:main"));
    localStorage.setItem(
      "agent-town:sessions",
      JSON.stringify([
        { key: "agent:main:main", label: "Session 1", createdAt: "2026-10-25T00:00:00Z" },
      ]),
    );
    localStorage.setItem(
      "agent-town:tasks",
      JSON.stringify([
        {
          taskId: "fixture-task",
          runId: "fixture-run",
          actorName: "Alice",
          sessionKey: "agent:main:main",
          status: "completed",
          message: "Draft an AI intern email",
          result: "Draft ready",
          createdAt: "2026-10-25T00:00:00Z",
        },
      ]),
    );
    localStorage.setItem(
      "agent-town:chat",
      JSON.stringify([
        {
          id: "fixture-message",
          runId: "fixture-run",
          actorName: "Alice",
          role: "assistant",
          sessionKey: "agent:main:main",
          content:
            "Your AI intern email draft is ready.\n\nHi Hiring Team,\nI am writing to apply for your AI internship.\n\nBest regards,\n[Your Name]",
          timestamp: "2026-10-25T00:00:00Z",
        },
      ]),
    );
    window.__voiceTestSockets = [];
    window.__voiceTestTracks = [];
    const nativeMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await nativeMedia(options);
      window.__voiceTestTracks.push(...stream.getTracks());
      return stream;
    };
    const NativeWebSocket = window.WebSocket;
    class FakeSocket extends EventTarget {
      readyState = 0;
      sent = [];
      constructor(url) {
        super();
        this.name = new URL(url).searchParams.get("access_token")?.split("-").at(-1) ?? "Alice";
        window.__voiceTestSockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.emit("open", new Event("open"));
        }, 0);
      }
      emit(type, event) {
        this.dispatchEvent(event);
        this[`on${type}`]?.(event);
      }
      receive(payload) {
        this.emit("message", new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
      send(raw) {
        const message = JSON.parse(raw);
        this.sent.push(message);
        if (message.setup) setTimeout(() => this.receive({ setupComplete: {} }), 0);
        if (message.clientContent?.turnComplete && !this.greeted) {
          this.greeted = true;
          setTimeout(
            () =>
              this.receive({
                serverContent: {
                  outputTranscription: {
                    text: `Hi, I'm ${this.name}. What would you like to work on?`,
                  },
                  turnComplete: true,
                },
              }),
            10,
          );
        } else if (message.clientContent?.turnComplete)
          setTimeout(() => this.receive({ serverContent: { turnComplete: true } }), 10);
      }
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit("close", new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = function (url, protocols) {
      return String(url).includes("generativelanguage.googleapis.com")
        ? new FakeSocket(url)
        : new NativeWebSocket(url, protocols);
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[href="/app"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.click('a[href="/app"]'),
  ]);
  assert.equal(new URL(page.url()).pathname, "/app");
  await prepareFunctionalOffice(page);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".topbar-agent-pill")].some((button) =>
      button.title.startsWith("Alice"),
    ),
  );
  await page.click(".hud-chat-dock__btn");
  await page.waitForFunction(() =>
    document.querySelector(".chat-agent-row")?.textContent.includes("Office group"),
  );
  assert.equal(await page.$("#chat-agent"), null, "Text mode must not select a voice agent");
  await page.click(".chat-mode-switch button:nth-child(2)");
  await page.waitForSelector("#chat-agent");
  assert.equal(
    await page.$eval("#chat-agent", (select) => select.selectedOptions[0].textContent),
    "Alice",
  );
  await page.waitForFunction(() => !document.querySelector(".chat-voice-buttons button").disabled);
  await page.click(".chat-voice-buttons button");
  await page.waitForFunction(() =>
    document.querySelector(".chat-voice-state").textContent.includes("Listening"),
  );
  await page.waitForFunction(() =>
    document.querySelector('[role="log"]').textContent.includes("Hi, I'm Alice"),
  );
  assert.equal(provisions, 1);
  await page.evaluate(() =>
    window.__voiceTestSockets[0].receive({
      serverContent: {
        inputTranscription: { text: "Continue the email draft." },
        turnComplete: true,
      },
    }),
  );
  await page.waitForFunction(() =>
    document.querySelector('[role="log"]').textContent.includes("Continue the email draft."),
  );
  assert(
    transcripts.some(
      (turn) => turn.content === "Continue the email draft." && turn.callId.startsWith("voice_"),
    ),
    "Final transcript was not sent to the server",
  );
  await page.waitForFunction(async () => {
    const history = await (
      await fetch("/api/runtime/history?sessionKey=agent%3Amain%3Amain")
    ).json();
    return history.messages.some(
      (message) => message.source === "voice" && message.content === "Continue the email draft.",
    );
  });
  // A new browser context has no chat cache or device identity from the calling tab.
  const freshDevice = await browser.createBrowserContext();
  const recoveryPage = await freshDevice.newPage();
  await recoveryPage.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await recoveryPage.goto(`${origin}/app`, { waitUntil: "domcontentloaded" });
  await prepareFunctionalOffice(recoveryPage);
  await recoveryPage.click(".hud-chat-dock__btn");
  await recoveryPage.click(".chat-mode-switch button:nth-child(2)");
  await recoveryPage.waitForFunction(() =>
    document.querySelector('[role="log"]')?.textContent.includes("Continue the email draft."),
  );
  const isolated = await recoveryPage.evaluate(async () => {
    const state = await (await fetch("/api/runtime/state")).json();
    const contexts = {};
    for (const name of ["Alice", "Bob"]) {
      const seat = state.seats.find((seat) => seat.label === name);
      const response = await fetch("/api/runtime/voice/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seatId: seat.seatId,
          bindingRevision: seat.binding.revision,
          sessionKey: "agent:main:main",
        }),
      });
      if (!response.ok) throw new Error("Context isolation read failed");
      contexts[name] = (await response.json()).agent;
    }
    return contexts;
  });
  assert(JSON.stringify(isolated.Alice.conversation).includes("Continue the email draft."));
  assert(
    !JSON.stringify(isolated.Bob).includes("Continue the email draft."),
    "Another worker received Alice's memory",
  );
  assert.equal(isolated.Alice.retrieval.memory.status, "available");
  assert.equal(isolated.Bob.retrieval.memory.status, "available");
  await freshDevice.close();

  await page.evaluate(() => {
    const socket = window.__voiceTestSockets[0];
    socket.receive({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: {
        inputTranscription: { text: "browser voice duplicate request", finished: true },
      },
    });
    socket.receive({
      toolCall: {
        functionCalls: [
          {
            id: "create-one",
            name: "assign_task",
            args: { message: "browser voice duplicate request" },
          },
          {
            id: "create-repeat",
            name: "assign_task",
            args: { message: "browser voice duplicate request" },
          },
        ],
      },
    });
  });
  await page.waitForFunction(
    () =>
      window.__voiceTestSockets[0].sent
        .flatMap((frame) => frame.toolResponse?.functionResponses ?? [])
        .filter((response) => response.name === "assign_task").length === 2,
  );
  const accepted = await page.evaluate(() =>
    window.__voiceTestSockets[0].sent
      .flatMap((frame) => frame.toolResponse?.functionResponses ?? [])
      .filter((response) => response.name === "assign_task")
      .map((response) => response.response),
  );
  assert(
    accepted.every((response) => response.accepted === true),
    JSON.stringify(accepted),
  );
  assert.equal(
    new Set(accepted.map((response) => response.taskId)).size,
    1,
    "Repeated tool calls created duplicate work",
  );
  await page.evaluate(
    (taskId) =>
      window.__voiceTestSockets[0].receive({
        toolCall: { functionCalls: [{ id: "cancel-one", name: "cancel_task", args: { taskId } }] },
      }),
    accepted[0].taskId,
  );
  await page.waitForFunction(
    (taskId) =>
      window.__voiceTestSockets[0].sent
        .flatMap((frame) => frame.toolResponse?.functionResponses ?? [])
        .some(
          (response) =>
            response.name === "cancel_task" &&
            response.response.task?.taskId === taskId &&
            response.response.task.status === "cancel_requested",
        ),
    {},
    accepted[0].taskId,
  );
  await page.waitForFunction(
    async (taskId) =>
      (await (await fetch(`/api/runtime/tasks/${taskId}`)).json()).task.status === "stopped",
    {},
    accepted[0].taskId,
  );

  await page.evaluate(() => {
    const socket = window.__voiceTestSockets[0];
    socket.receive({
      serverContent: { outputTranscription: { text: "An unfinished assistant fragment" } },
    });
    socket.receive({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: { inputTranscription: { text: "Actually " } },
    });
    socket.receive({
      serverContent: {
        interrupted: true,
        outputTranscription: { text: "stale answer must be ignored" },
      },
    });
    socket.receive({ serverContent: { turnComplete: true } });
    socket.receive({
      serverContent: { inputTranscription: { text: "make it shorter", finished: true } },
    });
  });
  await page.waitForFunction(async () => {
    const history = await (
      await fetch("/api/runtime/history?sessionKey=agent%3Amain%3Amain")
    ).json();
    return (
      history.messages.some(
        (message) =>
          message.content === "An unfinished assistant fragment" && message.interrupted === true,
      ) &&
      history.messages.some((message) => message.content === "Actually make it shorter") &&
      !history.messages.some((message) => message.content.includes("stale answer must be ignored"))
    );
  });
  const geometry = await page.$eval(".hud-chat-dock__panel .hud-flyout", (element) => ({
    width: element.getBoundingClientRect().width,
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    viewport: innerWidth,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  assert(
    geometry.width >= 300 && geometry.width <= 540,
    "Conversation rail width is outside its responsive bounds",
  );
  assert(
    geometry.left >= 0 && geometry.right <= geometry.viewport,
    "Conversation rail leaves the viewport",
  );
  assert(geometry.scrollWidth <= geometry.clientWidth + 1, "Panel overflows horizontally");
  await mkdir("../artifacts", { recursive: true });
  await page.screenshot({ path: "../artifacts/chat-voice-responsive.png" });
  await page.click('[data-dock-id="voice"]');
  assert.equal(provisions, 1, "Toolbar created a second call");
  await page.click(".chat-voice-buttons button:first-child");
  assert(
    await page.evaluate(() => window.__voiceTestTracks.every((track) => !track.enabled)),
    "Mute did not disable microphone tracks",
  );
  await page.click(".chat-voice-buttons button:first-child");
  assert(
    await page.evaluate(() => window.__voiceTestTracks.every((track) => track.enabled)),
    "Unmute did not restore microphone tracks",
  );
  await page.click(".chat-mode-switch button:first-child");
  assert(
    await page.evaluate(() =>
      window.__voiceTestTracks.every((track) => track.readyState === "ended"),
    ),
    "Microphone not released",
  );
  await page.setViewport({ width: 390, height: 844 });
  const mobile = await page.$eval(".hud-chat-dock__panel .hud-flyout", (element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
  }));
  assert(mobile.left >= 0 && mobile.right <= 390, "Mobile panel extends beyond viewport");
  await page.screenshot({ path: "../artifacts/chat-text-mobile.png" });
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem("agent-town:chat") ?? "[]").some(
      (message) =>
        message.source === "voice" &&
        message.content === "Continue the email draft." &&
        !message.streaming,
    ),
  );
  await page.click(".chat-mode-switch button:nth-child(2)");
  await page.click(".chat-voice-buttons button");
  await page.waitForFunction(() =>
    document.querySelector(".chat-voice-state").textContent.includes("Listening"),
  );
  assert.equal(provisions, 2, "Could not reconnect");
  const bobId = await page.$eval(
    "#chat-agent",
    (select) => [...select.options].find((option) => option.textContent === "Bob").value,
  );
  await page.click(".chat-end-call");
  await page.waitForFunction(() =>
    window.__voiceTestTracks.every((track) => track.readyState === "ended"),
  );
  await page.select("#chat-agent", bobId);
  await page.click(".chat-voice-buttons button");
  await page.waitForFunction(() =>
    document.querySelector(".chat-voice-state").textContent.includes("Listening"),
  );
  assert.equal(provisions, 3);
  await page.click('[title="New session"]');
  await page.waitForFunction(() =>
    window.__voiceTestTracks.every((track) => track.readyState === "ended"),
  );
  await page.evaluate(() =>
    window.__voiceTestSockets[0].receive({
      serverContent: { outputTranscription: { text: "Stale session reply" }, turnComplete: true },
    }),
  );
  assert(
    !(await page.$eval('[role="log"]', (element) => element.textContent)).includes(
      "Stale session reply",
    ),
  );
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(
    "PASS: 350px/mobile layout, SQLite transcript recovery on a fresh device, worker memory isolation, duplicate prevention, confirmed voice cancellation, interruptions, reconnection, session isolation, and microphone cleanup.",
  );
} finally {
  await browser.close();
}
