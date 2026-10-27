import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../__fixtures__/openclaw-2026.10.7.json";
import { ContractAudit, CONTRACTS } from "../server/contracts.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import { OperationRecords } from "../server/operation-records.mjs";
import { assignedOperationTask } from "../operations-contracts.mjs";
import { createDataReader } from "../server/data-source.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { EXAMPLE_DATA_TEMPLATES, SYNTHETIC_DATA_FIXTURES } from "../server/data-fixtures.mjs";
import { DataEvidenceService } from "../server/data-integration.mjs";
import { TrustedVerificationService } from "../server/trusted-verification.mjs";
import type { ReadTemplate } from "../server/data-source.mjs";
import type { VerificationResult } from "../operations-contracts.mjs";

const cleanups: Array<() => void> = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

class Gateway {
  provider = "openclaw";
  audit = new ContractAudit(fixture);
  status = "connected";
  hello = {
    server: { version: fixture.version },
    auth: { scopes: ["operator.admin", "operator.questions"] },
    features: { methods: Object.keys(CONTRACTS) },
  };
  subscribe() {
    return () => {};
  }
  capabilities() {
    return this.audit.capabilities(this.hello, true);
  }
  stop() {
    this.status = "disconnected";
  }
  request(method: string) {
    if (method === "agents.list")
      return Promise.resolve({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "bob" }],
      });
    if (method === "sessions.list") return Promise.resolve({ sessions: [] });
    if (method === "chat.history") return Promise.resolve({ messages: [], sessionInfo: {} });
    if (method === "chat.send") return new Promise(() => {});
    return Promise.resolve({ ok: true });
  }
}

describe("synthetic data to verified memory integration", () => {
  it("uses server task binding, persisted audit and verification; guards failures, staleness and retries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-data-memory-"));
    const db = new TaskDatabase(join(directory, "tasks.sqlite"));
    const runtime = new TaskRuntime({ db, gateway: new Gateway(), gatewayId: "gateway-1" });
    cleanups.push(() => {
      runtime.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await runtime.refresh();
    runtime.saveSeat({
      seatId: "lead",
      label: "Lead",
      assigned: true,
      seatType: "worker",
      revision: 0,
    });
    runtime.saveSeat({
      seatId: "data",
      label: "Data Steward",
      assigned: true,
      seatType: "agent",
      agentConfig: { agentId: "bob" },
      revision: 0,
    });
    const task = runtime.submit({
      taskId: "read-pump",
      seatId: "data",
      bindingRevision: 1,
      message: "Read pump pressure",
    });
    const verifierTask = runtime.submit({
      taskId: "verify-pump",
      seatId: "lead",
      bindingRevision: 1,
      message: "Verify pump pressure findings",
    });
    const records = new OperationRecords(db);
    records.put("incident", {
      incidentId: "pressure-incident",
      goal: "Explain low pressure",
      constraints: [],
      taskType: "investigation",
      acceptanceCriteria: [{ criterionId: "pressure", description: "Check pressure log" }],
      createdAt: "2026-10-25T08:00:00Z",
    });
    records.put(
      "task",
      assignedOperationTask({
        incidentId: "pressure-incident",
        requester: { kind: "user" },
        role: "Data Steward",
        task,
      }),
    );
    records.put(
      "task",
      assignedOperationTask({
        incidentId: "pressure-incident",
        requester: { kind: "user" },
        role: "Critic",
        task: verifierTask,
      }),
    );
    let now = Date.parse("2026-10-25T08:08:00Z");
    runtime.memory.clock = () => now;
    const templates: Record<string, ReadTemplate> = {
      "pump-pressure-readings": {
        ...EXAMPLE_DATA_TEMPLATES["pump-pressure-readings"],
        parameters: { buildingId: "text" },
      },
    };
    const reader = createDataReader({
      mode: "synthetic",
      templates,
      synthetic: createSyntheticDataSource(SYNTHETIC_DATA_FIXTURES),
      now: () => new Date(now),
    });
    const data = new DataEvidenceService(runtime, records, reader, { clock: () => new Date(now) });
    const verifier = new TrustedVerificationService(runtime, records, {
      clock: () => new Date(now),
    });
    const input = {
      incidentId: "pressure-incident",
      taskId: task.taskId,
      templateId: "pump-pressure-readings",
      parameters: { buildingId: "building-a" },
      scope: { agentId: "forged-agent", bindingRevision: 999 },
    };
    const first = await data.read(input);
    expect(first.scope).toMatchObject({ agentId: "bob", seatId: "data", bindingRevision: 1 });
    expect(first.evidence).toHaveLength(2);
    expect(first.evidence[0]).toMatchObject({
      incidentId: "pressure-incident",
      taskId: task.taskId,
      source: "synthetic:pump_pressure_readings",
      auditRef: first.auditRef,
    });
    expect(db.record("operation.dataRead", first.auditRef)).toMatchObject({
      incidentId: "pressure-incident",
      taskId: task.taskId,
    });
    db.saveRecord("orchestration", "pressure-incident", {
      status: "awaiting_verification",
      children: [
        {
          operation: { taskId: task.taskId },
          attempts: [{ runtimeTaskId: task.taskId }],
          evidenceIds: first.evidence.map((item: { evidenceId: string }) => item.evidenceId),
        },
        {
          operation: { taskId: verifierTask.taskId },
          attempts: [{ runtimeTaskId: verifierTask.taskId }],
          evidenceIds: [],
        },
      ],
    });
    const cursor = db.cursor();
    expect((await data.read(input)).evidence).toEqual(first.evidence);
    expect(db.cursor()).toBe(cursor);
    await expect(data.read({ ...input, incidentId: "wrong-incident" })).rejects.toThrow();
    expect(records.list("verificationResult")).toHaveLength(0);
    expect(runtime.memory.retrieve({ ...first.scope, query: "pump pressure" })).toEqual([]);

    db.updateTask(task.taskId, { status: "completed", result: "Log read" });
    db.updateTask(verifierTask.taskId, { status: "completed", result: "Findings checked" });
    const checkedAt = "2026-10-25T08:09:00Z";
    now = Date.parse("2026-10-25T08:10:00Z");
    const base = {
      incidentId: "pressure-incident",
      taskId: verifierTask.taskId,
      evidenceIds: first.evidence.map((item: { evidenceId: string }) => item.evidenceId),
      reason: "Pressure readings checked",
      checkedAt,
    };
    const lesson = {
      content: "Pump pressure fell when the pump stopped.",
      applicability: "pump pressure stopped",
    };
    const failed = verifier.record({
      verification: { ...base, verificationId: "v-revise", verdict: "revise" },
      lesson,
    });
    expect(failed.lesson).toBeNull();
    expect(runtime.memory.retrieve({ ...first.scope, query: "pump pressure" })).toEqual([]);
    now = Date.parse("2026-10-25T08:21:00Z");
    expect(() =>
      verifier.record({
        verification: { ...base, verificationId: "v-stale", verdict: "pass" },
        lesson,
      }),
    ).toThrow(/fresh/);
    expect(records.get("verificationResult", "v-stale")).toBeNull();
    now = Date.parse("2026-10-25T08:10:00Z");
    const verification: VerificationResult = {
      ...base,
      verificationId: "v-pass",
      verdict: "pass",
      checkedAt: "2026-10-25T08:09:30Z",
    };
    const passed = verifier.record({ verification, lesson });
    if (!passed.lesson) throw new Error("Passing verification did not write a lesson.");
    expect(passed.lesson?.source).toMatchObject({
      taskId: verifierTask.taskId,
      verificationId: "v-pass",
    });
    const savedCursor = db.cursor();
    expect(verifier.record({ verification, lesson }).lesson?.id).toBe(passed.lesson?.id);
    expect(db.cursor()).toBe(savedCursor);
    expect(
      runtime.memory
        .ledger(passed.lesson.id)
        .filter((row: { action: string }) => row.action === "create"),
    ).toHaveLength(1);

    const followup = runtime.submit({
      taskId: "followup-pump",
      seatId: "lead",
      bindingRevision: 1,
      message: "Explain pump pressure",
      sessionKey: verifierTask.sessionKey,
    });
    expect(followup.taskId).toBe("followup-pump");
    const followupScope = {
      gatewayId: followup.gatewayId,
      agentId: followup.agentId,
      sessionKey: followup.sessionKey,
      seatId: followup.seatId,
      bindingRevision: followup.bindingRevision,
    };
    expect(
      runtime.memory.retrieve({ ...followupScope, query: "pump pressure stopped" }),
    ).toMatchObject([
      { id: passed.lesson.id, source: { taskId: verifierTask.taskId, verificationId: "v-pass" } },
    ]);
    expect(
      runtime.memory.retrieve({
        ...followupScope,
        agentId: "other",
        query: "pump pressure stopped",
      }),
    ).toEqual([]);
    db.saveSeat({ ...db.getSeat("data"), binding: { ...db.getSeat("data").binding, revision: 2 } });
    await expect(data.read(input)).rejects.toThrow(/binding|available/);
    expect(() => verifier.record({ verification, lesson })).toThrow(
      /scope|binding|readable|available|unrelated/,
    );
    expect(runtime.memory.retrieve({ ...followupScope, query: "pump pressure stopped" })).toEqual(
      [],
    );
  });
});
