import { loadInstalledContracts } from "../lib/server/contracts.mjs";
import { CONTRACTS, REVIEW_SCHEMAS } from "../lib/server/contracts.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ServerGateway } from "../lib/server/gateway-connection.mjs";
import { readOpenClawToken } from "../lib/ws-proxy.mjs";

const audit = await loadInstalledContracts();
console.log(JSON.stringify(audit.report(), null, 2));
if (!audit.results["chat.send"].available || !audit.results["agents.list"].available)
  process.exitCode = 1;
if (process.argv.includes("--write-fixture") && audit.source) {
  const installed = await import(pathToFileURL(audit.source).href);
  const names = [
    ...Object.values(CONTRACTS).map(([name]) => name),
    "ChatEventSchema",
    "AgentEventSchema",
    "AgentsListResultSchema",
    "AgentsFilesGetResultSchema",
    "AgentsFilesSetResultSchema",
    ...REVIEW_SCHEMAS,
  ];
  const schemas = {};
  for (const name of names) {
    const schema = installed[name] ?? installed[`validate${name.replace(/Schema$/, "")}`]?.schema;
    if (schema) schemas[name] = schema;
  }
  await mkdir(new URL("../lib/__fixtures__/", import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../lib/__fixtures__/openclaw-${audit.version}.json`, import.meta.url),
    JSON.stringify(
      {
        version: audit.version,
        protocol: audit.protocol,
        source: "Installed openclaw npm package",
        schemas,
      },
      null,
      2,
    ) + "\n",
  );
}
if (process.argv.includes("--live") && audit.source) {
  const gateway = new ServerGateway({
    url: process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789/",
    token: process.env.GATEWAY_TOKEN ?? readOpenClawToken(),
    audit,
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Live gateway verification timed out")),
        15000,
      );
      gateway.subscribe((kind, status) => {
        if (kind !== "status") return;
        if (status === "connected") {
          clearTimeout(timeout);
          resolve();
        }
        if (status === "auth_failed") {
          clearTimeout(timeout);
          reject(new Error("Gateway rejected the audit connection"));
        }
      });
      gateway.start();
    });
    const agents = await gateway.request("agents.list", {});
    const sessions = await gateway.request("sessions.list", {});
    const readOnly = {};
    for (const method of ["models.list", "question.list"]) {
      if (!gateway.capabilities()[method]?.available) continue;
      try {
        const result = await gateway.request(method, {});
        readOnly[method] = {
          ok: true,
          count: method === "models.list" ? result.models?.length : result.questions?.length,
        };
      } catch {
        readOnly[method] = {
          ok: false,
          reason: "Gateway rejected or could not complete the read-only listing.",
        };
      }
    }
    const key = sessions.sessions?.find((session) =>
      /^agent:[a-zA-Z0-9_-]+:[^\s]+$/.test(session.key),
    )?.key;
    if (
      key &&
      gateway.capabilities()["approval.events"]?.available &&
      gateway.capabilities()["sessions.messages.subscribe"]?.available
    ) {
      try {
        const result = await gateway.request("sessions.messages.subscribe", {
          key,
          agentId: key.split(":")[1],
          includeApprovals: true,
        });
        readOnly.approvalSubscription = {
          ok:
            result.subscribed === true &&
            audit.validate("SessionApprovalReplaySchema", result.approvalReplay),
          truncated: result.approvalReplay?.truncated,
          count: result.approvalReplay?.approvals?.length,
        };
      } catch {
        readOnly.approvalSubscription = {
          ok: false,
          reason:
            "Gateway did not confirm the session approval subscription/replay with this connection's authority.",
        };
      }
    }
    console.log(
      JSON.stringify(
        {
          live: {
            version: gateway.hello.server.version,
            agentCount: agents.agents.length,
            sessionCount: sessions.sessions?.length,
            readOnly,
            capabilities: gateway.capabilities(),
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    gateway.stop();
  }
}
