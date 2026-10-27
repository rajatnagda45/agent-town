import { describe, expect, it } from "vitest";
import { assertOperationContract, assignedOperationTask } from "../operations-contracts.mjs";

describe("Phase 0 investigation contracts", () => {
  it("accepts one evidence-linked investigation path with explicit limits and verdict", () => {
    const incident = assertOperationContract("incident", {
      incidentId: "water-pressure-1",
      goal: "Explain the pressure drop",
      constraints: ["Read-only investigation"],
      taskType: "maintenance-investigation",
      acceptanceCriteria: [{ criterionId: "cause", description: "Identify a supported cause" }],
      createdAt: "2026-10-25T00:00:00.000Z",
    });
    const manifest = assertOperationContract("agentManifest", {
      id: "maintenance-investigator",
      version: "1.0.0",
      source: "builtin-template",
      provider: "meterless-nightshift",
      capabilities: ["review_maintenance_history"],
      skills: [],
      tools: ["zetaris.read"],
      permissions: { dataAccess: "read_only", sensitiveWrites: "denied" },
      limits: { maxRetries: 1, maxParallelTasks: 2, maxRuntimeSeconds: 300, maxToolCalls: 10 },
    });
    const task = assertOperationContract("task", {
      taskId: "check-pump",
      incidentId: incident.incidentId,
      parentTaskId: "team-task",
      requester: { kind: "user" },
      role: manifest.id,
      dependencies: [],
      status: "planned",
      retryCount: 0,
    });
    const evidence = assertOperationContract("evidenceItem", {
      evidenceId: "pump-log-1",
      incidentId: incident.incidentId,
      taskId: task.taskId,
      source: "zetaris:pump_logs",
      recordId: "log-42",
      sourceTimestamp: null,
      retrievedAt: "2026-10-25T00:01:00.000Z",
      content: "Pressure fell after pump shutoff",
    });
    expect(evidence.freshUntil).toBeUndefined();
    expect(
      assertOperationContract("evidenceItem", {
        ...evidence,
        freshUntil: "2026-10-26T00:01:00.000Z",
      }).freshUntil,
    ).toBe("2026-10-26T00:01:00.000Z");
    const verification = assertOperationContract("verificationResult", {
      verificationId: "verify-1",
      incidentId: incident.incidentId,
      taskId: task.taskId,
      verdict: "unresolved",
      evidenceIds: [evidence.evidenceId],
      reason: "A second independent reading is still needed",
      checkedAt: "2026-10-25T00:02:00.000Z",
    });
    expect(verification.verdict).toBe("unresolved");
    expect(task.parentTaskId).toBe("team-task");
  });

  it("rejects unknown execution states, missing permission limits and unbound task projections", () => {
    expect(() =>
      assertOperationContract("evidenceItem", {
        evidenceId: "expired-format",
        incidentId: "water-pressure-1",
        taskId: "check-pump",
        source: "pump-log",
        recordId: "log-42",
        sourceTimestamp: null,
        retrievedAt: "2026-10-25T00:01:00.000Z",
        freshUntil: "tomorrow",
        content: "Pressure fell",
      }),
    ).toThrow(/Invalid evidenceItem/);
    expect(() =>
      assertOperationContract("evidenceItem", {
        evidenceId: "unproven",
        incidentId: "water-pressure-1",
        taskId: "check-pump",
        source: "pump-log",
        recordId: "log-42",
        sourceTimestamp: "yesterday",
        retrievedAt: "2026-10-25T00:01:00.000Z",
        content: "Pressure fell",
      }),
    ).toThrow(/Invalid evidenceItem/);
    expect(() =>
      assertOperationContract("task", {
        taskId: "check-pump",
        incidentId: "water-pressure-1",
        requester: { kind: "user" },
        role: "data-steward",
        dependencies: [],
        status: "success",
        retryCount: 0,
      }),
    ).toThrow(/Invalid task/);
    expect(() =>
      assertOperationContract("agentManifest", {
        id: "unsafe",
        version: "1.0.0",
        source: "builtin-template",
        provider: "openclaw",
        capabilities: [],
        skills: [],
        tools: ["equipment.control"],
        permissions: { dataAccess: "read_only" },
        limits: { maxRetries: 1 },
      }),
    ).toThrow(/Invalid agentManifest/);
    expect(() =>
      assignedOperationTask({
        incidentId: "water-pressure-1",
        requester: { kind: "user" },
        role: "data-steward",
        task: {
          taskId: "local-only",
          agentId: "main",
          status: "queued",
          message: "Investigate",
          sessionKey: "agent:main:main",
          createdAt: "2026-10-25T00:00:00.000Z",
          runId: null,
          gatewayId: "gateway-1",
          bindingRevision: 1,
        },
      }),
    ).toThrow(/verified binding/);
  });

  it("represents a request from any verified agent binding to another assigned agent", () => {
    const task = assertOperationContract("task", {
      taskId: "investigation-2",
      incidentId: "water-pressure-1",
      requester: {
        kind: "agent",
        seatId: "origin-seat",
        agentId: "origin-agent",
        bindingRevision: 3,
        gatewayId: "gateway-1",
        sessionKey: "agent:origin-agent:main",
      },
      role: "maintenance-investigator",
      dependencies: ["check-pump"],
      status: "queued",
      retryCount: 0,
      assignment: {
        runtimeTaskId: "investigation-2",
        seatId: "target-seat",
        agentId: "target-agent",
        bindingRevision: 2,
        gatewayId: "gateway-1",
        sessionKey: "agent:target-agent:main",
      },
    });
    expect(task.requester.kind).toBe("agent");
    expect(task.assignment?.agentId).toBe("target-agent");
  });
});
