import { expect, it } from "vitest";
import {
  discoverApprovedData,
  validateApprovedQuery,
  queryForGoal,
  approvedTemplates,
} from "../server/approved-data.mjs";
import { ANALYTICS_TEMPLATES } from "../server/composer-data.mjs";

const goal = "Using NY_TAXI show top 5 pickup zones by trip count between 22:00 and 06:00.";
it("discovers only reviewed fields and compiles different bounded hour windows", () => {
  const schema = discoverApprovedData("NY_TAXI");
  expect(schema.datasets.NY_TAXI.timeFields).toEqual(["trips.pickup_datetime"]);
  expect(schema.limits).toMatchObject({
    rows: 100,
    timeoutPolicy: expect.stringContaining("separate open, page and cleanup"),
  });
  expect(schema.provenance).toContain("does not assert live");
  const plan = queryForGoal(goal, "taxi_analytics");
  expect(plan).toMatchObject({ limit: 5, startHour: 22, endHour: 6 });
  expect(approvedTemplates(plan, ANALYTICS_TEMPLATES)["taxi-night"].sql).toContain("LIMIT 5");
  const day = queryForGoal(goal.replace("22:00 and 06:00", "08:00 and 12:00"), "taxi_analytics");
  expect(approvedTemplates(day, ANALYTICS_TEMPLATES)["taxi-night"].sql).toContain(">= 8 AND");
});
it("blocks unknown datasets, fields, SQL, operations, excessive limits and ambiguous times", () => {
  const plan = queryForGoal(goal, "taxi_analytics");
  for (const changes of [
    { dataset: "secrets" },
    { fields: ["fare"] },
    { sql: "DELETE FROM trips" },
    { operation: "delete" },
    { limit: 101 },
    { limit: 0 },
    { timeField: "dropoff_datetime" },
    { startHour: 24 },
    { startHour: 6 },
  ])
    expect(() => validateApprovedQuery({ ...plan, ...changes })).toThrow();
  for (const text of [
    "NY_TAXI.secret nighttime zones",
    "NY_TAXI top zones today",
    "NY_TAXI zones between 22:30 and 06:00",
    "NY_TAXI zones by dropoff time",
  ])
    expect(() => queryForGoal(text, "taxi_analytics")).toThrow();
  expect(() =>
    queryForGoal("TPCDS_DB category return rates between dates", "retail_analytics"),
  ).toThrow(/time mapping/);
});
