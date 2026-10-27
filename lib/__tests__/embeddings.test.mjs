import { expect, it } from "vitest";
import { cosine, createEmbedder, loadEmbedder } from "../server/embeddings.mjs";

it("computes cosine similarity and rejects mismatched vectors", () => {
  expect(cosine([1, 0], [1, 0])).toBe(1);
  expect(cosine([1, 0], [0, 1])).toBe(0);
  expect(cosine([1, 0], [1, 0, 0])).toBe(0);
});

it("stays lexical when unconfigured and verifies an endpoint before use", async () => {
  expect(loadEmbedder({})).toBeNull();
  expect(() => loadEmbedder({ AGENT_TOWN_EMBEDDINGS_URL: "http://x" })).toThrow(/MODEL/);
  const ok = createEmbedder({
    url: "http://local/v1/",
    model: "m",
    fetchImpl: async (url) => {
      expect(url).toBe("http://local/v1/embeddings");
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    },
  });
  expect(await ok.verify()).toBe(true);
  const down = createEmbedder({
    url: "http://local/v1",
    model: "m",
    fetchImpl: async () => new Response("no", { status: 503 }),
  });
  expect(await down.verify()).toBe(false);
  expect(down.status).toContain("HTTP 503");
});
