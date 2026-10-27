import { expect, it } from "vitest";
import {
  APPROVED_INVENTORY_ZETARIS_TEMPLATES,
  decodeZetarisInventoryRow,
} from "../server/inventory-zetaris-mapping.mjs";
import { createInventoryStartupReader } from "../server/inventory-startup.mjs";
import { compileReadQuery } from "../server/data-source.mjs";

it("maps only the four verified isolated sources and preserves scoped SELECT parameters", () => {
  expect(Object.keys(APPROVED_INVENTORY_ZETARIS_TEMPLATES)).toHaveLength(4);
  for (const template of Object.values(APPROVED_INVENTORY_ZETARIS_TEMPLATES)) {
    expect(template.source).toMatch(/^zetaris_demo_inventory_/);
    expect(template.sql).toContain("FROM AGENT_TOWN_INVENTORY_DEMO.INVENTORY_");
    const sql = compileReadQuery(template, {
      scenarioId: "complete",
      sku: "SKU-17",
      locationId: "BIN-A",
    });
    expect(sql).toContain(
      "WHERE scenario_id = 'complete' AND sku = 'SKU-17' AND location_id = 'BIN-A'",
    );
    expect(sql).toContain("synthetic_label");
    expect(sql).not.toContain("example_inventory_");
  }
});

it("decodes only known scalar fields without coercing identifiers or false booleans", () => {
  expect(
    decodeZetarisInventoryRow({
      sku: "001",
      quantity_delta: "-2",
      counted_quantity: "9",
      ledger_posted: "false",
      observed_at: "2026-10-26T10:00:00Z",
    }),
  ).toEqual({
    sku: "001",
    quantity_delta: -2,
    counted_quantity: 9,
    ledger_posted: false,
    observed_at: "2026-10-26T10:00:00Z",
  });
  expect(decodeZetarisInventoryRow({ quantity: 2, ledger_posted: true })).toEqual({
    quantity: 2,
    ledger_posted: true,
  });
});

it.each(["", " 2", "2.5", "1e2", "9007199254740992", null, true])(
  "rejects invalid numeric representations %s",
  (quantity) => {
    expect(() => decodeZetarisInventoryRow({ quantity })).toThrow(/integer/);
  },
);
it.each(["0", "FALSE", "", null])("rejects invalid boolean representations %s", (ledger_posted) => {
  expect(() => decodeZetarisInventoryRow({ ledger_posted })).toThrow(/boolean/);
});

it("starts the live mapped reader without HAS_MORE_KEY and never falls back to fixtures", () => {
  const env = {
    AGENT_TOWN_INVENTORY_MODE: "zetaris",
    ZETARIS_OPEN_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/start",
    ZETARIS_PAGE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
    ZETARIS_CLOSE_URL: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
    ZETARIS_PAGE_METHOD: "GET",
    ZETARIS_CLOSE_METHOD: "DELETE",
    ZETARIS_BEARER_TOKEN: "test-only",
    ZETARIS_ORG_ID: "1",
    ZETARIS_ROWS_KEY: "records",
    ZETARIS_QUERY_TOKEN_KEY: "queryToken",
    ZETARIS_ALLOW_LOOPBACK_HTTP: "1",
  };
  expect(
    createInventoryStartupReader(env, {
      approvedLiveTemplates: APPROVED_INVENTORY_ZETARIS_TEMPLATES,
    }),
  ).toBeDefined();
  expect(() => createInventoryStartupReader(env)).toThrow(/approved live/i);
  expect(() =>
    createInventoryStartupReader(
      { ...env, ZETARIS_BEARER_TOKEN: "" },
      { approvedLiveTemplates: APPROVED_INVENTORY_ZETARIS_TEMPLATES },
    ),
  ).toThrow(/missing/i);
});
