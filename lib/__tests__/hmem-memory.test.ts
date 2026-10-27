import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDatabase } from "../server/task-db.mjs";
import { HmemMemory } from "../server/hmem-memory.mjs";
import { OperationRecords } from "../server/operation-records.mjs";
import { assignedOperationTask } from "../operations-contracts.mjs";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const scope = {
  gatewayId: "gateway-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  seatId: "lead",
  bindingRevision: 1,
};
const evidence = {
  evidenceId: "e-1",
  incidentId: "i-1",
  taskId: "proof-1",
  source: "pump log",
  recordId: "log-2",
  sourceTimestamp: "2026-10-24T20:00:00Z",
  retrievedAt: "2026-10-24T22:00:00Z",
  freshUntil: "2026-10-26T00:00:00Z",
  content: "Inlet filter obstructed at low pressure.",
};
const verification = {
  verificationId: "v-1",
  incidentId: "i-1",
  taskId: "proof-1",
  verdict: "pass" as const,
  evidenceIds: ["e-1"],
  reason: "Log checked against pressure reading",
  checkedAt: "2026-10-24T23:00:00Z",
};
const lesson = {
  taskId: "proof-1",
  content: "Pump pressure dropped because the inlet filter was blocked.",
  applicability: "pump pressure inlet filter",
  verificationId: "v-1",
};

function setup(status = "completed", persist = true) {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-hmem-"));
  directories.push(directory);
  const path = join(directory, "tasks.sqlite");
  const db = new TaskDatabase(path);
  let now = Date.parse("2026-10-25T00:00:00Z");
  const memory = new HmemMemory(db, { clock: () => now });
  const records = new OperationRecords(db);
  db.saveSeat({
    seatId: "lead",
    assigned: true,
    binding: {
      seatId: "lead",
      agentId: "main",
      sessionKey: "agent:main:main",
      revision: 1,
    },
  });
  db.insertTask({
    taskId: "proof-1",
    ...scope,
    message: "Investigate pump pressure",
    status,
    result: "Low pressure confirmed",
    createdAt: "2026-10-25T00:00:00Z",
  });
  records.put("incident", {
    incidentId: "i-1",
    goal: "Restore pump pressure",
    constraints: [],
    taskType: "maintenance",
    acceptanceCriteria: [{ criterionId: "pressure", description: "Confirm pump pressure" }],
    createdAt: "2026-10-24T21:00:00Z",
  });
  records.put(
    "task",
    assignedOperationTask({
      incidentId: "i-1",
      requester: { kind: "user" },
      role: "Data Steward",
      task: db.getTask("proof-1"),
    }),
  );
  if (persist) {
    records.put("evidenceItem", evidence);
    records.put("verificationResult", verification);
  }
  return {
    db,
    memory,
    records,
    path,
    setNow: (value: string) => {
      now = Date.parse(value);
    },
  };
}

describe("local H-MEM verified lesson interface", () => {
  it("recalls a fresh Phase 0 verified lesson after reopen and audits its use", () => {
    const { db, memory, path } = setup();
    const saved = memory.writeVerified(lesson);
    expect(saved).toMatchObject({
      layer: "long_term",
      source: {
        taskId: "proof-1",
        verificationId: "v-1",
        evidenceIds: ["e-1"],
      },
    });
    db.close();
    const reopened = new TaskDatabase(path);
    try {
      const recovered = new HmemMemory(reopened, {
        clock: () => Date.parse("2026-10-25T00:00:00Z"),
      });
      expect(recovered.writeVerified(lesson).id).toBe(saved.id);
      expect(recovered.retrieve({ ...scope, query: "pump pressure" })).toMatchObject([
        { id: saved.id, content: saved.content, source: saved.source },
      ]);
      expect(recovered.ledger(saved.id).map((row: { action: string }) => row.action)).toEqual([
        "create",
        "read",
      ]);
    } finally {
      reopened.close();
    }
  });

  it("rejects forged copies, missing persisted proof, and non-passing verification", () => {
    const { db, memory, records } = setup();
    try {
      const unfinished = setup("outcome_unknown");
      try {
        expect(() => unfinished.memory.writeVerified(lesson)).toThrow();
      } finally {
        unfinished.db.close();
      }
      expect(() =>
        memory.writeVerified({
          ...lesson,
          verification: {
            ...verification,
            verdict: "pass",
          },
        }),
      ).toThrow(/record IDs/);
      expect(() => memory.writeVerified({ ...lesson, evidence: [evidence] })).toThrow(/record IDs/);
      expect(() => memory.writeVerified({ ...lesson, verificationId: "missing" })).toThrow();
      expect(() => memory.writeVerified({ ...lesson, applicability: "" })).toThrow();
      records.put("verificationResult", { ...verification, verdict: "unresolved" }, 1);
      expect(() => memory.writeVerified(lesson)).toThrow();
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toEqual([]);
    } finally {
      db.close();
    }
    const absent = setup("completed", false);
    try {
      expect(() => absent.memory.writeVerified(lesson)).toThrow(/not found/);
      absent.records.put("verificationResult", verification);
      expect(() => absent.memory.writeVerified(lesson)).toThrow(/not found/);
    } finally {
      absent.db.close();
    }
  });

  it("rejects persisted task/incident mismatch and expired or missing freshness", () => {
    const { db, memory, records } = setup();
    try {
      records.put("evidenceItem", { ...evidence, incidentId: "other" }, 1);
      expect(() => memory.writeVerified(lesson)).toThrow();
      records.put("evidenceItem", { ...evidence, taskId: "other" }, 2);
      expect(() => memory.writeVerified(lesson)).toThrow();
      records.put("evidenceItem", { ...evidence, freshUntil: "2026-10-24T23:00:00Z" }, 3);
      expect(() => memory.writeVerified(lesson)).toThrow();
      const withoutExpiry = Object.fromEntries(
        Object.entries(evidence).filter(([key]) => key !== "freshUntil"),
      ) as Omit<typeof evidence, "freshUntil">;
      records.put("evidenceItem", withoutExpiry, 4);
      expect(() => memory.writeVerified(lesson)).toThrow();
      records.put("evidenceItem", evidence, 5);
      records.put("verificationResult", { ...verification, taskId: "other" }, 1);
      expect(() => memory.writeVerified(lesson)).toThrow();
    } finally {
      db.close();
    }
  });

  it("requires persisted incident and assignment matching the runtime binding", () => {
    const { db, memory, records } = setup();
    try {
      const assignment = records.get("task", "proof-1")!.value;
      records.put("task", { ...assignment, incidentId: "other" }, 1);
      expect(() => memory.writeVerified(lesson)).toThrow();
      records.put(
        "task",
        {
          ...assignment,
          assignment: {
            ...assignment.assignment!,
            bindingRevision: 2,
          },
        },
        2,
      );
      expect(() => memory.writeVerified(lesson)).toThrow();
      records.put("task", assignment, 3);
      expect(memory.writeVerified(lesson).source.incidentId).toBe("i-1");
    } finally {
      db.close();
    }
  });

  it("deduplicates repeated delivery and invalidates revised proof", () => {
    const { db, memory, records } = setup();
    try {
      const first = memory.writeVerified(lesson);
      expect(memory.writeVerified(lesson).id).toBe(first.id);
      expect(memory.ledger(first.id).map((row: { action: string }) => row.action)).toEqual([
        "create",
      ]);
      records.put("evidenceItem", { ...evidence, content: "Updated log" }, 1);
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toEqual([]);
      const replacement = memory.writeVerified(lesson);
      expect(replacement.id).not.toBe(first.id);
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toMatchObject([
        { id: replacement.id },
      ]);
    } finally {
      db.close();
    }
  });

  it("expires lessons and checks explicit applicability", () => {
    const { db, memory, setNow } = setup();
    try {
      memory.writeVerified(lesson);
      expect(memory.retrieve({ ...scope, query: "unrelated bananas" })).toEqual([]);
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toHaveLength(1);
      setNow("2026-10-26T00:00:00Z");
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("isolates gateway, agent, session, seat, binding, and separate user databases", () => {
    const { db, memory } = setup();
    const second = setup();
    try {
      memory.writeVerified(lesson);
      for (const [key, value] of Object.entries({
        gatewayId: "gateway-2",
        agentId: "bob",
        sessionKey: "agent:main:other",
        seatId: "other",
        bindingRevision: 2,
      }))
        expect(memory.retrieve({ ...scope, [key]: value, query: "pump pressure" })).toEqual([]);
      expect(second.memory.retrieve({ ...scope, query: "pump pressure" })).toEqual([]);
      db.saveSeat({
        seatId: "lead",
        assigned: true,
        binding: {
          seatId: "lead",
          agentId: "main",
          sessionKey: "agent:main:main",
          revision: 2,
        },
      });
      expect(memory.retrieve({ ...scope, query: "pump pressure" })).toEqual([]);
      expect(() => memory.writeVerified(lesson)).toThrow();
    } finally {
      db.close();
      second.db.close();
    }
  });
});

describe("semantic recall adapted from agent-office", () => {
  // Deterministic stand-in: "pump" meaning maps to one axis, everything else to another.
  const fakeEmbedder = () => ({
    model: "fake-embed",
    verified: true,
    status: "verified",
    async embed(text: string) {
      return /pump|water machine|lose force|filter/i.test(text) ? [1, 0.1] : [0, 1];
    },
    async verify() {
      return true;
    },
  });
  const paraphrase = "why did the water machine lose force";

  it("recalls a paraphrase with no shared words only through a verified embedder", async () => {
    const { db, memory } = setup();
    try {
      const saved = memory.writeVerified(lesson);
      expect(memory.retrieve({ ...scope, query: paraphrase })).toEqual([]);
      memory.embedder = fakeEmbedder();
      expect(await memory.embedMemory(saved.id)).toBe(true);
      const hits = await memory.retrieveSemantic({ ...scope, query: paraphrase });
      expect(hits).toMatchObject([{ id: saved.id, recallMethod: "semantic" }]);
      expect(hits[0].retrievalReason).toContain("semantic similarity");
      // Lexical matches still report as lexical.
      expect(
        (await memory.retrieveSemantic({ ...scope, query: "pump pressure" }))[0],
      ).toMatchObject({ recallMethod: "lexical" });
    } finally {
      db.close();
    }
  });

  it("never returns out-of-scope memories, however similar, and ignores other models' vectors", async () => {
    const { db, memory } = setup();
    try {
      const saved = memory.writeVerified(lesson);
      memory.embedder = fakeEmbedder();
      await memory.embedMemory(saved.id);
      expect(
        await memory.retrieveSemantic({
          ...scope,
          sessionKey: "agent:main:other",
          query: paraphrase,
        }),
      ).toEqual([]);
      memory.embedder = { ...fakeEmbedder(), model: "different-model" };
      expect(await memory.retrieveSemantic({ ...scope, query: paraphrase })).toEqual([]);
      // An unverified embedder is never used.
      memory.embedder = { ...fakeEmbedder(), verified: false };
      expect(await memory.retrieveSemantic({ ...scope, query: paraphrase })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
