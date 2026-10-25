// OpenAI-compatible embeddings client. Recall pattern adapted from harishkotra/agent-office
// MemoryStore cosine search (MIT). Embeddings only rank memories that already passed the
// scope, freshness and proof checks; they never widen what a seat may recall.

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / (Math.sqrt(left) * Math.sqrt(right)) : 0;
}

/** @param {{url: string, model: string, apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options */
export function createEmbedder({ url, model, apiKey, fetchImpl = fetch, timeoutMs = 10000 }) {
  const endpoint = `${url.replace(/\/+$/, "")}/embeddings`;
  const embedder = {
    model,
    verified: false,
    status: "unverified",
    async embed(text) {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: String(text).slice(0, 4000) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Embeddings returned HTTP ${response.status}.`);
      const vector = (await response.json())?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite))
        throw new Error("Embeddings returned an invalid vector.");
      return vector;
    },
    /** A probe embedding must succeed before any memory is ranked semantically. */
    async verify() {
      try {
        await embedder.embed("agent town memory probe");
        embedder.verified = true;
        embedder.status = "verified";
      } catch (error) {
        embedder.verified = false;
        embedder.status = `unavailable: ${error instanceof Error ? error.message : "error"}`;
      }
      return embedder.verified;
    },
  };
  return embedder;
}

/** Returns null when no endpoint is configured, which keeps recall lexical.
 * @param {Record<string, string | undefined>} env */
export function loadEmbedder(env, fetchImpl) {
  if (!env.AGENT_TOWN_EMBEDDINGS_URL) return null;
  if (!env.AGENT_TOWN_EMBEDDINGS_MODEL)
    throw new Error("AGENT_TOWN_EMBEDDINGS_MODEL is required with AGENT_TOWN_EMBEDDINGS_URL.");
  const keyEnv = env.AGENT_TOWN_EMBEDDINGS_KEY_ENV;
  if (keyEnv && !/^[A-Z][A-Z0-9_]{0,63}$/.test(keyEnv))
    throw new Error("Invalid AGENT_TOWN_EMBEDDINGS_KEY_ENV.");
  return createEmbedder({
    url: env.AGENT_TOWN_EMBEDDINGS_URL,
    model: env.AGENT_TOWN_EMBEDDINGS_MODEL,
    apiKey: keyEnv ? env[keyEnv] : undefined,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
