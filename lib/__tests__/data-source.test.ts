import { describe, expect, it, vi } from "vitest";
import { createDataReader, compileReadQuery } from "../server/data-source.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import {
  MAX_ZETARIS_RESPONSE_BYTES,
  createZetarisDataSource,
  createZetarisHttpTransport,
} from "../server/data-zetaris.mjs";
import { EXAMPLE_DATA_TEMPLATES, SYNTHETIC_DATA_FIXTURES } from "../server/data-fixtures.mjs";
import { assertOperationContract } from "../operations-contracts.mjs";
import type { ReadTemplate } from "../server/data-source.mjs";

const scope = {
  incidentId: "pressure-incident",
  taskId: "pump-read-task",
  agentId: "data-steward",
  seatId: "seat-data",
  gatewayId: "gateway-a",
  sessionKey: "agent:data-steward:main",
  bindingRevision: 3,
};
const template = EXAMPLE_DATA_TEMPLATES["pump-pressure-readings"];
const templates: Record<string, ReadTemplate> = {
  "pump-pressure-readings": { ...template, parameters: { buildingId: "text" } },
};
const readInput = {
  scope,
  templateId: "pump-pressure-readings",
  parameters: { buildingId: "building-a" },
};
const page = { rows: [], token: "q1", more: false };
const responsePage = (body: string) => new Response(body, { status: 200 });
const baseHttpProfile = {
  profile: "custom",
  openUrl: "https://zetaris.example/api/open",
  pageUrl: "https://zetaris.example/api/page",
  closeUrl: "https://zetaris.example/api/close",
  pageMethod: "GET",
  closeMethod: "DELETE",
  bearerToken: "server-secret",
  parsePage: (response: { rows: unknown[]; token: string; more: boolean }) => ({
    records: response.rows,
    queryToken: response.token,
    hasMore: response.more,
  }),
};

describe("Lane B read-only evidence adapters (mocked, not live Zetaris)", () => {
  it("returns explicitly synthetic, bounded evidence with real scope and source freshness", async () => {
    const reader = createDataReader({
      mode: "synthetic",
      templates,
      synthetic: createSyntheticDataSource(SYNTHETIC_DATA_FIXTURES),
      now: () => new Date("2026-10-25T08:08:00Z"),
    });
    const result = await reader.read(readInput);
    expect(result.scope).toEqual(scope);
    expect(result.mode).toBe("synthetic");
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({
      incidentId: scope.incidentId,
      taskId: scope.taskId,
      source: "synthetic:pump_pressure_readings",
      recordId: "pump-101",
      sourceTimestamp: "2026-10-25T08:00:00Z",
      retrievedAt: "2026-10-25T08:08:00.000Z",
      freshUntil: "2026-10-25T08:15:00.000Z",
    });
    expect(JSON.parse(result.evidence[0].content)).toEqual({
      pressure_kpa: 310,
      pump_state: "running",
    });
    expect(assertOperationContract("evidenceItem", result.evidence[0])).toBe(result.evidence[0]);
    expect((await reader.read(readInput)).evidence[0].evidenceId).toBe(
      result.evidence[0].evidenceId,
    );
    await expect(
      reader.read({ ...readInput, parameters: { buildingId: "different" } }),
    ).rejects.toThrow(/fixture/);
  });

  it("keeps unknown source time and freshness explicitly unknown", async () => {
    const reader = createDataReader({
      mode: "synthetic",
      templates: {
        ...templates,
        untimed: {
          ...template,
          id: "untimed",
          sql: "SELECT reading_id, pressure_kpa FROM pump_pressure_readings",
          parameters: {},
        },
      },
      synthetic: createSyntheticDataSource({
        untimed: { parameters: {}, rows: [{ reading_id: "r1", pressure_kpa: 100 }] },
      }),
    });
    const { evidence } = await reader.read({ scope, templateId: "untimed" });
    expect(evidence[0].sourceTimestamp).toBeNull();
    expect(evidence[0]).not.toHaveProperty("freshUntil");
  });

  it("rejects arbitrary SQL, unknown parameters, unsafe scope and unprojected records", async () => {
    expect(() =>
      compileReadQuery({ ...templates["pump-pressure-readings"], sql: "DELETE FROM readings" }, {}),
    ).toThrow(/SELECT/);
    expect(() =>
      compileReadQuery(
        {
          ...templates["pump-pressure-readings"],
          sql: "SELECT * FROM readings; DROP TABLE readings",
        },
        {},
      ),
    ).toThrow(/SELECT/);
    expect(() =>
      compileReadQuery(templates["pump-pressure-readings"], { buildingId: "a' OR 1=1 --" }),
    ).not.toThrow();
    expect(
      compileReadQuery(templates["pump-pressure-readings"], { buildingId: "a' OR 1=1 --" }),
    ).toContain("'a'' OR 1=1 --'");
    expect(() =>
      compileReadQuery(templates["pump-pressure-readings"], {
        buildingId: "building-a",
        sql: "DELETE",
      }),
    ).toThrow(/Unknown/);
    expect(() => compileReadQuery(templates["pump-pressure-readings"], {})).toThrow(/Missing/);
    expect(() =>
      compileReadQuery(
        { ...templates["pump-pressure-readings"], parameters: {} },
        { buildingId: "building-a" },
      ),
    ).toThrow(/Unknown/);
    const reader = createDataReader({
      mode: "zetaris",
      templates,
      zetaris: { query: vi.fn().mockResolvedValue([{ reading_id: "r1", secret: "not allowed" }]) },
    });
    await expect(
      reader.read({ ...readInput, scope: { ...scope, bindingRevision: 0 } }),
    ).rejects.toThrow(/binding/);
    await expect(reader.read(readInput)).rejects.toThrow(/allowed content/);
  });

  it("substitutes only reviewed template placeholders, preserving colons and quotes in text", () => {
    expect(
      compileReadQuery(templates["pump-pressure-readings"], { buildingId: "rack:west" }),
    ).toContain("building_id = 'rack:west'");
    expect(
      compileReadQuery(templates["pump-pressure-readings"], {
        buildingId: "rack:west's 'backup'",
      }),
    ).toContain("building_id = 'rack:west''s ''backup'''");
    expect(() =>
      compileReadQuery(
        {
          ...templates["pump-pressure-readings"],
          sql: "SELECT id FROM rack WHERE name = :undeclared",
        },
        { buildingId: "rack:west" },
      ),
    ).toThrow(/Unknown/);
    expect(() =>
      compileReadQuery(
        {
          ...templates["pump-pressure-readings"],
          sql: "SELECT id FROM rack WHERE name = :undeclared",
        },
        {},
      ),
    ).toThrow(/Missing/);
  });

  it("paginates and closes a Zetaris query even when a later page fails", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const transport = {
      open: vi.fn().mockResolvedValue({
        queryToken: "query-1",
        records: [SYNTHETIC_DATA_FIXTURES["pump-pressure-readings"].rows[0]],
        hasMore: true,
      }),
      page: vi.fn().mockResolvedValue({
        queryToken: "query-1",
        records: [SYNTHETIC_DATA_FIXTURES["pump-pressure-readings"].rows[1]],
        hasMore: false,
      }),
      close,
    };
    const reader = createDataReader({
      mode: "zetaris",
      templates,
      zetaris: createZetarisDataSource({ transport }),
    });
    const result = await reader.read(readInput);
    expect(result.evidence.map((item) => item.source)).toEqual([
      "zetaris:pump_pressure_readings",
      "zetaris:pump_pressure_readings",
    ]);
    expect(transport.open).toHaveBeenCalledWith({
      select: expect.stringContaining("WHERE building_id = 'building-a'"),
      pageLimit: 50,
    });
    expect(transport.page).toHaveBeenCalledWith({
      queryToken: "query-1",
      pageLimit: 50,
      pageNumber: 2,
    });
    expect(close).toHaveBeenCalledWith({ queryToken: "query-1" });
    transport.page.mockRejectedValueOnce(new Error("offline"));
    await expect(reader.read(readInput)).rejects.toThrow(/offline/);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects incomplete pages and never labels mocked responses as live verification", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const adapter = createZetarisDataSource({
      maxPages: 1,
      transport: {
        open: vi.fn().mockResolvedValue({ queryToken: "q", records: [], hasMore: true }),
        page: vi.fn(),
        close,
      },
    });
    await expect(adapter.query({ sql: "SELECT 1" })).rejects.toThrow(/page limit/);
    expect(close).toHaveBeenCalledWith({ queryToken: "q" });
  });

  it("uses only explicitly configured HTTPS endpoints and bearer credentials", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: URL) =>
        String(url).includes("/close")
          ? new Response(null, { status: 204 })
          : responsePage(JSON.stringify(page)),
      );
    const transport = createZetarisHttpTransport({
      ...baseHttpProfile,
      orgId: "org-1",
      fetchImpl,
    });
    await createZetarisDataSource({ transport }).query({ sql: "SELECT id FROM allowed_view" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer server-secret",
      "X-Org-ID": "org-1",
    });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      select: "SELECT id FROM allowed_view",
      pageLimit: 50,
    });
    expect(String(fetchImpl.mock.calls[1][0])).toContain("queryToken=q1");
    expect(() =>
      createZetarisHttpTransport({
        openUrl: "http://internal.example/open",
        pageUrl: "http://internal.example/page",
        closeUrl: "http://internal.example/close",
        pageMethod: "GET",
        closeMethod: "DELETE",
        bearerToken: "secret",
        parsePage: () => ({}),
      }),
    ).toThrow(/profile/);
    expect(() =>
      createZetarisHttpTransport({
        ...baseHttpProfile,
        openUrl: "http://localhost:8888/open",
        pageUrl: "http://localhost:8888/page",
        closeUrl: "http://localhost:8888/close",
      }),
    ).toThrow(/profile/);
    expect(() =>
      createZetarisHttpTransport({
        ...baseHttpProfile,
        openUrl: "http://localhost:8888/open",
        pageUrl: "http://localhost:8888/page",
        closeUrl: "http://localhost:8888/close",
        allowLoopbackHttp: true,
      }),
    ).not.toThrow();
    expect(() =>
      createZetarisHttpTransport({
        ...baseHttpProfile,
        openUrl: "http://internal.example/open",
        pageUrl: "http://internal.example/page",
        closeUrl: "http://internal.example/close",
        allowLoopbackHttp: true,
      }),
    ).toThrow(/profile/);
  });

  it("accepts streamed UTF-8 JSON below and exactly at the byte limit", async () => {
    const json = JSON.stringify({ rows: [{ label: "é" }], token: "q1", more: false });
    const baseBytes = Buffer.byteLength(json, "utf8");
    for (const size of [baseBytes, MAX_ZETARIS_RESPONSE_BYTES]) {
      const body = json + " ".repeat(size - baseBytes);
      const fetchImpl = vi
        .fn()
        .mockImplementation(async (url: URL) =>
          String(url).includes("/close") ? new Response(null, { status: 204 }) : responsePage(body),
        );
      const transport = createZetarisHttpTransport({ ...baseHttpProfile, fetchImpl });
      await expect(
        createZetarisDataSource({ transport }).query({ sql: "SELECT label FROM rack" }),
      ).resolves.toEqual([{ label: "é" }]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("cancels an oversized multibyte page and closes its open query", async () => {
    const cancel = vi.fn();
    const prefix = JSON.stringify({
      rows: [{ label: "é".repeat(1_000_000) }],
      token: "q1",
      more: false,
    });
    expect(prefix.length).toBeLessThan(MAX_ZETARIS_RESPONSE_BYTES);
    expect(Buffer.byteLength(prefix, "utf8")).toBeGreaterThan(MAX_ZETARIS_RESPONSE_BYTES);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(prefix);
        controller.enqueue(bytes.subarray(0, MAX_ZETARIS_RESPONSE_BYTES));
        controller.enqueue(bytes.subarray(MAX_ZETARIS_RESPONSE_BYTES));
      },
      cancel,
    });
    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      if (String(url).includes("/open"))
        return responsePage(JSON.stringify({ rows: [], token: "q1", more: true }));
      if (String(url).includes("/page")) return new Response(body, { status: 200 });
      return new Response(null, { status: 204 });
    });
    const transport = createZetarisHttpTransport({ ...baseHttpProfile, fetchImpl });
    await expect(
      createZetarisDataSource({ transport }).query({ sql: "SELECT label FROM rack" }),
    ).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[2][0])).toContain("/close?queryToken=q1");
  });

  it("closes the query after a page stream read failure", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("stream read failed");
      },
    });
    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      if (String(url).includes("/open"))
        return responsePage(JSON.stringify({ rows: [], token: "q1", more: true }));
      if (String(url).includes("/page")) return new Response(body, { status: 200 });
      return new Response(null, { status: 204 });
    });
    const transport = createZetarisHttpTransport({
      ...baseHttpProfile,
      fetchImpl,
      timeoutMs: 1000,
    });
    await expect(
      createZetarisDataSource({ transport }).query({ sql: "SELECT label FROM rack" }),
    ).rejects.toThrow(/stream read failed/);
    expect(String(fetchImpl.mock.calls[2][0])).toContain("/close?queryToken=q1");
    expect(fetchImpl.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("retains the request timeout while reading and closes an existing query token", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: URL, options: RequestInit) => {
      if (String(url).includes("/open"))
        return responsePage(JSON.stringify({ rows: [], token: "q1", more: true }));
      if (String(url).includes("/page")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              options.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("read timed out")),
                { once: true },
              );
            },
          }),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    });
    const transport = createZetarisHttpTransport({ ...baseHttpProfile, fetchImpl, timeoutMs: 100 });
    await expect(
      createZetarisDataSource({ transport }).query({ sql: "SELECT label FROM rack" }),
    ).rejects.toThrow(/read timed out/);
    expect(String(fetchImpl.mock.calls[2][0])).toContain("/close?queryToken=q1");
  });
});
