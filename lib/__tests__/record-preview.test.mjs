import { expect, it } from "vitest";
import { ANALYTICS_TEMPLATES } from "../server/composer-data.mjs";
import {
  approvedTemplates,
  previewCount,
  queryForGoal,
  validateApprovedQuery,
} from "../server/approved-data.mjs";
import {
  dataIntent,
  interpretation,
  PREVIEW_CLARIFICATION,
  routeGoal,
  validateInterpretation,
} from "../server/task-intent.mjs";
import { selectParticipants } from "../server/office-group-chat.mjs";

const zones = {
  dataset: "NY_TAXI",
  operation: "record-preview",
  table: "zones",
  fields: ["zone_id", "zone_name"],
  limit: 5,
};

it("reads the requested record count from words or digits", () => {
  expect(previewCount("Summarize five records from NY_TAXI zones")).toBe(5);
  expect(previewCount("show 12 rows of TPCDS_DB item")).toBe(12);
  expect(previewCount("Top 5 pickup zones by trip count")).toBe(null);
});

it("accepts only an allowlisted table, its exact approved columns and a small limit", () => {
  expect(validateApprovedQuery(zones)).toEqual(zones);
  const rejects = [
    [{ ...zones, table: "drivers" }, /Unapproved table/],
    [{ ...zones, fields: ["zone_name", "zone_id"] }, /exactly the table's approved columns/],
    [
      { ...zones, fields: ["zone_id", "zone_name", "fare"] },
      /exactly the table's approved columns/,
    ],
    [{ ...zones, limit: 21 }, /between 1 and 20/],
    [{ ...zones, limit: 0 }, /between 1 and 20/],
    [{ ...zones, startHour: 22 }, /no time scope/],
    [{ ...zones, sql: "DROP TABLE x" }, /SQL and arbitrary identifiers/],
    [{ ...zones, dataset: "OTHER" }, /Unknown or unapproved dataset/],
  ];
  for (const [plan, error] of rejects) expect(() => validateApprovedQuery(plan)).toThrow(error);
  // A non-preview operation cannot smuggle a table name.
  expect(() =>
    validateApprovedQuery({
      dataset: "TPCDS_DB",
      operation: "category-return-rate",
      fields: ["category", "sold", "returned", "return_rate"],
      limit: 5,
      table: "item",
    }),
  ).toThrow(/Only a record preview names a table/);
});

it("generates preview SQL only from approved metadata with stable ordering", () => {
  const template = approvedTemplates(zones, ANALYTICS_TEMPLATES)["record-preview"];
  expect(template).toMatchObject({
    sql: "SELECT zone_id, zone_name FROM NY_TAXI.zones ORDER BY zone_id, zone_name LIMIT 5",
    recordIdField: "zone_id",
    fields: ["zone_id", "zone_name"],
  });
  expect(queryForGoal("List 3 records from TPCDS_DB item", "retail_analytics")).toMatchObject({
    table: "item",
    fields: ["i_item_sk", "i_category_id", "i_category"],
    limit: 3,
  });
  expect(() => queryForGoal("Summarize five records from NY_TAXI", "taxi_analytics")).toThrow(
    /Name one approved NY_TAXI table to preview: trips, zones/,
  );
  expect(() => queryForGoal("Show 50 records from NY_TAXI zones", "taxi_analytics")).toThrow(
    /between 1 and 20/,
  );
});

it("asks which dataset when a record preview names none, and never drafts an answer instead", () => {
  const goal = "Query a permitted Zetaris dataset and summarize five records.";
  const route = routeGoal(goal);
  expect(route.clarification).toBe(PREVIEW_CLARIFICATION);
  expect(dataIntent(goal)).toEqual({ kind: "data_request", goal });
  // A classifier that tries to turn it into a general draft is overruled.
  const general = validateInterpretation(interpretation("general", 0.9), goal);
  expect(general.clarification).toBe(PREVIEW_CLARIFICATION);
  expect(general.confidence).toBeLessThanOrEqual(0.5);
  // Ordinary requests are untouched.
  expect(dataIntent("Plan an office demo")).toBe(null);
  expect(routeGoal("Plan an office demo").clarification).toBe(null);
});

it("has the office lead answer, joined by at most two relevant teammates", () => {
  const seat = (seatId, roleTitle) => ({ seatId, label: seatId, roleTitle });
  const office = [
    seat("plan", "Nightshift Planner"),
    seat("analyze", "Nightshift Analyst"),
    seat("review", "Nightshift Critic"),
    seat("seat-0", "Worker"),
    seat("seat-4", "OpenClaw Researcher"),
  ];
  const ids = (message) => selectParticipants(office, message, "seat-0").map((s) => s.seatId);
  expect(ids("hi")).toEqual(["seat-0"]);
  expect(ids("Tell me a joke")).toEqual(["seat-0"]);
  expect(ids("Analyze the trend and check the risks")).toEqual(["seat-0", "analyze", "review"]);
  expect(ids("Plan the launch, analyze data, review risks, research sources")).toHaveLength(3);
  // Without a lead seat the first available agent leads.
  expect(selectParticipants(office, "hi", "missing").map((s) => s.seatId)).toEqual(["plan"]);
  expect(selectParticipants([], "hi", "seat-0")).toEqual([]);
});
