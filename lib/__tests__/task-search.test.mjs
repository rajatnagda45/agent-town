import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskSearch, ftsQuery } from "../server/task-search.mjs";

const cleanup = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));
function store() {
  const db = new TaskDatabase(":memory:");
  cleanup.push(() => db.close());
  const save = (id, gatewayId, patch) =>
    db.saveRecord(
      "composer.task",
      id,
      { gatewayId, input: { goal: "" }, updatedAt: new Date().toISOString(), ...patch },
      db.record("composer.task", id)?.revision ?? 0,
    );
  return { db, save, search: new TaskSearch(db) };
}

it("ranks past tasks by goal, report and source titles, scoped to the gateway", () => {
  const { save, search } = store();
  save("t1", "g1", {
    status: "completed",
    input: { goal: "Find the Grundfos CR 10 pump manual" },
    report: { summary: "Inspect the shaft seal every 3000 hours." },
    evidence: [{ source: "web:tavily", content: JSON.stringify({ title: "CR 10 manual" }) }],
  });
  save("t2", "g1", { status: "completed", input: { goal: "Create a 30-minute demo agenda" } });
  save("t3", "other", { input: { goal: "pump manual for another office" } });
  const results = search.search({ query: "pump shaft seal", gatewayId: "g1" });
  expect(results.map((r) => r.taskId)).toEqual(["t1"]);
  expect(results[0]).toMatchObject({ status: "completed", link: "/work/t1" });
  expect(search.search({ query: "manual", gatewayId: "g1" }).map((r) => r.taskId)).toEqual(["t1"]);
});

it("re-indexes changed records incrementally and never lets user text become FTS syntax", () => {
  const { save, search } = store();
  save("t1", "g1", { input: { goal: "Draft agenda" }, updatedAt: "2026-01-01T00:00:00Z" });
  expect(search.search({ query: "agenda", gatewayId: "g1" })).toHaveLength(1);
  expect(search.refresh()).toBe(0);
  save("t1", "g1", { input: { goal: "Draft release report" }, updatedAt: "2026-01-02T00:00:00Z" });
  expect(search.search({ query: "agenda", gatewayId: "g1" })).toHaveLength(0);
  expect(search.search({ query: "release", gatewayId: "g1" })).toHaveLength(1);
  expect(ftsQuery('agenda" OR task_id:* NEAR(')).toBe('"agenda" "or" "task" "id" "near"');
  expect(search.search({ query: '") OR 1=1 --', gatewayId: "g1" })).toEqual([]);
  expect(search.search({ query: "", gatewayId: "g1" })).toEqual([]);
});
