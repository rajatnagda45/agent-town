import { sqlFingerprint } from "./zetaris-deadlines.mjs";
/** Query lifecycle follows Zetaris OpenSqlQuery -> PageSqlQuery -> CloseSqlQuery.
 * The HTTP request/response mapping is instance-specific and supplied by the integration owner.
 */
export const MAX_ZETARIS_RESPONSE_BYTES = 2_000_000;

async function readBoundedJson(response) {
  if (!response.body) throw new Error("Zetaris query response has no body.");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid Zetaris response stream.");
      bytes += value.byteLength;
      if (bytes > MAX_ZETARIS_RESPONSE_BYTES)
        throw new Error("Zetaris query response is too large.");
      chunks.push(value);
    }
    const data = Buffer.concat(chunks, bytes);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
      throw new Error("Zetaris query response is not JSON.");
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createZetarisDataSource({ transport, pageLimit = 50, maxPages = 3 }) {
  if (
    !transport ||
    !["open", "page", "close"].every((method) => typeof transport[method] === "function") ||
    !Number.isSafeInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > 100 ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 10
  )
    throw new Error("Invalid Zetaris read-only transport configuration.");
  return {
    describeQuery: (sql) => transport.describeQuery?.(sql),
    async query({
      sql,
      onDiagnostics = /** @type {((value: any) => void) | undefined} */ (undefined),
    }) {
      const lifecycle = {
        sqlFingerprint: sqlFingerprint(sql),
        outcome: "success",
        cleanup: "pending",
      };
      let token;
      let result;
      let failure;
      try {
        result = await transport.open({ select: sql, pageLimit });
        token = result?.queryToken;
        Object.assign(
          lifecycle,
          result?.diagnostics
            ? {
                openElapsedMs: result.diagnostics.elapsedMs,
                openDeadline: result.diagnostics.deadline,
                requestId: result.diagnostics.requestId,
                origin: result.diagnostics.origin,
              }
            : {},
        );
        if (
          typeof token !== "string" ||
          !token ||
          !Array.isArray(result.records) ||
          typeof result.hasMore !== "boolean"
        )
          throw new Error("Invalid Zetaris query response.");
        if (result.records.length > pageLimit)
          throw new Error("Zetaris page exceeds its row limit.");
        const expectedTotal = result.totalCount;
        const rows = [...result.records];
        let pages = 1;
        while (result.hasMore && pages < maxPages && rows.length < 100) {
          result = await transport.page({
            queryToken: token,
            pageLimit,
            pageNumber: Number.isSafeInteger(result.pageNumber) ? result.pageNumber + 1 : pages + 1,
          });
          if (
            !Array.isArray(result?.records) ||
            result.queryToken !== token ||
            typeof result.hasMore !== "boolean" ||
            (expectedTotal !== undefined && result.totalCount !== expectedTotal)
          )
            throw new Error("Invalid Zetaris query page.");
          if (result.records.length > pageLimit)
            throw new Error("Zetaris page exceeds its row limit.");
          rows.push(...result.records);
          pages++;
        }
        if (result.hasMore) throw new Error("Zetaris result exceeds the configured page limit.");
        if (rows.length > 100) throw new Error("Zetaris result exceeds the evidence row limit.");
        if (expectedTotal !== undefined && rows.length !== expectedTotal)
          throw new Error("Zetaris result row count does not match the declared total.");
        return rows;
      } catch (error) {
        failure = error;
        error.queryDiagnostics = {
          ...error.queryDiagnostics,
          tokenAcquired: !!token,
          cleanup: token ? "pending" : "not_possible_without_token",
        };
        throw error;
      } finally {
        if (token) {
          try {
            await transport.close({ queryToken: token });
            if (failure) failure.queryDiagnostics.cleanup = "succeeded";
            lifecycle.cleanup = "succeeded";
          } catch (cleanupError) {
            throw Object.assign(
              new Error(
                failure instanceof Error
                  ? `${failure.message} Query cleanup also failed.`
                  : "Zetaris query cleanup failed.",
              ),
              {
                serviceId: "zetaris",
                queryDiagnostics: {
                  ...(failure?.queryDiagnostics ?? cleanupError?.queryDiagnostics),
                  tokenAcquired: true,
                  cleanup: "failed",
                },
                serviceStatus:
                  failure?.serviceStatus ?? cleanupError?.serviceStatus ?? "unverified",
              },
            );
          }
        }
        if (!failure && lifecycle.cleanup === "succeeded")
          onDiagnostics?.({ ...lifecycle, sql, finishedAt: new Date().toISOString() });
      }
    },
  };
}

/** The instance profile supplies exact SQL endpoints and response mapping from its OpenAPI spec. */
export function createZetarisHttpTransport({
  profile = "custom",
  openUrl,
  pageUrl,
  closeUrl,
  pageMethod,
  closeMethod,
  bearerToken,
  orgId = /** @type {string | undefined} */ (undefined),
  parsePage = /** @type {((response: any) => any) | undefined} */ (undefined),
  fetchImpl = fetch,
  timeoutMs = 10000,
  openDeadline = undefined,
  pageTimeoutMs = timeoutMs,
  cleanupTimeoutMs = timeoutMs,
  allowLoopbackHttp = false,
}) {
  const installed = profile === "installed-sql-v1";
  const urls = [openUrl, pageUrl, closeUrl].map((value) => new URL(value));
  const localHttp =
    allowLoopbackHttp &&
    urls[0].protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(urls[0].hostname);
  if (
    urls.some(
      (url) =>
        (url.protocol !== "https:" && !localHttp) ||
        url.origin !== urls[0].origin ||
        url.username ||
        url.password ||
        url.hash,
    ) ||
    !["GET", "POST"].includes(pageMethod) ||
    !["POST", "DELETE"].includes(closeMethod) ||
    typeof bearerToken !== "string" ||
    !bearerToken ||
    !["custom", "installed-sql-v1"].includes(profile) ||
    (!installed && typeof parsePage !== "function") ||
    (installed &&
      (parsePage !== undefined ||
        pageMethod !== "GET" ||
        closeMethod !== "DELETE" ||
        !/^-?\d+$/.test(orgId ?? "") ||
        urls[0].pathname !== "/api/v1.0/query/sql/start" ||
        urls[1].pathname !== "/api/v1.0/query/sql/page" ||
        urls[2].pathname !== "/api/v1.0/query/sql/close/%7BqueryToken%7D" ||
        urls.some((url) => url.search))) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000 ||
    ![pageTimeoutMs, cleanupTimeoutMs].every(
      (value) => Number.isSafeInteger(value) && value >= 100 && value <= 30000,
    ) ||
    (openDeadline !== undefined && typeof openDeadline !== "function")
  )
    throw new Error("Invalid Zetaris HTTP profile.");
  const request = async (url, method, payload, expectPage, expectedPage = undefined) => {
    const stage = !expectPage
      ? "close"
      : method === "POST" && payload?.select !== undefined
        ? "open"
        : "page";
    const deadline =
      stage === "open"
        ? (openDeadline?.(payload.select) ?? { timeoutMs })
        : { timeoutMs: stage === "page" ? pageTimeoutMs : cleanupTimeoutMs };
    const budget = deadline.timeoutMs;
    if (
      !Number.isSafeInteger(budget) ||
      budget < 100 ||
      budget > (stage === "open" ? 300000 : 30000)
    )
      throw new Error("Invalid Zetaris stage deadline.");
    const started = performance.now();
    const requestId = crypto.randomUUID();
    const diagnostics = () => ({
      requestId,
      stage,
      deadline,
      origin: urls[0].origin,
      method,
      timeoutMs: budget,
      elapsedMs: Math.round(performance.now() - started),
    });
    const headers = {
      Authorization: `Bearer ${bearerToken}`,
      "X-Request-ID": requestId,
      ...(orgId ? { "X-Org-ID": orgId } : {}),
      ...(payload ? { "Content-Type": "application/json" } : {}),
    };
    const signal = AbortSignal.timeout(budget);
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        method,
        headers,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal,
      });
    } catch {
      // Fetch implementations can include endpoint or credential data in errors.
      throw Object.assign(
        new Error(
          signal.aborted
            ? `Zetaris ${method} query request timed out.`
            : `Zetaris ${method} query request failed (network).`,
        ),
        {
          serviceId: "zetaris",
          serviceStatus: signal.aborted ? "unverified" : "unreachable",
          queryDiagnostics: {
            ...diagnostics(),
            outcome: signal.aborted ? "timeout" : "network_error",
          },
        },
      );
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          `Zetaris ${method} query request failed (${response.status}: ${
            response.status === 401 || response.status === 403
              ? "unauthorized"
              : response.status === 400 || response.status === 422
                ? "invalid query"
                : response.status >= 500
                  ? "server error"
                  : "rejected"
          }).`,
        ),
        {
          serviceId: "zetaris",
          queryDiagnostics: {
            ...diagnostics(),
            outcome: "http_error",
            httpStatus: response.status,
          },
          ...(response.status === 401 || response.status === 403
            ? { serviceStatus: "unauthorized" }
            : {}),
        },
      );
    if (!expectPage) return;
    let decoded;
    try {
      decoded = await readBoundedJson(response);
    } catch (error) {
      if (signal.aborted)
        throw Object.assign(new Error(`Zetaris ${method} query response read timed out.`), {
          serviceId: "zetaris",
          serviceStatus: "unverified",
          queryDiagnostics: { ...diagnostics(), outcome: "timeout" },
        });
      throw error;
    }
    try {
      if (!installed) return parsePage(decoded);
      if (
        typeof decoded?.queryToken !== "string" ||
        !decoded.queryToken ||
        !(
          Array.isArray(decoded.records) ||
          (decoded.records === undefined && decoded.totalCount === 0)
        ) ||
        !Number.isSafeInteger(decoded.pageNumber) ||
        decoded.pageNumber < 0 ||
        !Number.isSafeInteger(decoded.totalPages) ||
        decoded.totalPages < 0 ||
        !Number.isSafeInteger(decoded.totalCount) ||
        decoded.totalCount < 0 ||
        // Observed live: an empty result is page 1 of 0 pages with no records.
        (decoded.pageNumber > decoded.totalPages &&
          !(
            decoded.totalCount === 0 &&
            decoded.totalPages === 0 &&
            decoded.pageNumber === 1 &&
            (decoded.records?.length ?? 0) === 0
          )) ||
        (decoded.records?.length ?? 0) > decoded.totalCount ||
        (decoded.totalCount > 0 && (decoded.pageNumber < 1 || decoded.totalPages < 1)) ||
        (method === "POST" && decoded.pageLimit !== payload.pageLimit) ||
        (expectedPage !== undefined && decoded.pageNumber !== expectedPage)
      )
        throw new Error("Invalid installed Zetaris SQL page.");
      return {
        // records is optional in OpenSqlResponse/PageSqlResponse; only an empty result may omit it.
        diagnostics: diagnostics(),
        records: decoded.records ?? [],
        queryToken: decoded.queryToken,
        pageNumber: decoded.pageNumber,
        totalCount: decoded.totalCount,
        hasMore: decoded.pageNumber < decoded.totalPages,
      };
    } catch (error) {
      // The caller cannot own the token until open returns. Clean up validation failures here.
      if (
        installed &&
        method === "POST" &&
        typeof decoded?.queryToken === "string" &&
        decoded.queryToken
      )
        try {
          await close({ queryToken: decoded.queryToken });
        } catch {
          throw new Error("Invalid installed Zetaris SQL page. Query cleanup also failed.");
        }
      throw error;
    }
  };
  const tokenUrl = (base, queryToken) => {
    const url = new URL(base);
    url.searchParams.set("queryToken", queryToken);
    return url;
  };
  const close = ({ queryToken }) =>
    request(
      installed
        ? new URL(urls[2].href.replace("%7BqueryToken%7D", encodeURIComponent(queryToken)))
        : tokenUrl(urls[2], queryToken),
      closeMethod,
      closeMethod === "POST" ? { queryToken } : undefined,
      false,
    );
  return {
    describeQuery: (sql) => ({
      sqlFingerprint: sqlFingerprint(sql),
      openDeadline: openDeadline?.(sql) ?? { timeoutMs },
      pageTimeoutMs,
      cleanupTimeoutMs,
    }),
    open: ({ select, pageLimit }) => request(urls[0], "POST", { select, pageLimit }, true),
    page: ({ queryToken, pageLimit, pageNumber }) => {
      const url = tokenUrl(urls[1], queryToken);
      if (installed) {
        url.searchParams.set("pageLimit", String(pageLimit));
        url.searchParams.set("pageNumber", String(pageNumber));
      }
      return request(
        url,
        pageMethod,
        pageMethod === "POST" ? { queryToken, pageLimit } : undefined,
        true,
        installed ? pageNumber : undefined,
      );
    },
    close,
  };
}
