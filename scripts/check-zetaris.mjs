import { compileReadQuery } from "../lib/server/data-source.mjs";
import {
  createZetarisDataSource,
  createZetarisHttpTransport,
} from "../lib/server/data-zetaris.mjs";

// Live probe only. No synthetic fallback, no Agent Town task, and no evidence is persisted.
const env = process.env;
const required = [
  "ZETARIS_OPEN_URL",
  "ZETARIS_PAGE_URL",
  "ZETARIS_CLOSE_URL",
  "ZETARIS_PAGE_METHOD",
  "ZETARIS_CLOSE_METHOD",
  "ZETARIS_BEARER_TOKEN",
  "ZETARIS_ROWS_KEY",
  "ZETARIS_QUERY_TOKEN_KEY",
  "ZETARIS_ORG_ID",
  "ZETARIS_PROBE_SELECT",
];
const missing = required.filter((key) => !env[key]);
if (missing.length) {
  process.stderr.write(`live Zetaris probe: missing_configuration (${missing.join(", ")})\n`);
  process.exitCode = 2;
} else {
  try {
    if (env.ZETARIS_ROWS_KEY !== "records" || env.ZETARIS_QUERY_TOKEN_KEY !== "queryToken")
      throw new Error("Installed Zetaris response keys must be records and queryToken.");
    const select = compileReadQuery({
      id: "live-probe",
      source: "live_probe",
      sql: env.ZETARIS_PROBE_SELECT,
      parameters: {},
    });
    const transport = createZetarisHttpTransport({
      profile: "installed-sql-v1",
      openUrl: env.ZETARIS_OPEN_URL,
      pageUrl: env.ZETARIS_PAGE_URL,
      closeUrl: env.ZETARIS_CLOSE_URL,
      pageMethod: env.ZETARIS_PAGE_METHOD,
      closeMethod: env.ZETARIS_CLOSE_METHOD,
      bearerToken: env.ZETARIS_BEARER_TOKEN,
      orgId: env.ZETARIS_ORG_ID,
      allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
    });
    const rows = await createZetarisDataSource({ transport, pageLimit: 20, maxPages: 2 }).query({
      sql: select,
    });
    process.stdout.write(
      `live Zetaris query transport verified: ${rows.length} row(s); no evidence persisted\n`,
    );
  } catch (error) {
    process.stderr.write(
      `live Zetaris probe failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  }
}
