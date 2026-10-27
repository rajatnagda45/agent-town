// Synthetic supplier-delivery demo data for Zetaris. Every row is labelled SYNTHETIC DATA.
// Usage (run from the repository root with the private settings in .env.local):
//   node scripts/supplier-demo.mjs generate day1|day2   write JSON files with current timestamps
//   node scripts/supplier-demo.mjs load                 copy them into the Zetaris container
//   node --env-file=.env.local scripts/supplier-demo.mjs register   create DB + tables once
//   node --env-file=.env.local scripts/supplier-demo.mjs verify     read-only row checks
// Only AGENT_TOWN_SUPPLIER_DEMO is created or changed; no other Zetaris data is touched.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supplierRows } from "../lib/server/supplier-demo-data.mjs";

export const SUPPLIER_DATABASE = "AGENT_TOWN_SUPPLIER_DEMO";
export const SUPPLIER_TABLES = [
  "PURCHASE_ORDERS",
  "GOODS_RECEIPTS",
  "SHIPMENTS",
  "SUPPLIER_CONFIRMATIONS",
];
const CONTAINER = process.env.ZETARIS_DRIVER_CONTAINER ?? "zetaris-driver-1";
const SHARED = `/home/zetaris/customer-data/shared/${SUPPLIER_DATABASE}`;
const OUT = join(tmpdir(), "agent-town-supplier-demo");

function zetaris() {
  const open = process.env.ZETARIS_OPEN_URL;
  if (!open || !process.env.ZETARIS_BEARER_TOKEN || !process.env.ZETARIS_ORG_ID)
    throw new Error("Zetaris settings are missing; run with --env-file=.env.local.");
  return {
    base: new URL(open).origin,
    headers: {
      Authorization: `Bearer ${process.env.ZETARIS_BEARER_TOKEN}`,
      "X-Org-ID": process.env.ZETARIS_ORG_ID,
      "Content-Type": "application/json",
    },
  };
}

async function runSql(sql) {
  const { base, headers } = zetaris();
  const response = await fetch(`${base}/api/v1.0/sql-editor/sqls/run-query`, {
    method: "POST",
    headers: { ...headers, "X-Request-ID": crypto.randomUUID() },
    body: JSON.stringify({ sql, limit: 50 }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.text();
  // Bodies are shown truncated; they carry query results, never the bearer token.
  console.log(`${response.status} ${sql.slice(0, 120)}\n  ${body.slice(0, 400)}`);
  if (!response.ok) throw new Error("Zetaris rejected the statement; stopping without retrying.");
  return body;
}

const [command, state] = process.argv.slice(2);
if (command === "generate") {
  mkdirSync(OUT, { recursive: true });
  const rows = supplierRows(state);
  for (const table of SUPPLIER_TABLES)
    writeFileSync(join(OUT, `${table}.json`), JSON.stringify(rows[table], null, 2));
  writeFileSync(join(OUT, "STATE"), `${state} ${new Date().toISOString()}\n`);
  console.log(`Generated ${state} SYNTHETIC supplier data in ${OUT}`);
} else if (command === "load") {
  const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
  execFileSync("docker", ["exec", CONTAINER, "mkdir", "-p", SHARED], { env, stdio: "inherit" });
  for (const table of SUPPLIER_TABLES)
    execFileSync(
      "docker",
      ["cp", join(OUT, `${table}.json`), `${CONTAINER}:${SHARED}/${table}.json`],
      {
        env,
        stdio: "inherit",
      },
    );
  console.log(
    `Loaded ${readFileSync(join(OUT, "STATE"), "utf8").trim()} into ${CONTAINER}:${SHARED}`,
  );
} else if (command === "register") {
  await runSql(
    `CREATE LIGHTNING DATABASE ${SUPPLIER_DATABASE} DESCRIBE BY "SYNTHETIC DATA - Agent Town supplier delivery demonstration" OPTIONS ()`,
  );
  for (const table of SUPPLIER_TABLES)
    await runSql(
      `CREATE LIGHTNING FILESTORE TABLE ${table} FROM ${SUPPLIER_DATABASE} FORMAT JSON OPTIONS (path "${SHARED}/${table}.json", inferSchema "true")`,
    );
} else if (command === "verify") {
  for (const table of SUPPLIER_TABLES)
    await runSql(
      `SELECT COUNT(*) AS row_count, MIN(synthetic_label) AS label, MAX(observed_at) AS observed FROM ${SUPPLIER_DATABASE}.${table}`,
    );
} else {
  console.log("Commands: generate day1|day2, load, register, verify");
  process.exitCode = 2;
}
