import { createHash } from "node:crypto";

// Search request pattern adapted from harishkotra/agent-office ToolExecutor.webSearchTavily (MIT).
// Unlike that tool, result URLs are kept as source-linked evidence and there is no fallback
// provider: a source without a citable URL cannot support a research claim.
const TAVILY_API = "https://api.tavily.com";
// Bounds keep a whole research bundle inside the specialist context limit (6500 characters)
// without silently dropping anything: each excerpt is a stated, reviewed retrieval limit.
const MAX_RESULTS = 4;
const MAX_EXTRACT_URLS = 2;
const EXTRACT_CHUNKS = 3;
const MAX_EXTRACT_CHARS = 500;
const MAX_SNIPPET_CHARS = 300;
const MAX_TITLE_CHARS = 120;
const FRESH_MS = 24 * 60 * 60 * 1000;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });

function httpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function timestamp(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Keyed access, or Tavily's documented rate-limited keyless mode for search and extract. */
export const webSearchConfigured = (env) =>
  !!env.TAVILY_API_KEY?.trim() || env.TAVILY_KEYLESS === "1";

/** Server-owned web search and extraction reader with the DataEvidenceService reader shape.
 * @param {{apiKey?: string, keyless?: boolean, fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number}} options */
export function createWebSearchReader({
  apiKey,
  keyless = false,
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = 15000,
}) {
  if (!apiKey && !keyless)
    throw fail(503, "Web search is not configured (TAVILY_API_KEY is not set).");
  const headers = apiKey
    ? { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }
    : { "Content-Type": "application/json", "X-Tavily-Access-Mode": "keyless" };

  async function post(path, body) {
    let response;
    try {
      response = await fetchImpl(`${TAVILY_API}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw Object.assign(fail(502, "Web search request failed or timed out."), {
        serviceId: "web-search",
        serviceStatus: "unreachable",
      });
    }
    if (response.status === 401 || response.status === 403)
      throw Object.assign(fail(502, "Web search credentials were rejected."), {
        serviceId: "web-search",
        serviceStatus: "unauthorized",
      });
    if (!response.ok) throw fail(502, `Web search returned HTTP ${response.status}.`);
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.results)) throw fail(502, "Web search returned an invalid response.");
    return data;
  }

  function evidenceItem(scope, source, url, sourceTimestamp, fields, retrieved) {
    const recordId = `url_${digest(url).slice(0, 40)}`;
    const content = JSON.stringify({ url, ...fields });
    return {
      evidenceId: `ev_${digest([scope.incidentId, scope.taskId, source, recordId, sourceTimestamp, content]).slice(0, 48)}`,
      incidentId: scope.incidentId,
      taskId: scope.taskId,
      source,
      recordId,
      sourceTimestamp,
      retrievedAt: new Date(retrieved).toISOString(),
      freshUntil: new Date(retrieved + FRESH_MS).toISOString(),
      content,
    };
  }

  return {
    serviceId: "web-search",
    async read({ templateId, parameters, scope }) {
      const query = typeof parameters?.query === "string" ? parameters.query.trim() : "";
      if (
        !["web-search", "web-extract"].includes(templateId) ||
        query.length < 3 ||
        query.length > 400
      )
        throw fail(400, "Web search needs a reviewed template and a 3–400 character query.");
      const seen = new Set();
      const evidence = [];
      if (templateId === "web-extract") {
        // URLs come from this server's own search results; extraction is query-focused chunks.
        const urls = Array.isArray(parameters.urls) ? parameters.urls.map(httpUrl) : [];
        if (!urls.length || urls.length > MAX_EXTRACT_URLS || urls.some((url) => !url))
          throw fail(400, `Web extraction needs 1–${MAX_EXTRACT_URLS} http(s) source URLs.`);
        const data = await post("/extract", {
          urls,
          query,
          chunks_per_source: EXTRACT_CHUNKS,
          extract_depth: "basic",
          format: "text",
        });
        const retrieved = now();
        for (const row of data.results.slice(0, MAX_EXTRACT_URLS)) {
          const url = httpUrl(row?.url);
          // Only URLs that were requested may come back as extracted sources.
          if (!url || !urls.includes(url) || seen.has(url) || typeof row.raw_content !== "string")
            continue;
          const text = row.raw_content.trim().slice(0, MAX_EXTRACT_CHARS);
          if (!text) continue;
          seen.add(url);
          const title = typeof row.title === "string" ? row.title.slice(0, MAX_TITLE_CHARS) : url;
          evidence.push(
            evidenceItem(scope, "web:tavily-extract", url, null, { title, text }, retrieved),
          );
        }
        return { evidence, scope, mode: "web" };
      }
      const data = await post("/search", {
        query,
        max_results: MAX_RESULTS,
        search_depth: "basic",
      });
      const retrieved = now();
      for (const row of data.results.slice(0, MAX_RESULTS)) {
        const url = httpUrl(row?.url);
        if (!url || seen.has(url) || typeof row.title !== "string") continue;
        seen.add(url);
        evidence.push(
          evidenceItem(
            scope,
            "web:tavily",
            url,
            timestamp(row.published_date),
            {
              title: row.title.slice(0, MAX_TITLE_CHARS),
              snippet:
                typeof row.content === "string" ? row.content.slice(0, MAX_SNIPPET_CHARS) : "",
            },
            retrieved,
          ),
        );
      }
      return { evidence, scope, mode: "web" };
    },
  };
}

/** Search result URLs to extract, in search rank order. */
export function extractionTargets(searchRead) {
  return (searchRead?.evidence ?? [])
    .filter((item) => item.source === "web:tavily")
    .map((item) => JSON.parse(item.content).url)
    .slice(0, MAX_EXTRACT_URLS);
}

/** Retrieval is checked, not the truth of third-party content. */
export function researchChecks(reads) {
  const evidence = Object.values(reads).flatMap((read) => read.evidence);
  if (!evidence.length)
    return { status: "unresolved", reason: "No citable web sources were returned for this goal." };
  const sources = new Map();
  for (const item of evidence) {
    const { url, title } = JSON.parse(item.content);
    const extracted = item.source === "web:tavily-extract";
    const existing = sources.get(url);
    if (existing) existing.extracted ||= extracted;
    else sources.set(url, { evidenceId: item.evidenceId, url, title, extracted });
  }
  const extractedCount = [...sources.values()].filter((source) => source.extracted).length;
  return {
    status: "checked",
    sources: [...sources.values()],
    description: `${sources.size} web sources retrieved by the server and cited${extractedCount ? `, ${extractedCount} with extracted source text` : ""}; their content is third-party and not independently verified.`,
  };
}
