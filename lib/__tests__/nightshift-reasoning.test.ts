import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NightshiftGateway } from "../server/nightshift-gateway.mjs";
import { TaskDatabase } from "../server/task-db.mjs";
import { TaskRuntime } from "../server/task-runtime.mjs";
import {
  parsePlannerResponse,
  parseCriticResponse,
  verificationFromCritique,
  readNightshiftReasoningTask,
} from "../server/nightshift-reasoning.mjs";

const response = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const params = {
  sessionKey: "agent:main:planner",
  agentId: "main",
  seatId: "planner-seat",
  bindingRevision: 1,
  seatLabel: "Planner",
  seatRole: "Planner",
  idempotencyKey: "plan-1",
  message: "Plan a read-only inventory investigation",
};

async function waitForAudit(gateway: InstanceType<typeof NightshiftGateway>, taskId: string) {
  const deadline = Date.now() + 2000;
  while (!gateway.runAudit(taskId) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  return gateway.runAudit(taskId);
}

describe("Nightshift structured reasoning and run telemetry (mocked provider)", () => {
  it("uses real seat bindings and separate runtime histories for three local roles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-nightshift-context-"));
    const db = new TaskDatabase(join(directory, "tasks.sqlite"));
    const posts: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const gateway = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "mock-token",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/models"))
          return response({ data: [{ id: "meterless/auto" }] });
        const body = JSON.parse(String(init?.body));
        posts.push(body);
        return response({ choices: [{ message: { content: '{"role":"checked"}' } }] });
      },
    });
    const runtime = new TaskRuntime({ db, gateway, gatewayId: "nightshift-gateway" });
    try {
      await gateway.start();
      await runtime.refresh();
      for (const [role, seatId] of [
        ["planner", "plan"],
        ["analyst", "analyze"],
        ["critic", "review"],
      ]) {
        runtime.saveSeat({
          seatId,
          label: seatId,
          seatType: "worker",
          assigned: true,
          revision: 0,
        });
        gateway.registerReasoningContext({
          runtime,
          role,
          seatId,
          sessionKey: `agent:main:nightshift-${role}-context01`,
        });
        gateway.permitReasoningDispatch({
          taskId: `task-${role}`,
          role,
          seatId,
          sessionKey: `agent:main:nightshift-${role}-context01`,
          agentId: "main",
          bindingRevision: 1,
          maxRuntimeSeconds: 180,
        });
      }
      for (const [role, seatId] of [
        ["planner", "plan"],
        ["analyst", "analyze"],
        ["critic", "review"],
      ])
        runtime.submit({
          taskId: `task-${role}`,
          seatId,
          bindingRevision: 1,
          sessionKey: `agent:main:nightshift-${role}-context01`,
          message: `Check ${role}`,
        });
      const deadline = Date.now() + 2000;
      while (posts.length < 3 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(posts).toHaveLength(3);
      for (const post of posts) {
        expect(post.messages).toHaveLength(2);
        expect(post.messages[0].role).toBe("system");
        expect(post.messages[1].content).toMatch(/^Check (planner|analyst|critic)$/);
      }
      expect(new Set(posts.map((post) => post.messages[0].content))).toHaveProperty("size", 3);
      expect(db.getTask("task-planner")?.status).toBe("completed");
      expect(db.getTask("task-analyst")?.status).toBe("completed");
      expect(db.getTask("task-critic")?.status).toBe("completed");
    } finally {
      runtime.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("isolates verified Planner and Critic contexts and rejects stale bindings and tool calls", async () => {
    const posts: Array<{ messages: Array<{ content: string }> }> = [];
    const gateway = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "mock-token",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/models"))
          return response({ data: [{ id: "meterless/auto" }] });
        const body = JSON.parse(String(init?.body));
        posts.push(body);
        return body.messages[0].content.includes("critic")
          ? response({ choices: [{ message: { content: "", tool_calls: [{ id: "unsafe" }] } }] })
          : response({ choices: [{ message: { content: '{"tasks":[]}' } }] });
      },
    });
    await gateway.start();
    let revision = 1;
    const runtime = {
      gateway,
      resolve: (seatId: string) => ({
        agentId: "main",
        seat: { seatId, binding: { agentId: "main", revision, sessionKey: "agent:main:main" } },
      }),
    };
    const plannerKey = "agent:main:nightshift-planner-context01";
    const analystKey = "agent:main:nightshift-analyst-context04";
    const criticKey = "agent:main:nightshift-critic-context02";
    expect(
      gateway.registerReasoningContext({
        runtime,
        role: "planner",
        seatId: "planner-seat",
        sessionKey: plannerKey,
      }),
    ).toMatchObject({
      role: "planner",
      bindingRevision: 1,
    });
    gateway.registerReasoningContext({
      runtime,
      role: "analyst",
      seatId: "analyst-seat",
      sessionKey: analystKey,
    });
    gateway.registerReasoningContext({
      runtime,
      role: "critic",
      seatId: "critic-seat",
      sessionKey: criticKey,
    });
    expect(() =>
      gateway.registerReasoningContext({
        runtime,
        role: "critic",
        seatId: "planner-seat",
        sessionKey: "agent:main:nightshift-critic-context03",
      }),
    ).toThrow(/distinct/);
    expect(
      ((await gateway.request("sessions.list", {})) as { sessions: unknown[] }).sessions,
    ).toHaveLength(3);
    const planner = { ...params, sessionKey: plannerKey };
    await expect(gateway.request("chat.send", planner)).rejects.toThrow(/not authorized/);
    gateway.permitReasoningDispatch({
      taskId: "plan-1",
      role: "planner",
      seatId: "planner-seat",
      sessionKey: plannerKey,
      agentId: "main",
      bindingRevision: 1,
      maxRuntimeSeconds: 180,
    });
    gateway.permitReasoningDispatch({
      taskId: "critic-1",
      role: "critic",
      seatId: "critic-seat",
      sessionKey: criticKey,
      agentId: "main",
      bindingRevision: 1,
      maxRuntimeSeconds: 180,
    });
    const first = await gateway.request("chat.send", planner);
    const repeated = await gateway.request("chat.send", planner);
    expect((first as { runId: string }).runId).toBe((repeated as { runId: string }).runId);
    expect((await waitForAudit(gateway, "plan-1"))?.outcome).toBe("completed");
    await gateway.request("chat.send", {
      ...params,
      sessionKey: criticKey,
      seatId: "critic-seat",
      idempotencyKey: "critic-1",
    });
    expect((await waitForAudit(gateway, "critic-1"))?.errorCode).toBe("unauthorized_tool_response");
    expect(posts).toHaveLength(2);
    expect(posts[0].messages).toHaveLength(2);
    expect(posts[1].messages).toHaveLength(2);
    expect(posts[0].messages[0].content).toContain("planner");
    expect(posts[1].messages[0].content).toContain("critic");
    await expect(
      gateway.request("chat.send", {
        ...planner,
        idempotencyKey: "plan-tools",
        tools: [{ name: "inventory.adjust" }],
      }),
    ).rejects.toThrow(/Invalid Nightshift adapter request/);
    await expect(
      gateway.request("chat.send", {
        ...planner,
        sessionKey: "agent:main:nightshift-planner-unregistered",
      }),
    ).rejects.toThrow(/Unregistered/);
    revision = 2;
    expect(
      ((await gateway.request("sessions.list", {})) as { sessions: unknown[] }).sessions,
    ).toHaveLength(0);
    await expect(
      gateway.request("chat.send", { ...planner, idempotencyKey: "plan-stale" }),
    ).rejects.toThrow(/binding changed/);
    gateway.stop();
  });

  it("accepts bounded Planner and Critic JSON while rejecting unapproved roles and evidence", () => {
    const plan = parsePlannerResponse(
      JSON.stringify({
        reason: "Check count and source time",
        tasks: [
          {
            taskId: "read",
            role: "data-steward-researcher",
            message: "Read stock",
            dependencies: [],
            requiredEvidenceFrom: [],
          },
          {
            taskId: "review",
            role: "critic",
            message: "Review stock",
            dependencies: ["read"],
            requiredEvidenceFrom: ["read"],
          },
        ],
      }),
    );
    expect(plan.tasks[1].dependencies).toEqual(["read"]);
    expect(() => parsePlannerResponse("```json\n{}\n```")).toThrow(/JSON/);
    expect(() =>
      parsePlannerResponse(
        JSON.stringify({
          reason: "Do it",
          tasks: [
            {
              taskId: "write",
              role: "executor",
              message: "Adjust stock",
              dependencies: [],
              requiredEvidenceFrom: [],
            },
          ],
        }),
      ),
    ).toThrow(/Planner/);
    expect(() =>
      parsePlannerResponse(
        JSON.stringify({
          reason: "Cycle",
          tasks: [
            {
              taskId: "a",
              role: "critic",
              message: "A",
              dependencies: ["b"],
              requiredEvidenceFrom: [],
            },
            {
              taskId: "b",
              role: "critic",
              message: "B",
              dependencies: ["a"],
              requiredEvidenceFrom: [],
            },
          ],
        }),
      ),
    ).toThrow(/cycle/);
    const critique = parseCriticResponse(
      JSON.stringify({
        verdict: "unresolved",
        evidenceIds: ["evidence-1"],
        reason: "Synthetic data cannot prove live stock.",
      }),
      { allowedEvidenceIds: ["evidence-1"] },
    );
    expect(
      verificationFromCritique({
        critique,
        verificationId: "verify-1",
        incidentId: "incident-1",
        taskId: "critic-1",
        checkedAt: new Date().toISOString(),
      }),
    ).toMatchObject({ verdict: "unresolved" });
    expect(() =>
      parseCriticResponse(
        JSON.stringify({ verdict: "pass", evidenceIds: ["invented"], reason: "Looks good" }),
        { allowedEvidenceIds: ["evidence-1"] },
      ),
    ).toThrow(/evidence/);
  });

  it("consumes structured text only from a correlated completed role task", () => {
    const result = JSON.stringify({
      verdict: "unresolved",
      evidenceIds: ["evidence-1"],
      reason: "Current stock evidence is missing.",
    });
    const task = {
      taskId: "critic-1",
      status: "completed",
      result,
      runId: "run-1",
      seatId: "review",
      agentId: "main",
      gatewayId: "nightshift-gateway",
      sessionKey: "agent:main:review",
      bindingRevision: 1,
    };
    const operation = {
      taskId: "critic-1",
      role: "critic",
      assignment: {
        runtimeTaskId: "critic-1",
        seatId: "review",
        agentId: "main",
        gatewayId: "nightshift-gateway",
        sessionKey: "agent:main:review",
        bindingRevision: 1,
      },
    };
    const audit = { outcome: "completed", runId: "run-1", model: "meterless/auto" };
    const runtime = {
      gateway: {
        provider: "nightshift",
        model: "meterless/auto",
        runAudit: () => audit,
        verifiedReasoningContext: () => ({
          role: "critic",
          seatId: "review",
          sessionKey: "agent:main:review",
        }),
      },
      db: { getTask: () => task, getSeat: () => ({ binding: { agentId: "main", revision: 1 } }) },
    };
    const records = { get: () => ({ value: operation }) };
    expect(
      (
        readNightshiftReasoningTask({
          runtime,
          records,
          taskId: "critic-1",
          role: "critic",
          allowedEvidenceIds: ["evidence-1"],
        }).proposal as { verdict: string }
      ).verdict,
    ).toBe("unresolved");
    audit.runId = "wrong-run";
    expect(() =>
      readNightshiftReasoningTask({
        runtime,
        records,
        taskId: "critic-1",
        role: "critic",
        allowedEvidenceIds: ["evidence-1"],
      }),
    ).toThrow(/correlated/);
  });

  it("records provider, model, latency, correlation and sanitized errors without credentials", async () => {
    const sent: Array<{ input: string; init?: RequestInit }> = [];
    const audits: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ input: String(input), init });
      return String(input).endsWith("/models")
        ? response({ data: [{ id: "meterless/auto" }] })
        : response(
            { model: "meterless/auto", choices: [{ message: { content: '{"ok":true}' } }] },
            200,
            { "x-request-id": "provider-123" },
          );
    });
    const gateway = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "test-secret-token",
      fetchImpl,
      onRunAudit: (audit: Record<string, unknown>) => audits.push(audit),
    });
    const auditAtCompletion: Array<unknown> = [];
    gateway.subscribe((kind: string, data: { event?: string }) => {
      if (kind === "event" && data.event === "chat")
        auditAtCompletion.push(gateway.runAudit("plan-1"));
    });
    await gateway.start();
    const accepted = await gateway.request("chat.send", params);
    const audit = await waitForAudit(gateway, "plan-1");
    expect(audit).toMatchObject({
      provider: "nightshift",
      model: "meterless/auto",
      responseModel: "meterless/auto",
      taskId: "plan-1",
      runId: (accepted as { runId: string }).runId,
      providerRequestId: "provider-123",
      outcome: "completed",
      errorCode: null,
    });
    expect(audit?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(audits).toHaveLength(1);
    expect(auditAtCompletion).toMatchObject([{ outcome: "completed" }]);
    const post = sent.find((item) => item.input.endsWith("/chat/completions"));
    expect((post?.init?.headers as Record<string, string>)["X-Request-ID"]).toBe(audit?.requestId);
    expect(JSON.stringify(audit)).not.toContain("test-secret-token");
    gateway.stop();

    const failed = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "test-secret-token",
      fetchImpl: async (input: RequestInfo | URL) =>
        String(input).endsWith("/models")
          ? response({ data: [{ id: "meterless/auto" }] })
          : response({ message: "test-secret-token" }, 503),
    });
    await failed.start();
    await failed.request("chat.send", { ...params, idempotencyKey: "plan-2" });
    const errorAudit = await waitForAudit(failed, "plan-2");
    expect(errorAudit).toMatchObject({ outcome: "outcome_unknown", errorCode: "provider_error" });
    expect(JSON.stringify(errorAudit)).not.toContain("test-secret-token");
    failed.stop();
  });
});
