import { expect, it, vi } from "vitest";
import { sponsorReadiness } from "../server/sponsor-readiness.mjs";
const config = {
  AGENT_PROVIDER: "nightshift",
  AGENT_TOWN_INVENTORY_MODE: "zetaris",
  NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1",
  NIGHTSHIFT_API_KEY: "secret-nightshift",
  ZETARIS_OPEN_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/start",
  ZETARIS_PAGE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
  ZETARIS_CLOSE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
  ZETARIS_PAGE_METHOD: "GET",
  ZETARIS_CLOSE_METHOD: "DELETE",
  ZETARIS_BEARER_TOKEN: "secret-zetaris",
  ZETARIS_ORG_ID: "1",
  ZETARIS_ROWS_KEY: "records",
  ZETARIS_QUERY_TOKEN_KEY: "queryToken",
  ZETARIS_ALLOW_LOOPBACK_HTTP: "1",
  ZETARIS_PROBE_SELECT: "SELECT 1",
};
it("reports missing variable names without claiming live acceptance", () => {
  const result = sponsorReadiness({});
  expect(result.nightshift.missing).toContain("NIGHTSHIFT_API_KEY");
  expect(result.zetaris.missing).toContain("ZETARIS_BEARER_TOKEN");
  expect(result.liveAcceptance).toBe("NOT TESTED");
});
it("checks profiles offline and never emits configuration values", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const result = sponsorReadiness(config);
    expect(result.nightshift).toMatchObject({ profileValid: true, endpointScope: "this_machine" });
    expect(result.zetaris).toMatchObject({ profileValid: true, probeSelectValid: true });
    expect(result.liveAcceptance).toBe("NOT TESTED");
    expect(fetch).not.toHaveBeenCalled();
    const text = JSON.stringify(result);
    for (const secret of ["secret-nightshift", "secret-zetaris", "SELECT 1", ":8888", ":8088"])
      expect(text).not.toContain(secret);
  } finally {
    fetch.mockRestore();
  }
});
it("rejects credential-bearing URLs and write probes without echoing either", () => {
  const result = sponsorReadiness({
    ...config,
    NIGHTSHIFT_BASE_URL: "https://private:secret@invalid.local/v1",
    ZETARIS_PROBE_SELECT: "DELETE FROM private_table",
  });
  expect(result.nightshift.profileValid).toBe(false);
  expect(result.zetaris.probeSelectValid).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/private_table|invalid.local|secret@/);
});
it("distinguishes configured profiles from provider selection", () => {
  const result = sponsorReadiness({
    ...config,
    AGENT_PROVIDER: "openclaw",
    AGENT_TOWN_INVENTORY_MODE: "synthetic",
  });
  expect(result.nightshift.profileValid).toBe(true);
  expect(result.nightshift.selectedForExecution).toBe(false);
  expect(result.zetaris.selectedForEvidence).toBe(false);
});

it("rejects the runtime placeholder token without displaying it", () => {
  const result = sponsorReadiness({ ...config, NIGHTSHIFT_API_KEY: "rt-local" });
  expect(result.nightshift.profileValid).toBe(false);
  expect(JSON.stringify(result)).not.toContain("rt-local");
});
