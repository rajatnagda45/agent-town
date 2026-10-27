import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer";
import { CONTRACTS } from "../lib/server/contracts.mjs";
import { browserCheckOptions } from "./browser-check-options.mjs";
import { prepareFunctionalOffice } from "./browser-functional-office.mjs";

// Packaged startup and real browser UI, with an isolated SQLite database and a
// schema-validated mock gateway. The voice check stubs all Gemini transports.
const fixture = JSON.parse(
  await readFile(new URL("../lib/__fixtures__/openclaw-2026.10.7.json", import.meta.url), "utf8"),
);
await mkdir("../artifacts", { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "agent-town-phase2-"));
await writeFile(
  join(temporary, "package.json"),
  JSON.stringify({ name: "openclaw", version: fixture.version, type: "module" }),
);
await writeFile(
  join(temporary, "protocol.mjs"),
  `const schemas=${JSON.stringify(fixture.schemas)};\nexport const PROTOCOL_VERSION=${fixture.protocol};\n${Object.keys(
    fixture.schemas,
  )
    .map((name) => `export const ${name}=schemas[${JSON.stringify(name)}];`)
    .join("\n")}\n`,
);
const { ContractAudit } = await import("../lib/server/contracts.mjs");
const audit = new ContractAudit(fixture);
const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => wss.once("listening", resolve));
const gatewayPort = wss.address().port;
const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
const appPort = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${appPort}`;
const agents = [
  { id: "main", name: "Shared fixture", model: { primary: "fixture/one" } },
  { id: "carol", name: "Carol", workspace: "/fixture/carol", model: { primary: "fixture/one" } },
];
const sessions = [
  {
    key: "agent:main:main",
    sessionId: "main-session",
    lifecycleRevision: "main-life",
    model: "one",
    modelProvider: "fixture",
  },
];
const pendingApproval = {
  id: "browser-approval",
  urlPath: "/approval/browser-approval",
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 600000,
  sourceSessionKey: "agent:main:main",
  presentation: {
    kind: "exec",
    agentId: "main",
    commandText: "echo browser review fixture",
    allowedDecisions: ["allow-once", "deny"],
  },
  status: "pending",
};
const pendingQuestion = {
  id: "browser-question",
  agentId: "main",
  sessionKey: "agent:main:main",
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 600000,
  status: "pending",
  questions: [
    {
      questionId: "environment",
      header: "Environment",
      question: "Choose the fixture environment",
      options: [
        { label: "Staging", value: "staging" },
        { label: "Production", value: "production" },
      ],
    },
  ],
};
const calls = [];
const runs = new Map();
const broadcast = (event, payload) => {
  for (const socket of wss.clients)
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "event", event, payload }));
};
wss.on("connection", (socket) => {
  socket.send(
    JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }),
  );
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    const { method, params } = frame;
    let payload;
    let error;
    if (method !== "connect" && !audit.validate(method, params))
      error = { code: "INVALID_REQUEST", message: `Invalid mock parameters for ${method}` };
    else {
      calls.push({ method, params });
      switch (method) {
        case "connect":
          payload = {
            type: "hello-ok",
            protocol: fixture.protocol,
            server: { version: fixture.version, connId: "fixture-connection" },
            features: {
              methods: Object.keys(CONTRACTS),
              events: [
                "agent",
                "chat",
                "question.requested",
                "question.resolved",
                "session.approval",
              ],
            },
            auth: {
              scopes: [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.questions",
                "operator.approvals",
              ],
            },
          };
          break;
        case "agents.list":
          payload = { defaultId: "main", mainKey: "main", scope: "per-sender", agents };
          break;
        case "sessions.list":
          payload = { sessions };
          break;
        case "models.list":
          payload = {
            models: [
              { id: "one", provider: "fixture", name: "Fixture one" },
              { id: "two", provider: "fixture", name: "Fixture two" },
            ],
          };
          break;
        case "question.list":
          payload = { questions: [pendingQuestion] };
          break;
        case "question.get":
          payload = { question: pendingQuestion };
          break;
        case "approval.get":
          payload = { approval: pendingApproval };
          break;
        case "sessions.messages.subscribe":
          payload = {
            subscribed: true,
            key: params.key,
            approvalReplay: {
              sessionKey: params.key,
              updatedAtMs: Date.now(),
              approvals:
                params.key === "agent:main:main" && pendingApproval.status === "pending"
                  ? [pendingApproval]
                  : [],
              truncated: false,
            },
          };
          break;
        case "question.resolve":
          pendingQuestion.status = params.cancel ? "cancelled" : "answered";
          payload = params.cancel
            ? { status: "cancelled" }
            : { status: "answered", answers: params.answers };
          broadcast("question.resolved", { id: params.id, ...payload });
          break;
        case "approval.resolve":
          delete pendingApproval.sourceSessionKey;
          Object.assign(pendingApproval, {
            status: params.decision === "deny" ? "denied" : "allowed",
            decision: params.decision,
            reason: "user",
            resolvedAtMs: Date.now(),
          });
          payload = { applied: true, approval: pendingApproval };
          broadcast("session.approval", {
            sessionKey: "agent:main:main",
            updatedAtMs: Date.now(),
            phase: "terminal",
            approval: pendingApproval,
          });
          break;
        case "chat.history":
          payload = {
            messages: [],
            sessionInfo: {
              activeRunIds: [...runs.values()]
                .filter((run) => run.sessionKey === params.sessionKey && !run.terminal)
                .map((run) => run.runId),
            },
          };
          break;
        case "chat.send": {
          const run = {
            runId: `run-${params.idempotencyKey}`,
            sessionKey: params.sessionKey,
            terminal: false,
          };
          runs.set(params.idempotencyKey, run);
          payload = { runId: run.runId };
          break;
        }
        case "chat.abort":
          payload = { ok: true };
          if (params.runId.includes("voice_task_"))
            setTimeout(() => {
              const run = [...runs.values()].find((run) => run.runId === params.runId);
              run.terminal = true;
              broadcast("chat", {
                runId: run.runId,
                sessionKey: run.sessionKey,
                state: "aborted",
                seq: 1,
              });
            }, 800);
          break;
        case "agent.wait":
          payload = { runId: params.runId, status: "timeout" };
          break;
        case "agents.create":
          agents.push({
            id: "created-fixture",
            name: params.name,
            workspace: params.workspace ?? "/fixture/new",
          });
          payload = {
            ok: true,
            agentId: "created-fixture",
            name: params.name,
            workspace: params.workspace ?? "/fixture/new",
          };
          break;
        case "agents.update": {
          const agent = agents.find((agent) => agent.id === params.agentId);
          if (params.name) agent.name = params.name;
          if ("model" in params) agent.model = params.model ? { primary: params.model } : undefined;
          if (params.model)
            for (const session of sessions.filter(
              (session) =>
                session.key.startsWith(`agent:${params.agentId}:`) && !session.modelOverride,
            )) {
              const [provider, ...model] = params.model.split("/");
              session.modelProvider = provider;
              session.model = model.join("/");
            }
          payload = { ok: true, agentId: params.agentId };
          break;
        }
        case "sessions.patch": {
          const session = sessions.find((session) => session.key === params.key);
          const parts = params.model?.split("/");
          session.modelOverride = parts?.slice(1).join("/");
          session.providerOverride = parts?.[0];
          session.model = session.modelOverride ?? "one";
          session.modelProvider = session.providerOverride ?? "fixture";
          payload = { ok: true, key: session.key, entry: session };
          break;
        }
        default:
          payload = { ok: true };
      }
    }
    socket.send(
      JSON.stringify({
        type: "res",
        id: frame.id,
        ok: !error,
        ...(error ? { error } : { payload }),
      }),
    );
  });
});
let serverOutput = "";
const mockNonce = randomUUID();
const child = spawn(
  process.execPath,
  [
    "--import",
    pathToFileURL(resolve("scripts/mock-voice-provider.mjs")).href,
    process.env.AGENT_TOWN_PACKAGED_SERVER ?? resolve(".next/standalone/server.prod.mjs"),
  ],
  {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(appPort),
      HOST: "127.0.0.1",
      AGENT_PROVIDER: "openclaw",
      GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/`,
      GATEWAY_TOKEN: "fixture-only-token",
      GEMINI_API_KEY: "fixture-never-used",
      AGENT_TOWN_MOCK_VOICE: "1",
      AGENT_TOWN_MOCK_VOICE_NONCE: mockNonce,
      AGENT_TOWN_ALLOW_PAID_VOICE_TESTS: "0",
      OPENCLAW_PROTOCOL_MODULE: join(temporary, "protocol.mjs"),
      AGENT_TOWN_DB_PATH: join(temporary, "tasks.sqlite"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (data) => {
  serverOutput += data;
});
child.stderr.on("data", (data) => {
  serverOutput += data;
});
let browser;
let stage = "packaged startup";
try {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited: ${serverOutput}`);
    try {
      const response = await fetch(`${origin}/api/runtime/state`);
      if (response.ok && (await response.json()).connection === "connected") break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const state = await (await fetch(`${origin}/api/runtime/state`)).json();
  assert.equal(state.connection, "connected", serverOutput);
  console.log("PASS: packaged server connected to isolated mock gateway.");
  // Exercise the bundled Next route's access to the custom server runtime.
  // Invalid selection must fail locally before any provider request.
  const voiceSelection = await fetch(`${origin}/api/voice/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ seatId: "missing-fixture-seat", bindingRevision: 1 }),
  });
  assert.equal(
    voiceSelection.status,
    409,
    "Bundled voice route could not resolve the server runtime",
  );
  assert.equal(
    calls.filter((call) => call.method === "agents.create").length,
    0,
    "Startup created an agent",
  );
  browser = await puppeteer.launch(browserCheckOptions());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  // Block accidental paid provisioning in this browser as well as the voice test.
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (
      request.url().includes("generativelanguage.googleapis.com") ||
      request.url().endsWith("/api/voice/session")
    )
      void request.respond({
        status: 503,
        contentType: "application/json",
        body: '{"configured":false}',
      });
    else void request.continue();
  });
  stage = "loading office and pending indicator";
  await page.goto(`${origin}/app`, { waitUntil: "domcontentloaded" });
  await prepareFunctionalOffice(page);
  console.log("Office loaded; checking pending reviews.");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".topbar-agent-pill")].some((element) =>
      element.title.startsWith("Alice"),
    ),
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".review-indicator")?.getAttribute("aria-label") ===
      "Review requests: 2 pending",
  );
  stage = "office operations browser view";
  // A local proposal exercises the export without invoking a model or changing stock.
  const proposalResponse = await fetch(`${origin}/api/runtime/composer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ goal: "Change inventory by three units", submissionId: randomUUID() }),
  });
  assert(proposalResponse.ok, "Could not create isolated export proposal");
  const { task: exportTask } = await proposalResponse.json();
  assert.equal(exportTask.status, "approval_required");
  await page.click('[data-dock-id="operations"]');
  await page.waitForSelector(".office-ledger");
  await page.waitForFunction(() =>
    document.querySelector(".office-ledger")?.textContent.includes("Activity"),
  );
  await page.waitForSelector('select[aria-label="Saved tasks"]');
  await page.select('select[aria-label="Saved tasks"]', exportTask.id);
  await page.waitForSelector("a[download]");
  const recordHref = await page.$eval("a[download]", (element) => element.getAttribute("href"));
  const record = JSON.parse(decodeURIComponent(recordHref.split(",")[1]));
  assert.equal(record.taskId, exportTask.id);
  assert.equal(record.status, "approval_required");
  assert.equal(record.report, null);
  assert(record.actions.every((action) => !action.executed));
  console.log(
    "PASS: local investigation export retains pending approval without executing actions.",
  );
  await page.$eval("a[download]", (element) => element.scrollIntoView({ block: "center" }));
  await page.screenshot({ path: "../artifacts/phase3-investigation-export.png" });
  const officeOverview = await (await fetch(`${origin}/api/runtime/office-overview`)).json();
  assert(officeOverview.events.length <= 80, "Office overview exceeded its event display limit");
  const priorViewport = page.viewport();
  await page.setViewport({ width: 300, height: 844 });
  const officeGeometry = await page.$eval(".hud-flyout", (element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  assert(
    officeGeometry.left >= 0 &&
      officeGeometry.right <= 300 &&
      officeGeometry.scrollWidth <= officeGeometry.clientWidth + 1,
    "Office operations panel overflows the 300px viewport",
  );
  await page.setViewport(priorViewport);
  await page.click('[data-dock-id="operations"]');
  console.log("PASS: office overview and 300px operations panel.");
  const clickText = async (selector, text) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const target = await page.evaluateHandle(
        (selector, text) =>
          [...document.querySelectorAll(selector)].find(
            (element) => element.textContent.trim() === text,
          ),
        selector,
        text,
      );
      assert(target.asElement(), `Missing ${text}`);
      try {
        await target.asElement().click();
        return;
      } catch (error) {
        if (attempt === 3 || !error.message.includes("detached")) throw error;
      } finally {
        await target.dispose();
      }
    }
  };
  await page.click(".review-indicator");
  stage = "answering question";
  await clickText(
    ".review-row",
    "main · questionChoose the fixture environmentpending · agent:main:main",
  );
  await page.waitForSelector('input[value="staging"]');
  console.log("Question dialog opened.");
  assert.equal(calls.filter((call) => call.method === "question.resolve").length, 0);
  await page.click('input[value="staging"]');
  await clickText(".review-dialog button", "Submit answers");
  await page.waitForFunction(() =>
    document.querySelector(".review-dialog")?.textContent.includes("Backend: answered"),
  );
  await clickText(".review-dialog button", "Close");
  stage = "approval decision";
  await page.click(".review-indicator");
  const approvalRow = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".review-row")].find((element) =>
      element.textContent.includes("browser review fixture"),
    ),
  );
  await approvalRow.asElement().click();
  assert.equal(calls.filter((call) => call.method === "approval.resolve").length, 0);
  await clickText(".review-dialog button", "Deny");
  await page.waitForFunction(() =>
    document.querySelector(".review-dialog")?.textContent.includes("Backend: denied"),
  );
  console.log("PASS: explicit question and approval decisions.");
  await mkdir("../artifacts", { recursive: true });
  await page.screenshot({ path: "../artifacts/phase2-review.png" });
  await clickText(".review-dialog button", "Close");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".topbar-agent-pill")].some((element) =>
      element.title.startsWith("Alice"),
    ),
  );
  const seat = await page.evaluate(async () => {
    const state = await (await fetch("/api/runtime/state")).json();
    return state.seats.find((seat) => seat.label === "Alice");
  });
  stage = "cancellation and queue";
  assert(seat?.binding?.available);
  for (const id of ["browser-one", "browser-two"])
    await page.evaluate(
      async ({ id, seat }) => {
        const response = await fetch("/api/runtime/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId: id,
            seatId: seat.seatId,
            bindingRevision: seat.binding.revision,
            message: id,
            sessionKey: "agent:main:main",
          }),
        });
        if (!response.ok) throw new Error(await response.text());
      },
      { id, seat },
    );
  await page.click('[data-dock-id="tasks"]');
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".hud-list__item")].some((element) =>
      element.textContent.includes("browser-one"),
    ),
  );
  const stop = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".hud-list__item")]
      .find((element) => element.textContent.includes("browser-one"))
      ?.querySelector("button"),
  );
  await stop.asElement().click();
  await page.waitForFunction(() =>
    document.querySelector(".hud-list")?.textContent.includes("Cancellation requested"),
  );
  let execution = await (await fetch(`${origin}/api/runtime/state`)).json();
  assert.equal(execution.tasks.find((task) => task.taskId === "browser-two").status, "queued");
  const first = runs.get("browser-one");
  first.terminal = true;
  broadcast("chat", { runId: first.runId, sessionKey: first.sessionKey, state: "aborted", seq: 1 });
  for (let i = 0; i < 50 && !runs.has("browser-two"); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert(runs.has("browser-two"));
  const second = runs.get("browser-two");
  second.terminal = true;
  broadcast("chat", { runId: second.runId, sessionKey: second.sessionKey, state: "final", seq: 1 });
  await page.click('[data-dock-id="workers"]');
  console.log("PASS: cancellation acknowledgement held the lane until terminal evidence.");
  stage = "team management";
  const secondDevice = await browser.createBrowserContext();
  const devicePage = await secondDevice.newPage();
  await devicePage.evaluateOnNewDocument(() =>
    localStorage.setItem("agent-town:onboarding-done", "true"),
  );
  await devicePage.goto(`${origin}/app`, { waitUntil: "domcontentloaded" });
  await prepareFunctionalOffice(devicePage);
  const staleConfiguration = await devicePage.evaluate(async () => {
    window.__releaseConfigurationEvents = [];
    window.__releaseEventTrace = [];
    window.__releaseEvents = new EventSource("/api/runtime/events");
    window.__releaseEvents.onmessage = (message) => {
      const event = JSON.parse(message.data);
      window.__releaseEventTrace.push({
        kind: event.kind,
        id: message.lastEventId,
        mainModel: event.data?.agents?.find((agent) => agent.agentId === "main")?.model,
      });
      if (event.kind === "management") window.__releaseConfigurationEvents.push(event.data);
      if (event.kind === "snapshot" && event.data?.management?.agents)
        window.__releaseConfigurationEvents.push(event.data.management);
    };
    window.__releaseEvents.onerror = () => window.__releaseEventTrace.push({ kind: "error" });
    const state = await (await fetch("/api/runtime/state")).json();
    return state.management.agents.find((agent) => agent.agentId === "main").configRevision;
  });
  await devicePage.waitForFunction(() => window.__releaseEvents?.readyState === EventSource.OPEN);
  await page.bringToFront();
  await clickText("button", "Manage Seats");
  await page.waitForSelector(".backend-management");
  await clickText(".backend-management button", "Load gateway models");
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Agent default model"]')?.options.length >= 3,
  );
  assert(
    (await page.$eval(".backend-management", (element) => element.textContent)).includes(
      "unverified",
    ),
  );
  await page.select('[aria-label="Agent default model"]', "fixture/two");
  await clickText(".backend-management button", "Save backend agent");
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Agent default model"]')?.value === "fixture/two" &&
      document
        .querySelector(".backend-management")
        ?.textContent.includes("agents.update · main · confirmed"),
  );
  try {
    // SSE can arrive while this device's tab has no animation frames.
    await devicePage.waitForFunction(
      () =>
        window.__releaseEventTrace.some(
          (event) => event.kind === "management" && event.mainModel === "fixture/two",
        ),
      { polling: 100 },
    );
  } catch (error) {
    const browserDiagnostic = await devicePage.evaluate(() => ({
      readyState: window.__releaseEvents?.readyState,
      eventTrace: window.__releaseEventTrace,
    }));
    const stateResponse = await fetch(`${origin}/api/runtime/state`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    const state = stateResponse?.ok ? await stateResponse.json() : null;
    console.error(
      "Second-device management diagnostic:",
      JSON.stringify({
        ...browserDiagnostic,
        currentModel: state?.management.agents.find((agent) => agent.agentId === "main")?.model,
        operations: (state?.management.operations ?? []).map((operation) => ({
          method: operation.method,
          status: operation.status,
        })),
      }),
    );
    throw error;
  }
  const staleEdit = await devicePage.evaluate(async (configRevision) => {
    const response = await fetch("/api/runtime/management", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "stale-second-device",
        method: "agents.update",
        configRevision,
        params: { agentId: "main", model: "fixture/one" },
      }),
    });
    return response.status;
  }, staleConfiguration);
  assert.equal(staleEdit, 409, "A stale second-device edit overwrote confirmed configuration");
  await secondDevice.close();
  console.log(
    "PASS: a second device received confirmed configuration through SSE; stale edits were rejected.",
  );
  await clickText(".backend-management summary", "Session model override");
  await clickText(".backend-management button", "Load session configuration");
  await page.waitForSelector('[aria-label="Session model override"]');
  // The editor remounts after a confirmed change, so load this agent's catalog again.
  await clickText(".backend-management button", "Load gateway models");
  await page.waitForFunction(() =>
    [...(document.querySelector('[aria-label="Session model override"]')?.options ?? [])].some(
      (option) => option.value === "fixture/one",
    ),
  );
  await page.select('[aria-label="Session model override"]', "fixture/one");
  await clickText(".backend-management button", "Save session override");
  await page.waitForFunction(() =>
    document.querySelector(".backend-management")?.textContent.includes("sessions.patch"),
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".backend-management")
      ?.textContent.includes("Effective model: fixture/one"),
  );
  await clickText(".backend-management summary", "Create a backend agent");
  await page.type('[aria-label="New backend agent name"]', "Created by explicit browser action");
  await clickText(".backend-management button", "Create backend agent");
  await page.waitForFunction(() =>
    document.querySelector(".backend-management")?.textContent.includes("created-fixture"),
  );
  assert.equal(calls.filter((call) => call.method === "agents.create").length, 1);
  await page.screenshot({ path: "../artifacts/phase2-management.png" });
  await page.setViewport({ width: 390, height: 844 });
  const geometry = await page.$eval(".seat-manager", (element) => ({
    left: element.getBoundingClientRect().left,
    right: element.getBoundingClientRect().right,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  assert(
    geometry.left >= 0 && geometry.right <= 390 && geometry.scrollWidth <= geometry.clientWidth + 1,
    "Management dialog overflows mobile viewport",
  );
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  // Existing synthetic-microphone regression uses a fresh browser and the same isolated app.
  await new Promise((resolve, reject) => {
    const voice = spawn(process.execPath, ["scripts/check-chat-voice.mjs"], {
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_TOWN_TEST_ORIGIN: origin,
        AGENT_TOWN_MOCK_VOICE: "1",
        AGENT_TOWN_MOCK_VOICE_NONCE: mockNonce,
      },
      stdio: "inherit",
    });
    voice.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Voice browser regression exited ${code}`)),
    );
    voice.on("error", reject);
  });
  assert.equal(
    calls.filter(
      (call) =>
        call.method === "chat.send" &&
        call.params.message.includes("browser voice duplicate request"),
    ).length,
    1,
  );
  assert.equal(
    calls.filter(
      (call) => call.method === "chat.abort" && call.params.runId.includes("voice_task_"),
    ).length,
    1,
  );
  // Dedicated communication workspace, against this isolated runtime and mock gateway.
  browser = await puppeteer.launch(browserCheckOptions());
  const center = await browser.newPage();
  const team = (await (await fetch(`${origin}/api/runtime/state`)).json()).seats.filter(
    (s) => s.assigned && s.binding?.available,
  );
  const owner = team[0];
  const other = team.find((s) => s.seatId !== owner.seatId);
  await center.setViewport({ width: 1440, height: 1000 });
  await center.goto(`${origin}/app/chat?seat=${encodeURIComponent(owner.seatId)}`);
  await center.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.includes("New conversation") && !b.disabled,
    ),
  );
  await center.evaluate(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("New conversation"))
      .click(),
  );
  await center.waitForSelector(".center-history-item.is-active");
  await center.type("#center-draft", "Dedicated conversation isolation check");
  await center.click(".center-composer .pixel-button--primary");
  await center.waitForFunction(() =>
    document
      .querySelector(".center-messages")
      ?.textContent.includes("Dedicated conversation isolation check"),
  );
  let centerTask;
  for (let i = 0; i < 60; i++) {
    centerTask = (await (await fetch(`${origin}/api/runtime/state`)).json()).tasks.find(
      (t) => t.message === "Dedicated conversation isolation check",
    );
    if (centerTask?.runId) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(centerTask?.runId);
  broadcast("chat", {
    runId: centerTask.runId,
    sessionKey: centerTask.sessionKey,
    state: "final",
    seq: 1,
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            "Verified isolated result.\n\n" +
            "Detailed reported output for scrolling.\n".repeat(100),
        },
      ],
    },
  });
  await center.waitForFunction(() =>
    document.querySelector(".center-messages")?.textContent.includes("Verified isolated result."),
  );
  assert(await center.$eval(".center-messages", (e) => e.scrollHeight > e.clientHeight));
  assert(
    await center.$eval(".center-composer", (e) => e.getBoundingClientRect().bottom <= innerHeight),
  );
  // Selecting this execution must preserve the reader's independent scroll position.
  await center.$eval(".center-messages", (e) => {
    e.scrollTop = 100;
    e.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await center.$eval(".center-directory", (e) => {
    e.scrollTop = 60;
  });
  const beforeScroll = await center.$eval(".center-messages", (e) => e.scrollTop);
  await center.$eval(".center-task-link", (e) => e.click());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await center.$eval(".center-messages", (e) => e.scrollTop), beforeScroll);
  await center
    .browserContext()
    .overridePermissions(origin, [
      "clipboard-read",
      "clipboard-write",
      "clipboard-sanitized-write",
    ]);
  await center.bringToFront();
  await center.$eval('.center-task-detail [aria-label="Copy message"]', (e) => e.click());
  await center.waitForFunction(() =>
    document
      .querySelector('.center-task-detail [aria-label="Copy message"]')
      ?.textContent.includes("Copied"),
  );
  const copiedResult = await center.evaluate(() => navigator.clipboard.readText());
  assert.equal(
    copiedResult,
    "Verified isolated result.\n\n" + "Detailed reported output for scrolling.\n".repeat(100),
  );
  await center.reload();
  await center.waitForFunction(() =>
    document.querySelector(".center-messages")?.textContent.includes("Verified isolated result."),
  );
  await center.goto(`${origin}/app/chat?seat=${encodeURIComponent(other.seatId)}`);
  await center.waitForSelector("#center-draft");
  assert(
    !(await center.$eval(".center-messages", (e) => e.textContent)).includes(
      "Verified isolated result.",
    ),
  );
  const wrongTarget = await fetch(`${origin}/api/runtime/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      taskId: "wrong_center_target",
      message: "Must reject",
      seatId: other.seatId,
      bindingRevision: other.binding.revision,
      sessionKey: centerTask.sessionKey,
    }),
  });
  assert.equal(wrongTarget.status, 409);
  await center.goto(`${origin}/app/chat`);
  await center.waitForFunction(
    () =>
      !document.querySelector(".center-composer textarea")?.disabled &&
      [...document.querySelectorAll(".center-directory .center-conversation")].length > 1,
  );
  await center.type("#center-draft", "Synthetic office group request from the task center");
  await center.click(".center-composer .pixel-button--primary");
  await center.waitForFunction(() =>
    document
      .querySelector(".center-messages")
      ?.textContent.includes("Synthetic office group request from the task center"),
  );
  for (const width of [1440, 1024, 768, 390]) {
    await center.setViewport({ width, height: 1000 });
    assert(await center.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(
      await center.$eval(
        ".center-composer",
        (e) => e.getBoundingClientRect().bottom <= innerHeight,
      ),
    );
  }
  await center.close();
  console.log(
    "PASS: dedicated conversations, server-side target isolation, streamed result, long-history scrolling, reload persistence, group dispatch and responsive composer. All execution mocked.",
  );
  await writeFile(
    resolve("../artifacts/phase3-validation.json"),
    JSON.stringify(
      {
        node: process.version,
        buildId: (await readFile(".next/BUILD_ID", "utf8")).trim(),
        completedAt: new Date().toISOString(),
        mocked: true,
        checks: [
          "packaged startup",
          "transcript recovery on fresh device",
          "memory isolation",
          "duplicate prevention",
          "confirmed cancellation",
          "interruptions",
          "cross-device configuration",
          "350px and mobile layout",
          "explicit review decisions",
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: packaged startup, durable runtime, explicit review decisions, confirmed cancellation, held lanes, gateway-backed agent creation/editing, separate model defaults/overrides, and mobile management layout. All gateway mutations were mocked.",
  );
} catch (error) {
  console.error(`Browser check stage: ${stage}`);
  if (browser) {
    const pages = await browser.pages();
    const current = pages.at(-1);
    if (current) {
      await current.screenshot({ path: "../artifacts/phase2-failure.png" });
      console.error((await current.evaluate(() => document.body.innerText)).slice(-5000));
    }
  }
  console.error(serverOutput.slice(-4000));
  throw error;
} finally {
  if (browser) await browser.close();
  child.kill();
  for (const socket of wss.clients) socket.terminate();
  await new Promise((resolve) => wss.close(resolve));
}
