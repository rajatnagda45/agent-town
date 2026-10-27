import { expect, it, vi } from "vitest";
import { createZetarisDataSource, createZetarisHttpTransport } from "../server/data-zetaris.mjs";
import { createDataReader } from "../server/data-source.mjs";
import { DataEvidenceService } from "../server/data-integration.mjs";

it("persists opening timeout SQL and safe diagnostics without a token, evidence or repeat query", async () => {
  const signal = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
  const fetchImpl = vi.fn(async (_url, options) => {
    options.signal.throwIfAborted();
  });
  const scope = {
    incidentId: "incident",
    taskId: "task",
    seatId: "seat",
    agentId: "main",
    gatewayId: "gateway",
    sessionKey: "agent:main:main",
    bindingRevision: 1,
  };
  const saved = new Map();
  const records = {
    get: (kind) => ({
      value:
        kind === "incident"
          ? {}
          : { incidentId: scope.incidentId, assignment: { ...scope, runtimeTaskId: scope.taskId } },
    }),
    put: vi.fn(),
  };
  const runtime = {
    gatewayId: scope.gatewayId,
    db: {
      getTask: () => ({ ...scope, status: "completed" }),
      record: (namespace, id) => saved.get(`${namespace}:${id}`),
      saveRecord: (namespace, id, value) => {
        const record = { ...value, id, revision: (value.revision ?? 0) + 1 };
        saved.set(`${namespace}:${id}`, record);
        return record;
      },
    },
    resolve: () => ({
      seat: { seatId: scope.seatId, binding: { agentId: scope.agentId, revision: 1 } },
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
    }),
  };
  try {
    const transport = createZetarisHttpTransport({
      profile: "installed-sql-v1",
      openUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/start",
      pageUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/page",
      closeUrl: "http://127.0.0.1:8888/api/v1.0/query/sql/close/{queryToken}",
      pageMethod: "GET",
      closeMethod: "DELETE",
      orgId: "1",
      bearerToken: "private-token",
      allowLoopbackHttp: true,
      fetchImpl,
    });
    const sql = "SELECT id, amount FROM approved";
    const reader = createDataReader({
      mode: "zetaris",
      templates: {
        sample: { id: "sample", source: "approved", sql, recordIdField: "id", fields: ["amount"] },
      },
      zetaris: createZetarisDataSource({ transport }),
    });
    const service = new DataEvidenceService(runtime, records, reader);
    const input = {
      incidentId: scope.incidentId,
      taskId: scope.taskId,
      templateId: "sample",
      requestId: "request",
    };
    await expect(service.read(input)).rejects.toThrow("Zetaris POST query request timed out.");
    const audit = saved.get("operation.dataRequest:request");
    expect(audit).toMatchObject({
      status: "execution_outcome_unknown",
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      diagnostics: {
        sql,
        stage: "open",
        method: "POST",
        timeoutMs: 10000,
        elapsedMs: expect.any(Number),
        outcome: "timeout",
        tokenAcquired: false,
        cleanup: "not_possible_without_token",
      },
    });
    expect(audit.diagnostics.requestId).toBe(fetchImpl.mock.calls[0][1].headers["X-Request-ID"]);
    expect(JSON.stringify(audit)).not.toContain("private-token");
    expect(JSON.stringify(audit)).not.toContain("Authorization");
    expect(records.put).not.toHaveBeenCalled();
    await expect(service.read(input)).rejects.toThrow(/reconcile its audit/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  } finally {
    signal.mockRestore();
  }
});
