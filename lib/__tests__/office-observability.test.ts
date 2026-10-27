import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../server/task-db.mjs";
import { OperationRecords } from "../server/operation-records.mjs";
import { officeOverview } from "../server/office-observability.mjs";
import { createRuntimeHandler } from "../server/runtime-api.mjs";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

it("serves a bounded office overview without raw evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-office-overview-"));
  directories.push(directory);
  const db = new TaskDatabase(join(directory, "tasks.sqlite"));
  try {
    const records = new OperationRecords(db);
    records.put("incident", {
      incidentId: "incident-1",
      goal: "Restore pressure",
      constraints: [],
      taskType: "maintenance",
      acceptanceCriteria: [{ criterionId: "pressure", description: "Confirm normal pressure" }],
      createdAt: "2026-10-25T00:00:00Z",
    });
    records.put("task", {
      taskId: "task-1",
      incidentId: "incident-1",
      requester: { kind: "user" },
      role: "Data Steward",
      dependencies: [],
      status: "queued",
      retryCount: 2,
      assignment: {
        runtimeTaskId: "task-1",
        seatId: "lead",
        agentId: "main",
        bindingRevision: 1,
        gatewayId: "gateway-1",
        sessionKey: "agent:main:main",
      },
    });
    records.put("evidenceItem", {
      evidenceId: "evidence-1",
      incidentId: "incident-1",
      taskId: "task-1",
      source: "https://example.test/log?token=secret-source-token",
      recordId: "secret-record-id",
      sourceTimestamp: null,
      retrievedAt: "2026-10-25T00:01:00Z",
      freshUntil: "2026-10-26T00:00:00Z",
      content: "secret pump reading",
    });
    records.put("verificationResult", {
      verificationId: "verification-1",
      incidentId: "incident-1",
      taskId: "task-1",
      verdict: "unresolved",
      evidenceIds: ["evidence-1"],
      reason: "Pressure reading conflicts with secret-verifier-token",
      checkedAt: "2026-10-25T00:02:00Z",
    });
    const overview = officeOverview({ db });
    expect(overview.operationTasks).toMatchObject([{ taskId: "task-1", retryCount: 2 }]);
    expect(overview.evidence).toMatchObject([
      { evidenceId: "evidence-1", source: "Recorded source" },
    ]);
    expect(overview.verification).toMatchObject([{ verdict: "unresolved", taskId: "task-1" }]);
    expect(
      overview.events.some((event: { kind: string }) => event.kind === "operation.evidence"),
    ).toBe(true);
    expect(JSON.stringify(overview)).not.toContain("secret pump reading");
    expect(JSON.stringify(overview)).not.toContain("secret-source-token");
    expect(JSON.stringify(overview)).not.toContain("secret-record-id");
    expect(JSON.stringify(overview)).not.toContain("secret-verifier-token");
    expect(overview.events.length).toBeLessThanOrEqual(80);
    let status = 0;
    let response = "";
    await createRuntimeHandler({ db })(
      {
        url: "/api/runtime/office-overview",
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      },
      {
        writeHead(code: number) {
          status = code;
        },
        end(body: string) {
          response = body;
        },
      },
    );
    expect(status).toBe(200);
    expect(JSON.parse(response).verification[0].verdict).toBe("unresolved");
    expect(response).not.toContain("secret pump reading");
    let forbidden = 0;
    await createRuntimeHandler({ db })(
      {
        url: "/api/runtime/office-overview",
        method: "GET",
        headers: {
          host: "127.0.0.1:3000",
          origin: "https://other.example",
          "sec-fetch-site": "cross-site",
        },
      },
      {
        writeHead(code: number) {
          forbidden = code;
        },
        end() {},
      },
    );
    expect(forbidden).toBe(403);
  } finally {
    db.close();
  }
});

it("shows retry attempts from the current orchestration plan", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-office-retries-"));
  directories.push(directory);
  const db = new TaskDatabase(join(directory, "tasks.sqlite"));
  try {
    const plan = {
      incident: { incidentId: "incident-2" },
      revision: 2,
      children: [
        {
          phase: "running",
          attempts: [{}, {}, {}],
          operation: {
            taskId: "attempt-3",
            role: "Inventory Investigator",
            status: "running",
            assignment: { seatId: "specialist" },
          },
        },
      ],
    };
    const overview = officeOverview({
      db,
      orchestration: {
        all: () => [plan],
        list: () => [
          { incidentId: "incident-2", goal: "Reconcile stock", status: "running", childCount: 1 },
        ],
      },
    });
    expect(overview.operationTasks).toMatchObject([{ taskId: "attempt-3", retryCount: 2 }]);
    expect(overview.plans).toMatchObject([{ planId: "incident-2", steps: 1 }]);
  } finally {
    db.close();
  }
});

it("shows only the latest 80 reference-only events", () => {
  const db = new TaskDatabase(":memory:");
  try {
    for (let index = 0; index < 110; index++)
      db.saveRecord("fixture.activity", `event-${index}`, {
        status: "recorded",
        content: "secret payload",
      });
    const overview = officeOverview({ db });
    expect(overview.events).toHaveLength(80);
    expect(overview.events[0].seq).toBeGreaterThan(overview.events[79].seq);
    expect(JSON.stringify(overview)).not.toContain("secret payload");
  } finally {
    db.close();
  }
});

it("shows a Critic verdict persisted on the orchestration plan once", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-office-verdict-"));
  directories.push(directory);
  const db = new TaskDatabase(join(directory, "tasks.sqlite"));
  try {
    const verdict = {
      verificationId: "critic-1",
      incidentId: "incident-3",
      taskId: "attempt-2",
      verdict: "revise" as const,
      reason: "The cause is not supported by the pump log.",
      evidenceIds: ["pump-log"],
      checkedAt: "2026-10-25T01:00:00Z",
    };
    const plan = {
      incident: { incidentId: "incident-3" },
      revision: 3,
      verification: verdict,
      children: [
        {
          phase: "completed",
          attempts: [{ runtimeTaskId: "attempt-1" }, { runtimeTaskId: "attempt-2" }],
          operation: { taskId: "attempt-2", role: "Analyst", status: "completed" },
        },
      ],
    };
    const runtime = {
      db,
      orchestration: {
        all: () => [plan],
        list: () => [{ incidentId: "incident-3", status: "awaiting_verification", childCount: 1 }],
      },
    };
    const overview = officeOverview(runtime);
    expect(overview.verification).toMatchObject([
      { verificationId: "critic-1", taskId: "attempt-2", verdict: "revise" },
    ]);
    new OperationRecords(db).put("verificationResult", verdict);
    expect(officeOverview(runtime).verification).toHaveLength(1);
    expect(overview.plans).toMatchObject([{ status: "awaiting_verification" }]);
    expect(overview.operationTasks).toMatchObject([{ taskId: "attempt-2", retryCount: 1 }]);
  } finally {
    db.close();
  }
});
