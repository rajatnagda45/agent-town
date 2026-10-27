import { expect, it } from "vitest";
import { taskRecord, type ComposedTask } from "../task-record";

const task: ComposedTask = {
  id: "case-1",
  status: "unresolved",
  verdict: "UNCERTAIN",
  input: { goal: "Review stock" },
  route: {
    workflow: "inventory",
    dataSources: ["inventory"],
    risk: "read_only",
    confidence: 1,
    successCriteria: [],
    clarification: null,
  },
  evidence: [
    {
      evidenceId: "e1",
      source: "inventory",
      retrievedAt: "2026-10-27T00:00:00Z",
      content: "SYNTHETIC DATA private row",
    },
  ],
  attempts: [{ taskId: "a1", role: "analyst", stage: "analyzing", seatId: "seat-0" }],
  checks: [{ status: "failed", issues: ["Stale source"] }],
  actions: [{ kind: "mutation", status: "proposed", executed: false }],
};
it("retains unresolved evidence and unexecuted actions without manufacturing verification", () => {
  const record = taskRecord(task);
  expect(record).toMatchObject({ status: "unresolved", verdict: "UNCERTAIN", report: null });
  expect(record.actions[0].executed).toBe(false);
  expect(record.checks[0].issues).toEqual(["Stale source"]);
  expect(record.evidence[0]).toMatchObject({ evidenceId: "e1", synthetic: true });
  expect(JSON.stringify(record)).not.toContain("private row");
});
it("exports only explicit fields and preserves the scope of verification", () => {
  const input = {
    ...task,
    token: "private-token",
    report: {
      summary: "Calculation checked",
      verified: true,
      scope: "Supplied sample only",
      authorization: "private-token",
    },
  };
  const record = taskRecord(input);
  expect(record.report).toEqual({
    summary: "Calculation checked",
    verified: true,
    scope: "Supplied sample only",
  });
  expect(JSON.stringify(record)).not.toContain("private-token");
  expect(record.attempts[0].taskId).toBe("a1");
  expect(record.limitations.join(" ")).toContain("not an authenticity certificate");
});
