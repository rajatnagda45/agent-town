import { expect, it, vi } from "vitest";
import { createZetarisDataSource, createZetarisHttpTransport } from "../server/data-zetaris.mjs";

// I:/Downloads/docs.yaml: OpenSqlQuery, PageSqlQuery, CloseSqlQuery.
const profile = {
  profile: "installed-sql-v1",
  openUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/start",
  pageUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
  closeUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
  pageMethod: "GET",
  closeMethod: "DELETE",
  orgId: "1",
  bearerToken: "private-test-token",
  allowLoopbackHttp: true,
};
const token = "query/with ?#%";
const page = (pageNumber: number, totalPages = 3) => ({
  records: [{ id: pageNumber }],
  queryToken: token,
  pageNumber,
  totalCount: totalPages,
  totalPages,
  ...(pageNumber === 1 ? { pageLimit: 50 } : {}),
});
function transportFor(responses: unknown[]) {
  const fetchImpl = vi
    .fn()
    .mockImplementation(async (_url: URL, options: RequestInit) =>
      options.method === "DELETE"
        ? new Response(null, { status: 200 })
        : Response.json(responses.shift()),
    );
  return { fetchImpl, transport: createZetarisHttpTransport({ ...profile, fetchImpl }) };
}

it("implements installed numbered pages, required headers and encoded path cleanup", async () => {
  const { transport, fetchImpl } = transportFor([page(1), page(2), page(3)]);
  await expect(
    createZetarisDataSource({ transport }).query({ sql: "SELECT id FROM approved_view" }),
  ).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  expect(fetchImpl.mock.calls).toHaveLength(4);
  expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body))).toEqual({
    select: "SELECT id FROM approved_view",
    pageLimit: 50,
  });
  for (const index of [1, 2]) {
    const [url, options] = fetchImpl.mock.calls[index];
    expect(options.method).toBe("GET");
    expect(options.body).toBeUndefined();
    expect(Object.fromEntries(url.searchParams)).toEqual({
      queryToken: token,
      pageLimit: "50",
      pageNumber: String(index + 1),
    });
  }
  const [closeUrl, closeOptions] = fetchImpl.mock.calls[3];
  expect(closeUrl.href).toBe(profile.closeUrl.replace("{queryToken}", encodeURIComponent(token)));
  expect(closeUrl.search).toBe("");
  expect(closeOptions.method).toBe("DELETE");
  const requestIds = fetchImpl.mock.calls.map(([, options]) => {
    expect(options.headers).toMatchObject({
      Authorization: "Bearer private-test-token",
      "X-Org-ID": "1",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.redirect).toBe("error");
    const id = (options.headers as Record<string, string>)["X-Request-ID"];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return id;
  });
  expect(new Set(requestIds).size).toBe(4);
});

it.each([
  { ...page(1), totalPages: undefined, hasMore: false },
  { ...page(1), pageNumber: "1" },
  { ...page(1), records: "invalid" },
])("closes an acquired token when the opening response fails validation", async (response) => {
  const { transport, fetchImpl } = transportFor([response]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    /Invalid installed/,
  );
  expect(fetchImpl.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "DELETE"]);
});

it("rejects repeated pages and closes the original token", async () => {
  const { transport, fetchImpl } = transportFor([page(1), page(1)]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    /Invalid installed/,
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("accepts an explicitly empty result with optional records omitted", async () => {
  const { transport, fetchImpl } = transportFor([
    {
      queryToken: token,
      pageNumber: 0,
      pageLimit: 50,
      totalCount: 0,
      totalPages: 0,
    },
  ]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).resolves.toEqual(
    [],
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("accepts the live empty result shape (page 1 of 0) but nothing else beyond the last page", async () => {
  // Observed from the installed Zetaris on 2026-10-27 for a SKU with no rows.
  const empty = {
    records: [],
    queryToken: token,
    pageNumber: 1,
    pageLimit: 50,
    totalCount: 0,
    totalPages: 0,
  };
  const ok = transportFor([empty]);
  await expect(
    createZetarisDataSource({ transport: ok.transport }).query({ sql: "SELECT 1" }),
  ).resolves.toEqual([]);
  for (const invalid of [
    { ...empty, pageNumber: 2 },
    { ...empty, totalCount: 1, records: [{ id: 1 }] },
  ]) {
    const bad = transportFor([invalid]);
    await expect(
      createZetarisDataSource({ transport: bad.transport }).query({ sql: "SELECT 1" }),
    ).rejects.toThrow(/Invalid installed Zetaris SQL page/);
  }
});

it("closes after a failed page request without exposing the bearer in HTTP errors", async () => {
  const { transport, fetchImpl } = transportFor([page(1)]);
  fetchImpl
    .mockImplementationOnce(async () => Response.json(page(1)))
    .mockImplementationOnce(async () => new Response("private-test-token", { status: 500 }));
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "Zetaris GET query request failed (500: server error).",
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it.each([
  { pages: [page(1, 4), page(2, 4), page(3, 4)], error: /page limit/ },
  {
    pages: [{ ...page(1, 1), totalCount: 51, records: Array(51).fill({ id: 1 }) }],
    error: /row limit/,
  },
])("retains bounded reads and cleanup", async ({ pages, error }) => {
  const { transport, fetchImpl } = transportFor(pages);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    error,
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("requires explicit loopback opt-in and the installed methods, path and organization", () => {
  for (const override of [
    { allowLoopbackHttp: false },
    { orgId: undefined },
    { orgId: "org-1" },
    { pageMethod: "POST" },
    { closeUrl: profile.closeUrl.replace("/{queryToken}", "") },
  ]) {
    expect(() => createZetarisHttpTransport({ ...profile, ...override })).toThrow(/profile/);
  }
});

it.each([
  { ...page(1, 1), totalCount: 0 },
  { ...page(1, 1), pageNumber: 2 },
  { ...page(1, 1), pageNumber: 0 },
])("rejects contradictory metadata before it can become evidence", async (response) => {
  const { transport, fetchImpl } = transportFor([response]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "Invalid installed Zetaris SQL page",
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("rejects truncated results and closes the query rather than returning partial evidence", async () => {
  const { transport, fetchImpl } = transportFor([{ ...page(1, 1), totalCount: 2 }]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "row count does not match",
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("rejects a total that changes between pages", async () => {
  const { transport, fetchImpl } = transportFor([page(1, 2), { ...page(2, 2), totalCount: 3 }]);
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "Invalid Zetaris query page",
  );
  expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
});

it("preserves the read failure when cleanup also fails and excludes error bodies", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(Response.json(page(1)))
    .mockResolvedValueOnce(new Response("private-test-token", { status: 401 }))
    .mockRejectedValueOnce(Error("private-close-token"));
  const transport = createZetarisHttpTransport({ ...profile, fetchImpl });
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "Zetaris GET query request failed (401: unauthorized). Query cleanup also failed.",
  );
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("sanitizes network failures and can execute a later independent read", async () => {
  const fetchImpl = vi
    .fn()
    .mockRejectedValueOnce(Error("private-test-token at private endpoint"))
    .mockResolvedValueOnce(Response.json(page(1, 1)))
    .mockResolvedValueOnce(new Response(null));
  const source = createZetarisDataSource({
    transport: createZetarisHttpTransport({ ...profile, fetchImpl }),
  });
  await expect(source.query({ sql: "SELECT 1" })).rejects.toThrow(
    "Zetaris POST query request failed (network).",
  );
  await expect(source.query({ sql: "SELECT 1" })).resolves.toEqual([{ id: 1 }]);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("reports a page timeout, closes the original query, and never returns partial rows", async () => {
  const signal = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValueOnce(new AbortController().signal)
    .mockReturnValueOnce(
      AbortSignal.abort(new DOMException("private timeout detail", "TimeoutError")),
    )
    .mockReturnValueOnce(new AbortController().signal);
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(Response.json(page(1, 2)))
    .mockImplementationOnce(async (_url: URL, options: RequestInit) => {
      options.signal?.throwIfAborted();
    })
    .mockResolvedValueOnce(new Response(null));
  try {
    const transport = createZetarisHttpTransport({ ...profile, fetchImpl });
    const result = createZetarisDataSource({ transport }).query({ sql: "SELECT 1" });
    await expect(result).rejects.toThrow("Zetaris GET query request timed out.");
    await expect(result).rejects.toMatchObject({
      queryDiagnostics: {
        stage: "page",
        timeoutMs: 10000,
        elapsedMs: expect.any(Number),
        tokenAcquired: true,
        cleanup: "succeeded",
        outcome: "timeout",
      },
    });
    expect(fetchImpl.mock.calls.at(-1)?.[1].method).toBe("DELETE");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  } finally {
    signal.mockRestore();
  }
});

it("rejects invalid credentials before a query token is acquired", async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(new Response("private token details", { status: 401 }));
  const transport = createZetarisHttpTransport({ ...profile, fetchImpl });
  await expect(createZetarisDataSource({ transport }).query({ sql: "SELECT 1" })).rejects.toThrow(
    "Zetaris POST query request failed (401: unauthorized).",
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
