import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const sqlFingerprint = (sql) => createHash("sha256").update(sql).digest("hex");
const setting = (env, name, fallback, max) => {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 100 || value > max)
    throw new Error(`Invalid ${name}: expected 100..${max} milliseconds.`);
  return value;
};
/** Historical observations inform a bounded waiting budget, never a promised completion time.
 * Failed/cancelled reads cannot train the budget or trigger a retry. Exact SQL and endpoint
 * identity prevent a cheap probe or another dataset from influencing an expensive query. */
export function zetarisDeadlines(env = {}, audits = []) {
  const baseline = setting(env, "ZETARIS_OPEN_TIMEOUT_MS", 10000, 300000);
  const maximum = setting(env, "ZETARIS_OPEN_MAX_TIMEOUT_MS", 120000, 300000);
  if (baseline > maximum)
    throw new Error("Zetaris opening baseline exceeds its configured maximum.");
  const pageTimeoutMs = setting(env, "ZETARIS_PAGE_TIMEOUT_MS", 10000, 30000);
  const cleanupTimeoutMs = setting(env, "ZETARIS_CLEANUP_TIMEOUT_MS", 10000, 30000);
  let imported = [];
  if (env.ZETARIS_QUERY_TIMINGS_PATH) {
    if (statSync(env.ZETARIS_QUERY_TIMINGS_PATH).size > 100000)
      throw new Error("Zetaris timing measurements exceed their size limit.");
    imported = JSON.parse(readFileSync(env.ZETARIS_QUERY_TIMINGS_PATH, "utf8"));
    if (!Array.isArray(imported) || imported.length > 100)
      throw new Error("Invalid Zetaris timing measurements.");
  }
  const origin = env.ZETARIS_OPEN_URL ? new URL(env.ZETARIS_OPEN_URL).origin : null;
  const samples = [...imported, ...audits.slice(-100).map((audit) => audit.diagnostics)].filter(
    Boolean,
  );
  return {
    pageTimeoutMs,
    cleanupTimeoutMs,
    openDeadline(sql) {
      const fingerprint = sqlFingerprint(sql);
      const matching = samples.filter(
        (sample) =>
          sample.outcome === "success" &&
          sample.origin === origin &&
          sample.sqlFingerprint === fingerprint &&
          Number.isFinite(sample.openElapsedMs) &&
          sample.openElapsedMs > 0 &&
          Number.isFinite(Date.parse(sample.finishedAt)) &&
          Date.now() - Date.parse(sample.finishedAt) >= 0 &&
          Date.now() - Date.parse(sample.finishedAt) <= 7 * 86400000,
      );
      const observedMs = matching.length
        ? Math.max(...matching.map((sample) => sample.openElapsedMs))
        : null;
      return {
        timeoutMs:
          observedMs === null
            ? baseline
            : Math.min(
                maximum,
                Math.max(baseline, Math.ceil((observedMs * 2 + 5000) / 1000) * 1000),
              ),
        observedMs,
        sampleCount: matching.length,
        maximumMs: maximum,
        basis:
          observedMs === null
            ? "unmeasured_configured_baseline"
            : "successful_exact_sql_observations",
      };
    },
  };
}
