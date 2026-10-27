import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService } from "../server/runtime-api.mjs";
import { NightshiftGateway, nightshiftBaseUrl } from "../server/nightshift-gateway.mjs";
import { OperationRecords } from "../server/operation-records.mjs";
import { assignedOperationTask } from "../operations-contracts.mjs";
import { createDataReader } from "../server/data-source.mjs";
import { createSyntheticDataSource } from "../server/data-synthetic.mjs";
import { DataEvidenceService } from "../server/data-integration.mjs";
import { TrustedVerificationService } from "../server/trusted-verification.mjs";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function eventually(check: () => boolean) {
  const until = Date.now() + 2000;
  while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("Nightshift provider", () => {
  it("isolates office group turns from earlier seat conversations", async () => {
    const requests: Array<{
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
    }> = [];
    const gateway = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "fixture-token",
      model: "meterless/auto",
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/models")) return json({ data: [{ id: "meterless/auto" }] });
        requests.push(JSON.parse(String(init?.body)));
        return json({ choices: [{ message: { role: "assistant", content: "A focused reply" } }] });
      },
    });
    cleanup.push(() => gateway.stop());
    await gateway.start();
    const task = (idempotencyKey: string, message: string) => ({
      idempotencyKey,
      message,
      originalMessage: message,
      agentId: "main",
      sessionKey: "agent:main:main",
      seatId: "alice",
      bindingRevision: 1,
      seatLabel: "Alice",
      seatRole: "Worker",
    });
    await gateway.request("chat.send", task("grp_first_0", "First unrelated topic"));
    await eventually(() => requests.length === 1);
    await gateway.request("chat.send", task("grp_second_0", "Second topic"));
    await eventually(() => requests.length === 2);
    expect(requests[1].messages).toHaveLength(2);
    expect(requests[1].max_tokens).toBe(256);
    expect(JSON.stringify(requests[1])).not.toContain("First unrelated topic");
  });

  it("normalizes the documented OpenAI-compatible endpoint", () => {
    for (const path of ["/", "/v1", "/v1/models", "/v1/chat/completions"])
      expect(nightshiftBaseUrl(`http://127.0.0.1:8088${path}`)).toBe("http://127.0.0.1:8088/v1");
    expect(() => nightshiftBaseUrl("file:///etc/passwd")).toThrow();
    expect(() => nightshiftBaseUrl("http://name:secret@host/v1")).toThrow();
  });

  it("routes an Agent Town task through Nightshift with the configured model and server token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-nightshift-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      return url.endsWith("/models")
        ? json({ data: [{ id: "meterless/auto" }, { id: "meterless/deep" }] })
        : json({ choices: [{ message: { role: "assistant", content: "Pump log reviewed." } }] });
    });
    const service = await createTaskService({
      gatewayUrl: "ws://unused/",
      provider: "nightshift",
      nightshiftFetch: fetchImpl,
      env: {
        AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
        NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1/models",
        NIGHTSHIFT_API_KEY: "private-nightshift-token",
        NIGHTSHIFT_MODEL: "meterless/auto",
      },
    });
    cleanup.push(() => service.close());
    await service.start();
    await service.runtime.refresh();
    expect(service.runtime.connection()).toMatchObject({
      connection: "connected",
      provider: "nightshift",
      model: "meterless/auto",
    });
    service.runtime.saveSeat({
      seatId: "lead",
      label: "Office Lead",
      seatType: "worker",
      assigned: true,
      revision: 0,
    });
    const task = service.runtime.submit({
      taskId: "nightshift-proof",
      seatId: "lead",
      bindingRevision: 1,
      message: "Review the pump log",
      sessionKey: "agent:main:main",
    });
    await eventually(() => service.runtime.db.getTask(task.taskId)?.status === "completed");
    expect(service.runtime.db.getTask(task.taskId).result).toBe("Pump log reviewed.");
    const post = requests.find((request) => request.url.endsWith("/chat/completions"));
    expect(post?.url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    expect(post?.init.redirect).toBe("error");
    expect(post?.init.headers).toMatchObject({
      Authorization: "Bearer private-nightshift-token",
      "meterless-app": "agent-town",
      "meterless-scope": "user",
    });
    const firstBody = JSON.parse(String(post?.init.body));
    expect(firstBody).toMatchObject({ model: "meterless/auto", stream: false });
    expect(firstBody.messages).toEqual([
      { role: "system", content: expect.stringContaining("Office Lead") },
      { role: "user", content: "Review the pump log" },
    ]);
    expect(JSON.stringify(service.runtime.snapshot())).not.toContain("private-nightshift-token");
    const records = new OperationRecords(service.runtime.db);
    records.put("incident", {
      incidentId: "incident-pump",
      goal: "Explain pump pressure",
      constraints: [],
      taskType: "maintenance",
      acceptanceCriteria: [{ criterionId: "diagnosis", description: "Explain low pressure" }],
      createdAt: new Date(Date.now() - 4000).toISOString(),
    });
    records.put(
      "task",
      assignedOperationTask({
        incidentId: "incident-pump",
        requester: { kind: "user" },
        role: "Data Steward",
        task: service.runtime.db.getTask(task.taskId),
      }),
    );
    records.put("verificationResult", {
      verificationId: "verify-nightshift-proof",
      incidentId: "incident-pump",
      taskId: task.taskId,
      verdict: "pass",
      evidenceIds: ["pump-log"],
      reason: "Log values checked",
      checkedAt: new Date(Date.now() - 1000).toISOString(),
    });
    records.put("evidenceItem", {
      evidenceId: "pump-log",
      incidentId: "incident-pump",
      taskId: task.taskId,
      source: "pump log",
      recordId: "log-2",
      sourceTimestamp: new Date(Date.now() - 3000).toISOString(),
      retrievedAt: new Date(Date.now() - 2000).toISOString(),
      freshUntil: new Date(Date.now() + 86400000).toISOString(),
      content: "The inlet filter was blocked.",
    });
    service.runtime.memory.writeVerified({
      taskId: task.taskId,
      verificationId: "verify-nightshift-proof",
      content: "The pump log showed a blocked inlet filter.",
      applicability: "pump pressure log filter",
    });
    const context = await service.runtime.voice.retrieveContext({
      seatId: "lead",
      bindingRevision: 1,
      query: "pump log",
    });
    expect(context.memory).toMatchObject([
      { content: "The pump log showed a blocked inlet filter." },
    ]);
    expect(context.retrieval.memory).toMatchObject({
      status: "available",
      source: "Meterless H-MEM local store",
    });

    const followup = service.runtime.submit({
      taskId: "nightshift-followup",
      seatId: "lead",
      bindingRevision: 1,
      message: "Explain pump pressure",
      sessionKey: "agent:main:main",
    });
    await eventually(() => service.runtime.db.getTask(followup.taskId)?.status === "completed");
    const secondBody = JSON.parse(
      String(requests.filter((request) => request.url.endsWith("/chat/completions"))[1].init.body),
    );
    expect(secondBody.messages).toEqual([
      { role: "system", content: expect.stringContaining("Office Lead") },
      { role: "user", content: "Review the pump log" },
      { role: "assistant", content: "Pump log reviewed." },
      {
        role: "user",
        content: expect.stringContaining("The pump log showed a blocked inlet filter."),
      },
    ]);

    // A related mocked investigation reuses the old lesson as background, then
    // obtains and verifies a fresh synthetic source record for its own incident.
    const currentTime = new Date();
    records.put("incident", {
      incidentId: "incident-pump-followup",
      goal: "Check the related pump after the earlier filter lesson",
      constraints: ["Read-only", "Synthetic fixture"],
      taskType: "synthetic-maintenance-investigation",
      acceptanceCriteria: [
        { criterionId: "current-reading", description: "Check a new source record" },
      ],
      createdAt: currentTime.toISOString(),
    });
    records.put(
      "task",
      assignedOperationTask({
        incidentId: "incident-pump-followup",
        requester: { kind: "user" },
        role: "Critic",
        task: service.runtime.db.getTask(followup.taskId),
      }),
    );
    const reader = createDataReader({
      mode: "synthetic",
      templates: {
        "related-pump": {
          id: "related-pump",
          source: "synthetic_related_pump",
          sql: "SELECT id, observed_at, pressure FROM synthetic_related_pump WHERE pump_id = :pumpId",
          parameters: { pumpId: "text" as const },
          recordIdField: "id",
          timestampField: "observed_at",
          fields: ["pressure"],
          maxAgeMs: 600000,
        },
      },
      synthetic: createSyntheticDataSource({
        "related-pump": {
          parameters: { pumpId: "pump-b" },
          rows: [
            { id: "current-reading-1", observed_at: currentTime.toISOString(), pressure: 305 },
          ],
        },
      }),
      now: () => currentTime,
    });
    const currentEvidence = await new DataEvidenceService(service.runtime, records, reader, {
      clock: () => currentTime,
    }).read({
      incidentId: "incident-pump-followup",
      taskId: followup.taskId,
      templateId: "related-pump",
      parameters: { pumpId: "pump-b" },
    });
    expect(currentEvidence.evidence[0].source).toBe("synthetic:synthetic_related_pump");
    expect(currentEvidence.evidence[0].auditRef).toBe(currentEvidence.auditRef);
    const currentVerification = new TrustedVerificationService(service.runtime, records, {
      clock: () => currentTime,
    }).record({
      verification: {
        verificationId: "verify-related-synthetic-reading",
        incidentId: "incident-pump-followup",
        taskId: followup.taskId,
        verdict: "pass",
        evidenceIds: currentEvidence.evidence.map(
          (item: { evidenceId: string }) => item.evidenceId,
        ),
        reason: "Mocked check of the current synthetic reading after recalling the prior lesson.",
        checkedAt: currentTime.toISOString(),
      },
    });
    expect(currentVerification.verification.verdict).toBe("pass");
    expect(
      records.get("verificationResult", "verify-related-synthetic-reading")?.value.evidenceIds,
    ).toEqual(currentEvidence.evidence.map((item: { evidenceId: string }) => item.evidenceId));

    service.runtime.saveSeat({
      seatId: "other",
      label: "Researcher",
      seatType: "worker",
      assigned: true,
      revision: 0,
    });
    const isolated = service.runtime.submit({
      taskId: "nightshift-other",
      seatId: "other",
      bindingRevision: 1,
      message: "Explain pump pressure",
      sessionKey: "agent:main:main",
    });
    await eventually(() => service.runtime.db.getTask(isolated.taskId)?.status === "completed");
    const thirdBody = JSON.parse(
      String(requests.filter((request) => request.url.endsWith("/chat/completions"))[2].init.body),
    );
    expect(thirdBody.messages).toEqual([
      { role: "system", content: expect.stringContaining("Researcher") },
      { role: "user", content: "Explain pump pressure" },
    ]);
  });

  it("blocks missing, placeholder, rejected and undiscovered model credentials", async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: "meterless/fast" }] }));
    for (const apiKey of [undefined, "rt-local"]) {
      const gateway = new NightshiftGateway({
        baseUrl: "http://127.0.0.1:8088/v1",
        apiKey,
        fetchImpl,
      });
      await gateway.start();
      expect(gateway.status).toBe("auth_failed");
      expect(gateway.capabilities()["chat.send"].available).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const rejected = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "bad-token",
      fetchImpl: async () => json({}, 401),
    });
    await rejected.start();
    expect(rejected.status).toBe("auth_failed");
    expect(rejected.lastError).toBe("unauthorized");
    const unknownModel = new NightshiftGateway({
      baseUrl: "http://127.0.0.1:8088/v1",
      apiKey: "private",
      fetchImpl,
    });
    await unknownModel.start();
    expect(unknownModel.status).toBe("disconnected");
    expect(unknownModel.lastError).toBe("model_unavailable");
  });

  it.each([
    { name: "authorization rejection", complete: () => json({}, 401), status: "failed" },
    { name: "provider error", complete: () => json({}, 503), status: "outcome_unknown" },
    {
      name: "network loss",
      complete: () => Promise.reject(new Error("socket lost")),
      status: "outcome_unknown",
    },
  ])("keeps $name separate from verified success", async ({ complete, status }) => {
    const directory = mkdtempSync(join(tmpdir(), "agent-town-nightshift-error-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/models") ? json({ data: [{ id: "meterless/auto" }] }) : complete(),
    );
    const service = await createTaskService({
      gatewayUrl: "ws://unused/",
      provider: "nightshift",
      nightshiftFetch: fetchImpl,
      env: {
        AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
        NIGHTSHIFT_API_KEY: "private-nightshift-token",
      },
    });
    cleanup.push(() => service.close());
    await service.start();
    await service.runtime.refresh();
    service.runtime.saveSeat({
      seatId: "lead",
      label: "Office Lead",
      seatType: "worker",
      assigned: true,
      revision: 0,
    });
    service.runtime.submit({
      taskId: "failure-proof",
      seatId: "lead",
      bindingRevision: 1,
      message: "Review the pump log",
      sessionKey: "agent:main:main",
    });
    await eventually(() => service.runtime.db.getTask("failure-proof")?.status === status);
    const task = service.runtime.db.getTask("failure-proof");
    expect(task.status).not.toBe("completed");
    if (status === "outcome_unknown") expect(task.completedAt).toBeUndefined();
    expect(
      service.runtime.memory.retrieve({
        gatewayId: task.gatewayId,
        agentId: task.agentId,
        sessionKey: task.sessionKey,
        seatId: task.seatId,
        bindingRevision: task.bindingRevision,
        query: "pump log",
      }),
    ).toEqual([]);
  });
});
