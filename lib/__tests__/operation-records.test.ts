import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { OperationRecords } from "../server/operation-records.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("migrates a v1 database and preserves legacy tasks and evidence without freshUntil", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-operations-"));
  temporary.push(directory);
  const filename = join(directory, "tasks.sqlite");
  const v1 = new DatabaseSync(filename);
  v1.exec(`CREATE TABLE migrations(version INTEGER PRIMARY KEY);
    INSERT INTO migrations VALUES (1);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, gateway TEXT NOT NULL, session TEXT NOT NULL,
      status TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);`);
  const legacyTask = {
    taskId: "legacy-task",
    gatewayId: "gateway-1",
    sessionKey: "agent:main:main",
    status: "completed",
    createdAt: "2026-10-25T00:00:00.000Z",
    message: "Original task",
  };
  v1.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)").run(
    legacyTask.taskId,
    legacyTask.gatewayId,
    legacyTask.sessionKey,
    legacyTask.status,
    legacyTask.createdAt,
    JSON.stringify(legacyTask),
  );
  v1.close();

  const db = new TaskDatabase(filename);
  expect(db.getTask(legacyTask.taskId)).toEqual(legacyTask);
  expect(db.db.prepare("SELECT version FROM migrations ORDER BY version").all()).toEqual([
    { version: 1 },
    { version: 2 },
  ]);
  const store = new OperationRecords(db);
  const olderEvidence = {
    evidenceId: "pump-log-1",
    incidentId: "incident-1",
    taskId: "legacy-task",
    source: "zetaris:pump_logs",
    recordId: "log-42",
    sourceTimestamp: null,
    retrievedAt: "2026-10-25T00:01:00.000Z",
    content: "Pump stopped",
  };
  const saved = store.put("evidenceItem", olderEvidence);
  expect(saved).toMatchObject({ id: "pump-log-1", revision: 1, value: olderEvidence });
  expect(store.put("evidenceItem", olderEvidence)).toEqual(saved);
  expect(db.replay(0).filter((event) => event.kind === "operation.evidence")).toHaveLength(1);
  expect(db.replay(0).find((event) => event.kind === "operation.evidence")?.data).toEqual({
    id: "pump-log-1",
    revision: 1,
    incidentId: "incident-1",
    taskId: "legacy-task",
  });
  expect(JSON.stringify(db.replay(0))).not.toContain("Pump stopped");
  const artifact = {
    artifactId: "report-1",
    incidentId: "incident-1",
    taskId: "legacy-task",
    mediaType: "text/plain",
    uri: "artifact:report-1",
    sha256: "a".repeat(64),
    description: "Pump inspection summary",
    createdAt: "2026-10-25T00:02:00.000Z",
  };
  store.put("artifact", artifact);
  const from = {
    seatId: "Alice",
    agentId: "alice",
    bindingRevision: 1,
    gatewayId: "gateway-1",
    sessionKey: "agent:alice:main",
  };
  const handoff = {
    handoffId: "handoff-1",
    incidentId: "incident-1",
    fromTaskId: "legacy-task",
    toTaskId: "child-task",
    from,
    to: { ...from, seatId: "Bob", agentId: "bob", sessionKey: "agent:bob:main" },
    summary: "Reconcile the pump log",
    evidenceIds: [olderEvidence.evidenceId],
    artifactIds: [artifact.artifactId],
    status: "proposed" as const,
    createdAt: "2026-10-25T00:03:00.000Z",
  };
  store.put("handoff", handoff);
  db.close();

  const reopened = new TaskDatabase(filename);
  try {
    const records = new OperationRecords(reopened);
    expect(reopened.getTask(legacyTask.taskId)).toEqual(legacyTask);
    expect(records.get("evidenceItem", olderEvidence.evidenceId)?.value).toEqual(olderEvidence);
    expect(records.list("evidenceItem")).toHaveLength(1);
    expect(records.get("artifact", artifact.artifactId)?.value).toEqual(artifact);
    expect(records.get("handoff", handoff.handoffId)?.value).toEqual(handoff);
    const updated = records.put(
      "evidenceItem",
      { ...olderEvidence, freshUntil: "2026-10-26T00:01:00.000Z" },
      1,
    );
    expect(updated).toMatchObject({
      revision: 2,
      value: { freshUntil: "2026-10-26T00:01:00.000Z" },
    });
    expect(() => records.put("evidenceItem", { ...olderEvidence, content: "Changed" })).toThrow();
    expect(() =>
      records.put("evidenceItem", { ...olderEvidence, content: "Changed" }, 1),
    ).toThrow();
  } finally {
    reopened.close();
  }
});
