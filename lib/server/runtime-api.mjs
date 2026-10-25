import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "./task-db.mjs";
import { ServerGateway } from "./gateway-connection.mjs";
import { NightshiftGateway, nightshiftBaseUrl } from "./nightshift-gateway.mjs";
import { TaskRuntime } from "./task-runtime.mjs";
import { OfficeOperations } from "./office-operations.mjs";
import { loadSpecialistConfig } from "./specialist-config.mjs";
import { createNightshiftEnforcement } from "./nightshift-enforcement.mjs";
import {
  createExecutionOptions,
  loadExecutionConfig,
  secondaryGatewayId,
} from "./execution-options.mjs";
import { runtimeStorage } from "./runtime-storage.mjs";
import { loadEmbedder } from "./embeddings.mjs";
import { EmergencyStop } from "./estop.mjs";
import { TaskSearch } from "./task-search.mjs";
import { TeamLead } from "./team-lead.mjs";
import { dirname } from "node:path";
import { loadInstalledContracts } from "./contracts.mjs";
import { TaskComposer } from "./task-composer.mjs";
import { discoverApprovedData } from "./approved-data.mjs";
import { isAllowedAppOrigin } from "../server-security.mjs";
import { localBridgeContracts, SERVER_BRIDGE_TOKEN } from "./auggie-contracts.mjs";
import { officeOverview } from "./office-observability.mjs";
import { OfficeGroupChat } from "./office-group-chat.mjs";
import { ServiceRegistry } from "./service-registry.mjs";
import { agentDirectory, DEFAULT_OFFICE_LEAD_SEAT, officeLead } from "./office-lead.mjs";
import { dataIntent } from "./task-intent.mjs";
import { deriveLifecycle } from "./task-lifecycle.mjs";
import {
  actOnInvestigation,
  evidenceDetail,
  inventoryEligibility,
  investigationList,
  investigationView,
  startInvestigation,
} from "./inventory-office-api.mjs";

const GRANT_SEAT_NAMES = {
  "data-steward-researcher": ["Orion", "Researcher"],
  planner: ["Piper", "Planner"],
  critic: ["Cora", "Critic"],
  executor: ["Ezra", "Executor"],
  "maintenance-specialist": ["Milo", "Maintenance Specialist"],
};

/** Bind each reviewed grant's seat to the discovered agent named by its session key.
 * Only unassigned seats are bound; an existing binding is never replaced. Bound seats are
 * announced on the shared event stream so the office shows them without a reload. */
export function bindGrantSeats(runtime, grants, primary = null) {
  for (const grant of grants) {
    const agentId = /^agent:([^:]+):/.exec(grant.sessionKey ?? "")?.[1];
    if (!agentId || !runtime.agents.some((agent) => agent.agentId === agentId)) continue;
    const existing = runtime.db.getSeat(grant.seatId);
    if (existing?.assigned) continue;
    if (primary?.db.getSeat(grant.seatId)?.assigned) continue;
    const [name, role] = GRANT_SEAT_NAMES[grant.manifestId] ?? [grant.seatId, grant.manifestId];
    const provider =
      runtime.gateway.provider === "openclaw" ? "OpenClaw" : runtime.gateway.provider;
    try {
      const seat = runtime.saveSeat({
        seatId: grant.seatId,
        label: name,
        roleTitle: `${provider} ${role}`,
        seatType: "agent",
        assigned: true,
        agentConfig: { agentId },
        revision: existing?.binding.revision,
      });
      const shared = runtime.db.sharedDatabase;
      shared?.publish(shared.emit("seat", { ...seat, runtime: runtime.gateway.provider }));
    } catch {
      /* A busy or conflicting seat stays unbound and the router reports it. */
    }
  }
}

/** @param {{gatewayUrl: string, token?: string, provider?: string, env?: Record<string,string|undefined>, syncSeats?: (seats: Array<any>) => void, nightshiftFetch?: typeof fetch, specialists?: object, dataReader?: object}} options */
export async function createTaskService({
  gatewayUrl,
  token,
  provider = "openclaw",
  env = process.env,
  syncSeats,
  nightshiftFetch,
  specialists,
  dataReader,
}) {
  if (!["openclaw", "auggie", "nightshift"].includes(provider))
    throw new Error("Unknown AGENT_PROVIDER.");
  const audit =
    provider === "auggie"
      ? localBridgeContracts()
      : provider === "openclaw"
        ? await loadInstalledContracts(env)
        : null;
  const nightshiftUrl =
    provider === "nightshift"
      ? nightshiftBaseUrl(env.NIGHTSHIFT_BASE_URL ?? "http://127.0.0.1:8088/v1")
      : null;
  const nightshiftModel = env.NIGHTSHIFT_MODEL ?? "meterless/auto";
  const reviewed = loadSpecialistConfig(env);
  const embedder = loadEmbedder(env);
  const executionConfig = loadExecutionConfig(env);
  // Secondary runtimes share the coordinating database; they never own a second lease.
  const secondaryGateways = [];
  for (const row of executionConfig.options)
    secondaryGateways.push({
      row,
      gateway: new ServerGateway({
        url: row.gatewayUrl,
        token: row.tokenEnv ? env[row.tokenEnv] : undefined,
        audit: await loadInstalledContracts(env),
        provider: "openclaw",
      }),
    });
  const dbPath = env.AGENT_TOWN_DB_PATH ?? join(homedir(), ".agent-town", "tasks.sqlite");
  const db = new TaskDatabase(dbPath);
  try {
    db.acquireOwner();
  } catch (error) {
    db.close();
    throw error;
  }
  const syncRoster = () =>
    syncSeats?.(
      db
        .seats()
        .filter((seat) => seat.assigned)
        .map((seat) => ({ seatId: seat.seatId, label: seat.label, roleTitle: seat.roleTitle })),
    );
  syncRoster();
  const unsubscribeRoster = db.subscribe((event) => {
    if (event.kind === "seat") syncRoster();
  });
  const gatewayId = createHash("sha256")
    .update(
      provider === "nightshift"
        ? `${provider}:${nightshiftUrl}:${nightshiftModel}`
        : `${provider}:${gatewayUrl}`,
    )
    .digest("hex");
  const localOrigin = `http://127.0.0.1:${env.PORT ?? 3000}`;
  const gateway =
    provider === "nightshift"
      ? new NightshiftGateway({
          baseUrl: nightshiftUrl,
          apiKey: env.NIGHTSHIFT_API_KEY,
          model: nightshiftModel,
          agentId: env.AGENT_TOWN_SHARED_AGENT ?? "main",
          ...(nightshiftFetch ? { fetchImpl: nightshiftFetch } : {}),
        })
      : new ServerGateway({
          url:
            provider === "auggie"
              ? `${localOrigin.replace("http:", "ws:")}/api/gateway`
              : gatewayUrl,
          token,
          audit,
          provider,
          origin: provider === "auggie" ? localOrigin : undefined,
          headers: provider === "auggie" ? { "x-agent-town-runtime": SERVER_BRIDGE_TOKEN } : {},
        });
  const runtime = new TaskRuntime({
    db,
    gateway,
    gatewayId,
    sharedAgentId: env.AGENT_TOWN_SHARED_AGENT ?? "main",
  });
  // Recall stays lexical until a probe embedding succeeds.
  runtime.memory.embedder = embedder;
  runtime.search = new TaskSearch(db);
  runtime.estop = new EmergencyStop(
    env.AGENT_TOWN_ESTOP_FILE ??
      (dbPath === ":memory:"
        ? join(homedir(), ".agent-town", "ESTOP")
        : join(dirname(dbPath), "ESTOP")),
  );
  const secondaries = secondaryGateways.map(({ row, gateway: secondaryGateway }) => {
    const secondaryId = secondaryGatewayId(row);
    const secondaryRuntime = new TaskRuntime({
      db: runtimeStorage(db, secondaryId),
      gateway: secondaryGateway,
      gatewayId: secondaryId,
      sharedAgentId: row.sharedAgent ?? "main",
    });
    // A secondary runtime has no seat route; its reviewed grants bind their own seats.
    secondaryRuntime.afterRefresh.add(() =>
      bindGrantSeats(secondaryRuntime, row.grants ?? [], runtime),
    );
    return { row, runtime: secondaryRuntime };
  });
  runtime.peers = secondaries.map((item) => item.runtime);
  const enforcement = provider === "nightshift" ? createNightshiftEnforcement(runtime) : undefined;
  const execution = createExecutionOptions({
    config: executionConfig,
    primaryProvider: provider,
    enforcement,
    secondaries,
  });
  let operations;
  try {
    operations = new OfficeOperations(runtime, {
      specialists: {
        ...reviewed,
        ...(executionConfig.options.length
          ? { executionOptions: execution.factory, executionPreference: execution.preference }
          : {}),
        ...specialists,
        ...(enforcement ? { enforcement } : {}),
      },
      dataReader,
    });
  } catch (error) {
    execution.close();
    for (const secondary of secondaries) secondary.runtime.close();
    unsubscribeRoster();
    runtime.close();
    db.close();
    throw error;
  }
  runtime.operations = operations;
  runtime.services = new ServiceRegistry({
    env,
    runtimes: [runtime, ...secondaries.map((item) => item.runtime)],
  });
  // An empty value turns the office-lead seat off; the Team Lead then posts as "Office lead".
  runtime.officeLeadSeatId = env.AGENT_TOWN_OFFICE_LEAD_SEAT ?? DEFAULT_OFFICE_LEAD_SEAT;
  runtime.composer = new TaskComposer(runtime, { env });
  const groupChat = new OfficeGroupChat(runtime, {
    defaultScenarioId:
      env.AGENT_TOWN_INVENTORY_MODE === "synthetic"
        ? env.AGENT_TOWN_INVENTORY_SYNTHETIC_CASE === "demo-pair"
          ? "incomplete"
          : env.AGENT_TOWN_INVENTORY_SYNTHETIC_CASE
        : "default",
  });
  runtime.groupChat = groupChat;
  runtime.teamLead = new TeamLead(runtime, {
    onEvent: (run, stage, text) => {
      if (run.groupTurnId) groupChat.post({ groupTurnId: run.groupTurnId }, stage, text);
    },
  });
  const recoverOperations = async () => {
    await operations.recover();
    groupChat.schedule();
  };
  runtime.afterRefresh.add(recoverOperations);
  let closed = false;
  return {
    runtime,
    operations,
    groupChat,
    handler: createRuntimeHandler(runtime),
    start: () => {
      for (const secondary of secondaries) void secondary.runtime.gateway.start();
      void embedder?.verify();
      return gateway.start();
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribeRoster();
      runtime.afterRefresh.delete(recoverOperations);
      runtime.composer.close();
      runtime.teamLead.close();
      operations.close();
      execution.close();
      groupChat.close();
      for (const secondary of secondaries) secondary.runtime.close();
      runtime.close();
      db.close();
    },
  };
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

export function createRuntimeHandler(runtime) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/api/runtime/") && path !== "/api/agents/discover") return false;
    try {
      if (req.headers.origin && !isAllowedAppOrigin(req.headers.origin, req.headers.host))
        return json(res, 403, { error: "Forbidden origin" });
      if (req.headers["sec-fetch-site"] === "cross-site")
        return json(res, 403, { error: "Forbidden origin" });
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !isAllowedAppOrigin(req.headers.origin, req.headers.host)
      )
        return json(res, 403, { error: "Same-origin request required" });
      if (req.method === "GET") {
        if (path === "/api/runtime/estop")
          return json(res, 200, runtime.estop?.status() ?? { engaged: false });
        if (path === "/api/runtime/team") return json(res, 200, { runs: runtime.teamLead.all() });
        const teamRun = /^\/api\/runtime\/team\/([^/]+)$/.exec(path);
        if (teamRun)
          return json(res, 200, { run: runtime.teamLead.view(decodeURIComponent(teamRun[1])) });
        if (path === "/api/runtime/search")
          return json(res, 200, {
            results:
              runtime.search?.search({
                query: (url.searchParams.get("q") ?? "").slice(0, 300),
                gatewayId: runtime.gatewayId,
              }) ?? [],
          });
        if (path === "/api/runtime/services") return json(res, 200, runtime.services.snapshot());
        if (path === "/api/runtime/office-lead")
          return json(res, 200, {
            lead: officeLead(runtime),
            directory: agentDirectory(runtime),
            runs: (runtime.teamLead?.all() ?? []).slice(0, 10).map((run) => ({
              id: run.id,
              goal: run.goal,
              status: run.status,
              reason: run.reason ?? null,
              transfers: run.transfers ?? [],
              ledger: run.ledger ?? [],
              updatedAt: run.updatedAt,
            })),
          });
        if (path === "/api/runtime/data/schema")
          return json(res, 200, discoverApprovedData(url.searchParams.get("dataset") ?? undefined));
        if (path === "/api/runtime/composer")
          return json(res, 200, {
            tasks: runtime.composer.all(),
            readiness: runtime.composer.readiness(),
          });
        const composerTask = /^\/api\/runtime\/composer\/([^/]+)$/.exec(path);
        if (composerTask) {
          const task = runtime.composer.get(decodeURIComponent(composerTask[1]));
          // Derived on read from persisted state, so it survives refreshes and restarts.
          return json(res, 200, {
            task,
            lifecycle: deriveLifecycle(task, {
              runtime,
              messages: runtime.groupChat?.messages() ?? [],
            }),
          });
        }
        if (path === "/api/agents/discover")
          return json(res, 200, {
            agents: runtime.agents,
            sharedAgentId: runtime.sharedAgentId,
            capability: runtime.gateway.capabilities()["agents.list"],
          });
        if (path === "/api/runtime/state") return json(res, 200, runtime.snapshot());
        if (path === "/api/runtime/office-overview") return json(res, 200, officeOverview(runtime));
        if (path === "/api/runtime/office-group")
          return json(res, 200, { messages: runtime.groupChat.messages() });
        if (path === "/api/runtime/investigations")
          return json(res, 200, { investigations: investigationList(runtime) });
        if (path === "/api/runtime/inventory-eligibility")
          return json(res, 200, inventoryEligibility(runtime));
        const evidenceRoute = /^\/api\/runtime\/investigations\/([^/]+)\/evidence\/([^/]+)$/.exec(
          path,
        );
        if (evidenceRoute)
          return json(res, 200, {
            evidence: evidenceDetail(
              runtime,
              decodeURIComponent(evidenceRoute[1]),
              decodeURIComponent(evidenceRoute[2]),
            ),
          });
        const investigationRoute = /^\/api\/runtime\/investigations\/([^/]+)$/.exec(path);
        if (investigationRoute)
          return json(res, 200, {
            investigation: investigationView(runtime, decodeURIComponent(investigationRoute[1])),
          });
        if (path === "/api/runtime/voice/diagnostics")
          return json(res, 200, runtime.voice.snapshot());
        if (path === "/api/runtime/reviews")
          return json(res, 200, {
            reviews: runtime.reviews.snapshot(),
            recovery: runtime.reviews.recovery,
          });
        if (path === "/api/runtime/management")
          return json(res, 200, runtime.management.snapshot());
        if (path === "/api/runtime/models")
          return json(
            res,
            200,
            await runtime.management.models(
              url.searchParams.get("agentId"),
              url.searchParams.get("sessionKey") ?? undefined,
            ),
          );
        if (path === "/api/runtime/session-config")
          return json(
            res,
            200,
            await runtime.management.session(
              url.searchParams.get("key"),
              url.searchParams.get("agentId"),
            ),
          );
        if (path === "/api/runtime/tasks") {
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
          const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
          return json(res, 200, {
            tasks: runtime.db.listTasks(limit, offset),
            nextOffset: offset + limit,
          });
        }
        const taskDetail = /^\/api\/runtime\/tasks\/([^/]+)$/.exec(path);
        if (taskDetail) {
          const task = runtime.db.getTask(decodeURIComponent(taskDetail[1]));
          if (!task) return json(res, 404, { error: "Task not found" });
          return json(res, 200, {
            task,
            events: runtime.db.taskEvents(task.taskId),
            messages: runtime
              .taskOwner(task)
              .db.messages(task.sessionKey)
              .filter(
                (message) =>
                  message.taskId === task.taskId || (task.runId && message.runId === task.runId),
              ),
          });
        }
        if (path === "/api/runtime/history")
          return json(
            res,
            200,
            await runtime
              .sessionOwner(url.searchParams.get("sessionKey"))
              .history(url.searchParams.get("sessionKey")),
          );
        if (path === "/api/runtime/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          const write = (event) => {
            if (res.writableLength > 1024 * 1024) {
              res.end();
              return;
            }
            const value =
              event.kind === "seat" ? { ...event, data: runtime.seatView(event.data) } : event;
            res.write(`${event.seq ? `id: ${event.seq}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
          };
          const cursor = Number(req.headers["last-event-id"] ?? url.searchParams.get("after"));
          const replay =
            Number.isSafeInteger(cursor) && cursor > 0 && cursor <= runtime.db.cursor()
              ? runtime.db.replay(cursor)
              : null;
          if (!replay || replay.length > 1000)
            write({ kind: "snapshot", data: runtime.snapshot(), seq: runtime.db.cursor() });
          else {
            replay.forEach(write);
            write({ kind: "connection", data: runtime.connection() });
          }
          const unsubscribe = runtime.db.subscribe(write);
          const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
          timer.unref();
          res.on("close", () => {
            clearInterval(timer);
            unsubscribe();
          });
          return true;
        }
        const match = /^\/api\/runtime\/tasks\/([^/]+)$/.exec(path);
        if (match) {
          const task = runtime.db.getTask(decodeURIComponent(match[1]));
          return json(res, task ? 200 : 404, task ? { task } : { error: "Task not found" });
        }
      }
      if (req.method === "POST") {
        const input = await body(req);
        if (path === "/api/runtime/estop") {
          if (typeof input.engaged !== "boolean" || !runtime.estop)
            return json(res, 400, { error: "Provide engaged: true or false." });
          return json(
            res,
            200,
            input.engaged ? runtime.estop.engage(input.reason ?? "") : runtime.estop.release(),
          );
        }
        if (path === "/api/runtime/composer")
          return json(res, 201, { task: runtime.composer.create(input) });
        if (path === "/api/runtime/team")
          return json(res, 201, { run: runtime.teamLead.start(input) });
        const teamControl = /^\/api\/runtime\/team\/([^/]+)\/(steer|stop)$/.exec(path);
        if (teamControl) {
          const run = runtime.teamLead.get(decodeURIComponent(teamControl[1]));
          if (!run.workIncidentId)
            return json(res, 409, { error: "The team has not been assigned yet." });
          const control = { incidentId: run.workIncidentId, nodeId: input.nodeId };
          return json(res, 200, {
            result:
              teamControl[2] === "steer"
                ? runtime.operations.orchestration.steer({ ...control, message: input.message })
                : runtime.operations.orchestration.stop({ ...control, reason: input.reason }),
          });
        }
        const composerAction =
          /^\/api\/runtime\/composer\/([^/]+)\/(confirm|correct|approve)$/.exec(path);
        if (composerAction)
          return json(res, 200, {
            task: runtime.composer.action(
              decodeURIComponent(composerAction[1]),
              composerAction[2],
              input,
            ),
          });
        if (path === "/api/runtime/voice/actions")
          return json(res, 200, await runtime.voice.action(input));
        if (path === "/api/runtime/voice/context")
          return json(res, 200, { agent: await runtime.voice.retrieveContext(input) });
        if (path === "/api/runtime/voice/diagnostics")
          return json(res, 200, {
            call: input.callId
              ? runtime.voice.report(input)
              : runtime.voice.recordFailure(input.selection, input.diagnostic),
          });
        if (path === "/api/runtime/voice/transcripts")
          return json(res, 200, { message: runtime.voice.finalize(input) });
        if (path === "/api/runtime/tasks") {
          // A seat agent cannot read data, so data work goes to the verified pipeline instead
          // of becoming an advice-only seat task.
          const work = runtime.composer && dataIntent(input.message, { inventory: true });
          if (work) {
            const composed = runtime.composer.create({
              submissionId: String(input.taskId ?? ""),
              goal: work.goal,
            });
            return json(res, 202, {
              redirected: {
                composerTaskId: composed.id,
                status: composed.status,
                reason:
                  "This request needs data the seat agent cannot read; it runs in the verified work pipeline.",
              },
            });
          }
          return json(res, 202, { task: runtime.seatOwner(input.seatId).submit(input) });
        }
        if (path === "/api/runtime/investigations")
          return json(res, 201, { investigation: startInvestigation(runtime, input) });
        const investigationAction =
          /^\/api\/runtime\/investigations\/([^/]+)\/(accept-plan|collect-evidence|confirm-evidence|accept-analyst|finish|revise)$/.exec(
            path,
          );
        if (investigationAction) {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            (investigationAction[2] === "revise"
              ? Object.keys(input).some((key) => key !== "scenarioId") ||
                (input.scenarioId !== undefined &&
                  (typeof input.scenarioId !== "string" ||
                    !/^[A-Za-z0-9._-]{1,64}$/.test(input.scenarioId)))
              : Object.keys(input).length)
          )
            return json(res, 400, { error: "Investigation actions do not accept input." });
          return json(res, 200, {
            investigation: await actOnInvestigation(
              runtime,
              decodeURIComponent(investigationAction[1]),
              investigationAction[2],
              input,
            ),
          });
        }
        if (path === "/api/runtime/management")
          return json(res, 200, { operation: await runtime.management.mutate(input) });
        if (path === "/api/runtime/reviews/reconcile") {
          await runtime.reviews.recover();
          return json(res, 200, {
            reviews: runtime.reviews.snapshot(),
            recovery: runtime.reviews.recovery,
          });
        }
        const decision = /^\/api\/runtime\/reviews\/([^/]+)\/decide$/.exec(path);
        if (decision)
          return json(res, 200, {
            review: await runtime.reviews.decide(decodeURIComponent(decision[1]), input),
          });
        if (path === "/api/runtime/seats") return json(res, 200, { seat: runtime.saveSeat(input) });
        if (path === "/api/runtime/office-group")
          return json(res, 201, { message: runtime.groupChat.send(input) });
        if (path === "/api/runtime/import") return json(res, 200, runtime.importLegacy(input));
        if (path === "/api/runtime/bootstrap")
          return json(res, 200, runtime.bootstrapSeats(input.seats));
        if (path === "/api/runtime/sessions")
          return json(res, 201, {
            session: runtime.seatOwner(input.seatId).newSession(input.seatId),
          });
        if (path === "/api/runtime/connect") {
          runtime.gateway.start();
          return json(res, 202, runtime.connection());
        }
        if (path === "/api/runtime/disconnect") {
          runtime.gateway.stop();
          return json(res, 200, runtime.connection());
        }
        if (path === "/api/runtime/reconcile") {
          await runtime.refresh();
          return json(res, 200, runtime.snapshot());
        }
        const cancel = /^\/api\/runtime\/tasks\/([^/]+)\/cancel$/.exec(path);
        if (cancel)
          return json(res, 200, {
            task: await runtime
              .taskOwner(runtime.db.getTask(decodeURIComponent(cancel[1])))
              .cancel(decodeURIComponent(cancel[1]), input),
          });
        const role = /^\/api\/runtime\/seats\/([^/]+)\/role$/.exec(path);
        if (role)
          return json(
            res,
            200,
            await runtime
              .seatOwner(decodeURIComponent(role[1]))
              .applyRole(decodeURIComponent(role[1]), input.revision, input.expectedHash),
          );
      }
      return json(res, 405, { error: "Unsupported runtime endpoint or method" });
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      return json(res, error.status ?? 500, {
        error: error.status
          ? error.message
          : "Task service failed. Durable storage or backend access may be unavailable.",
      });
    }
  };
}
