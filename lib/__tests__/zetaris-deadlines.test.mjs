import { expect, it, vi } from "vitest";
import { sqlFingerprint, zetarisDeadlines } from "../server/zetaris-deadlines.mjs";
import { createZetarisDataSource, createZetarisHttpTransport } from "../server/data-zetaris.mjs";
import { ServiceRegistry } from "../server/service-registry.mjs";

const env = { ZETARIS_OPEN_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/start" };
const sample = {
  sqlFingerprint: sqlFingerprint("SELECT 1"),
  outcome: "success",
  origin: "http://127.0.0.1:8888",
  openElapsedMs: 33000,
  finishedAt: new Date().toISOString(),
};
it("learns bounded per-SQL budgets only from recent successful observations", () => {
  const policy = zetarisDeadlines(env, [{ diagnostics: sample }]);
  expect(policy.openDeadline("SELECT 1")).toMatchObject({
    timeoutMs: 71000,
    observedMs: 33000,
    sampleCount: 1,
  });
  expect(policy.openDeadline("SELECT 2")).toMatchObject({ timeoutMs: 10000, observedMs: null });
  for (const change of [
    { outcome: "timeout" },
    { origin: "https://other" },
    { finishedAt: "2020-01-01" },
  ])
    expect(
      zetarisDeadlines(env, [{ diagnostics: { ...sample, ...change } }]).openDeadline("SELECT 1")
        .observedMs,
    ).toBeNull();
  expect(
    zetarisDeadlines({ ...env, ZETARIS_OPEN_MAX_TIMEOUT_MS: "60000" }, [
      { diagnostics: sample },
    ]).openDeadline("SELECT 1").timeoutMs,
  ).toBe(60000);
  expect(() => zetarisDeadlines({ ZETARIS_PAGE_TIMEOUT_MS: "999999" })).toThrow();
});
it("allows a measured slow opening while preserving separate page and cleanup deadlines", async () => {
  vi.useFakeTimers();
  const budgets = [];
  const abort = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    budgets.push(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  });
  let call = 0;
  const fetchImpl = vi.fn(async (_url, options) => {
    call++;
    if (call === 1) {
      await new Promise((resolve) => setTimeout(resolve, 33000));
      options.signal.throwIfAborted();
    }
    if (options.method === "DELETE") return new Response(null);
    return Response.json({
      records: [{ id: call }],
      queryToken: "private-query-token",
      pageNumber: call,
      pageLimit: 50,
      totalCount: 2,
      totalPages: 2,
    });
  });
  const onDiagnostics = vi.fn();
  try {
    const transport = createZetarisHttpTransport({
      profile: "installed-sql-v1",
      openUrl: env.ZETARIS_OPEN_URL,
      pageUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
      closeUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
      pageMethod: "GET",
      closeMethod: "DELETE",
      bearerToken: "private-bearer",
      orgId: "1",
      allowLoopbackHttp: true,
      ...zetarisDeadlines(
        { ...env, ZETARIS_PAGE_TIMEOUT_MS: "4000", ZETARIS_CLEANUP_TIMEOUT_MS: "2000" },
        [{ diagnostics: sample }],
      ),
      fetchImpl,
    });
    const result = createZetarisDataSource({ transport }).query({ sql: "SELECT 1", onDiagnostics });
    await vi.advanceTimersByTimeAsync(33001);
    await expect(result).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(budgets).toEqual([71000, 4000, 2000]);
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success", cleanup: "succeeded", sql: "SELECT 1" }),
    );
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("private-");
  } finally {
    abort.mockRestore();
    vi.useRealTimers();
  }
});
it("keeps query timeouts distinct from unreachable service observations", () => {
  const registry = new ServiceRegistry({
    env: {
      ...env,
      ZETARIS_PAGE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
      ZETARIS_CLOSE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
      ZETARIS_PAGE_METHOD: "GET",
      ZETARIS_CLOSE_METHOD: "DELETE",
      ZETARIS_BEARER_TOKEN: "private",
      ZETARIS_ORG_ID: "1",
      ZETARIS_ROWS_KEY: "records",
      ZETARIS_QUERY_TOKEN_KEY: "queryToken",
      ZETARIS_ALLOW_LOOPBACK_HTTP: "1",
    },
  });
  registry.observe("zetaris", "unverified", "query_timeout");
  expect(registry.get("zetaris")).toMatchObject({ status: "unverified", reason: "query_timeout" });
});
