import { createHash } from "node:crypto";
import { assertOperationContract } from "../operations-contracts.mjs";
import { OperationRecords } from "./operation-records.mjs";
import { cosine } from "./embeddings.mjs";

const SEMANTIC_MIN = 0.75;

const fail = (status, message) => Object.assign(new Error(message), { status });
const words = (value) =>
  new Set(
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.slice(0, 80) ?? [],
  );
const overlap = (query, content) =>
  query.size ? [...query].filter((word) => words(content).has(word)).length / query.size : 0;
const validDate = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Local SQLite H-MEM subset. No remote memory service or model-facing write route. */
export class HmemMemory {
  constructor(
    db,
    { clock = () => Date.now(), records = new OperationRecords(db), embedder = null } = {},
  ) {
    this.db = db;
    this.clock = clock;
    this.records = records;
    /** Optional verified embedder; without one, recall stays lexical. */
    this.embedder = embedder;
    db.db.exec(`CREATE TABLE IF NOT EXISTS hmem_memories (
      id TEXT PRIMARY KEY, gateway TEXT NOT NULL, agent TEXT NOT NULL,
      session TEXT NOT NULL, seat TEXT NOT NULL, binding INTEGER NOT NULL,
      created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hmem_scope
        ON hmem_memories(gateway,agent,session,seat,binding,created);
      CREATE TABLE IF NOT EXISTS hmem_ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
        action TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES (3);`);
  }

  /** Resolve proof by ID from the server record store; never accept proof copies. */
  loadProof(task, verificationId, now) {
    const taskId = task.taskId;
    const storedVerification = this.records.get("verificationResult", verificationId);
    if (!storedVerification) throw fail(409, "Persisted verification was not found.");
    const verification = assertOperationContract("verificationResult", storedVerification.value);
    const operationTask = this.records.get("task", taskId)?.value;
    const incident = this.records.get("incident", verification.incidentId)?.value;
    const assignment = operationTask?.assignment;
    if (
      !incident ||
      operationTask?.incidentId !== verification.incidentId ||
      assignment?.runtimeTaskId !== taskId ||
      assignment.seatId !== task.seatId ||
      assignment.agentId !== task.agentId ||
      assignment.bindingRevision !== task.bindingRevision ||
      assignment.gatewayId !== task.gatewayId ||
      assignment.sessionKey !== task.sessionKey
    )
      throw fail(409, "Persisted incident and task assignment must match the runtime task.");
    if (
      verification.verdict !== "pass" ||
      verification.taskId !== taskId ||
      !verification.evidenceIds.length ||
      verification.evidenceIds.length > 10 ||
      Date.parse(verification.checkedAt) > now
    )
      throw fail(409, "A passing verification for this task is required.");
    const latest = this.records
      .list("verificationResult")
      .filter(
        (row) => row.value.taskId === taskId && row.value.incidentId === verification.incidentId,
      )
      .sort(
        (a, b) =>
          Date.parse(b.value.checkedAt) - Date.parse(a.value.checkedAt) || b.revision - a.revision,
      )[0];
    if (latest?.id !== verificationId || latest.revision !== storedVerification.revision)
      throw fail(409, "Verification was superseded.");
    const evidence = verification.evidenceIds.map((id) => {
      const stored = this.records.get("evidenceItem", id);
      if (!stored) throw fail(409, "Persisted supporting evidence was not found.");
      const item = assertOperationContract("evidenceItem", stored.value);
      const ownerTask = this.db.getTask(item.taskId);
      const ownerOperation = this.records.get("task", item.taskId)?.value;
      const ownerAssignment = ownerOperation?.assignment;
      const ownerSeat = ownerTask && this.db.getSeat(ownerTask.seatId);
      if (
        item.incidentId !== verification.incidentId ||
        !ownerTask ||
        ownerTask.status !== "completed" ||
        ownerOperation?.incidentId !== verification.incidentId ||
        ownerAssignment?.runtimeTaskId !== item.taskId ||
        ownerAssignment.seatId !== ownerTask.seatId ||
        ownerAssignment.agentId !== ownerTask.agentId ||
        ownerAssignment.gatewayId !== ownerTask.gatewayId ||
        ownerAssignment.sessionKey !== ownerTask.sessionKey ||
        ownerAssignment.bindingRevision !== ownerTask.bindingRevision ||
        ownerSeat?.binding?.agentId !== ownerTask.agentId ||
        ownerSeat.binding.revision !== ownerTask.bindingRevision ||
        !item.freshUntil ||
        Date.parse(item.freshUntil) <= now ||
        Date.parse(item.retrievedAt) > Date.parse(verification.checkedAt)
      )
        throw fail(409, "Supporting evidence does not match or has expired.");
      return { value: item, revision: stored.revision };
    });
    return { verification, verificationRevision: storedVerification.revision, evidence };
  }

  /** Called only by a trusted verifier after it has persisted the Phase 0 records. */
  writeVerified(input) {
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["taskId", "verificationId", "content", "applicability"].includes(key),
      )
    )
      throw fail(400, "Lesson writes accept record IDs, not supplied proof copies.");
    const { taskId, verificationId, content, applicability } = input;
    if (
      typeof taskId !== "string" ||
      !taskId ||
      typeof verificationId !== "string" ||
      !verificationId
    )
      throw fail(400, "Task and verification IDs are required.");
    const task = this.db.getTask(taskId);
    const seat = task && this.db.getSeat(task.seatId);
    if (
      !task ||
      task.status !== "completed" ||
      !task.gatewayId ||
      !task.agentId ||
      !task.sessionKey ||
      !task.seatId ||
      !Number.isSafeInteger(task.bindingRevision) ||
      seat?.binding?.agentId !== task.agentId ||
      seat.binding.revision !== task.bindingRevision
    )
      throw fail(409, "A completed task with a current verified binding is required.");
    if (typeof content !== "string" || !content.trim() || content.length > 5000)
      throw fail(400, "A bounded lesson is required.");
    if (typeof applicability !== "string" || !applicability.trim() || applicability.length > 200)
      throw fail(400, "An explicit, bounded applicability topic is required.");
    const now = this.clock();
    const { verification, verificationRevision, evidence } = this.loadProof(
      task,
      verificationId,
      now,
    );
    const freshUntil = new Date(
      Math.min(...evidence.map(({ value }) => Date.parse(value.freshUntil))),
    ).toISOString();
    const source = {
      taskId,
      incidentId: verification.incidentId,
      verificationId,
      verificationRevision,
      evidenceIds: verification.evidenceIds,
      evidenceRevisions: evidence.map(({ revision }) => revision),
    };
    const id = createHash("sha256")
      .update(
        JSON.stringify({
          source,
          gatewayId: task.gatewayId,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          seatId: task.seatId,
          bindingRevision: task.bindingRevision,
          content: content.trim(),
          applicability: applicability.trim(),
        }),
      )
      .digest("hex");
    const existing = this.db.db.prepare("SELECT data FROM hmem_memories WHERE id=?").get(id);
    if (existing) return JSON.parse(existing.data);
    const memory = {
      id,
      content: content.trim(),
      type: "factual",
      layer: "long_term",
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      confidence: 1,
      applicability: applicability.trim(),
      freshUntil,
      source,
      provenance: {
        origin: "verified_task",
        learnedAt: now,
        label: `Passed verification ${verification.verificationId}`,
      },
      gatewayId: task.gatewayId,
      agentId: task.agentId,
      sessionKey: task.sessionKey,
      seatId: task.seatId,
      bindingRevision: task.bindingRevision,
    };
    this.db.transaction(() => {
      this.db.db
        .prepare("INSERT INTO hmem_memories VALUES (?,?,?,?,?,?,?,?)")
        .run(
          memory.id,
          memory.gatewayId,
          memory.agentId,
          memory.sessionKey,
          memory.seatId,
          memory.bindingRevision,
          now,
          JSON.stringify(memory),
        );
      this.db.db
        .prepare("INSERT INTO hmem_ledger(memory_id,action,at,data) VALUES (?,?,?,?)")
        .run(
          memory.id,
          "create",
          now,
          JSON.stringify({ source, verification, evidence: evidence.map(({ value }) => value) }),
        );
    });
    if (this.embedder?.verified) void this.embedMemory(memory.id).catch(() => {});
    return memory;
  }

  /** Best-effort: attach an embedding to an already verified memory. */
  async embedMemory(id) {
    const embedder = this.embedder;
    if (!embedder?.verified) return false;
    const row = this.db.db.prepare("SELECT data FROM hmem_memories WHERE id=?").get(id);
    if (!row) return false;
    const memory = JSON.parse(row.data);
    if (memory.embeddingModel === embedder.model) return true;
    const embedding = await embedder.embed(`${memory.applicability}\n${memory.content}`);
    const current = this.db.db.prepare("SELECT data FROM hmem_memories WHERE id=?").get(id);
    if (!current) return false;
    const latest = JSON.parse(current.data);
    this.db.db
      .prepare("UPDATE hmem_memories SET data=? WHERE id=?")
      .run(JSON.stringify({ ...latest, embedding, embeddingModel: embedder.model }), id);
    return true;
  }

  /** Async entry: adds a query embedding when a verified embedder exists, then the same
   * scoped, proof-checked retrieval runs. Embedding failure falls back to lexical recall. */
  async retrieveSemantic(input) {
    let queryEmbedding = null;
    if (this.embedder?.verified && typeof input?.query === "string" && input.query.trim())
      queryEmbedding = await this.embedder.embed(input.query).catch(() => null);
    return this.retrieve({ ...input, queryEmbedding });
  }

  retrieve({
    gatewayId,
    agentId,
    sessionKey,
    seatId,
    bindingRevision,
    query,
    limit = 5,
    queryEmbedding = null,
  }) {
    if (
      ![gatewayId, agentId, sessionKey, seatId].every(
        (value) => typeof value === "string" && value.length > 0,
      ) ||
      !Number.isSafeInteger(bindingRevision) ||
      bindingRevision < 1 ||
      typeof query !== "string" ||
      query.length > 500 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 5
    )
      throw fail(400, "Invalid scoped memory query.");
    const seat = this.db.getSeat(seatId);
    if (seat?.binding?.agentId !== agentId || seat.binding.revision !== bindingRevision) return [];
    const terms = words(query);
    const semantic = Array.isArray(queryEmbedding) && !!this.embedder?.model;
    if (!terms.size && !semantic) return [];
    const now = this.clock();
    const rows = this.db.db
      .prepare(
        `SELECT data FROM hmem_memories
      WHERE gateway=? AND agent=? AND session=? AND seat=? AND binding=?
      ORDER BY created DESC LIMIT 500`,
      )
      .all(gatewayId, agentId, sessionKey, seatId, bindingRevision);
    const hits = rows
      .map((row) => {
        const memory = JSON.parse(row.data);
        const topic = overlap(terms, memory.applicability ?? "");
        const keyword = overlap(terms, memory.content);
        const ageDays = Math.max(0, now - memory.timestamp) / 86400000;
        const recency = 0.15 + 0.1 * Math.exp(-ageDays / 14);
        const lexical =
          topic && keyword ? Math.min(1, (0.75 * keyword + recency) * memory.confidence) : 0;
        // Only vectors from the same verified model are comparable.
        const similarity =
          semantic && memory.embeddingModel === this.embedder.model
            ? cosine(queryEmbedding, memory.embedding)
            : 0;
        const meaning =
          similarity >= SEMANTIC_MIN
            ? Math.min(1, (0.75 * similarity + recency) * memory.confidence)
            : 0;
        return {
          memory,
          score: Math.max(lexical, meaning),
          recallMethod: meaning > lexical ? "semantic" : "lexical",
        };
      })
      .filter(
        (hit) =>
          hit.score >= 0.35 &&
          validDate(hit.memory.freshUntil) &&
          Date.parse(hit.memory.freshUntil) > now,
      )
      .filter(({ memory }) => {
        try {
          const task = this.db.getTask(memory.source.taskId);
          if (!task || task.status !== "completed") return false;
          const proof = this.loadProof(task, memory.source.verificationId, now);
          return (
            proof.verification.incidentId === memory.source.incidentId &&
            proof.verificationRevision === memory.source.verificationRevision &&
            JSON.stringify(proof.verification.evidenceIds) ===
              JSON.stringify(memory.source.evidenceIds) &&
            JSON.stringify(proof.evidence.map(({ revision }) => revision)) ===
              JSON.stringify(memory.source.evidenceRevisions)
          );
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.score - a.score || b.memory.timestamp - a.memory.timestamp)
      .slice(0, limit);
    if (hits.length)
      this.db.transaction(() => {
        for (const { memory } of hits) {
          memory.lastAccessed = now;
          memory.accessCount += 1;
          this.db.db
            .prepare("UPDATE hmem_memories SET data=? WHERE id=?")
            .run(JSON.stringify(memory), memory.id);
          this.db.db
            .prepare("INSERT INTO hmem_ledger(memory_id,action,at,data) VALUES (?,?,?,?)")
            .run(memory.id, "read", now, JSON.stringify({ query }));
        }
      });
    return hits.map(({ memory, score, recallMethod }) => ({
      id: memory.id,
      content: memory.content.slice(0, 1600),
      score,
      source: memory.source,
      layer: memory.layer,
      confidence: memory.confidence,
      applicability: memory.applicability,
      freshUntil: memory.freshUntil,
      recallMethod,
      retrievalReason:
        recallMethod === "semantic"
          ? "semantic similarity, verified provenance and freshness"
          : "keyword, applicability, verified provenance and freshness",
    }));
  }

  ledger(memoryId) {
    return this.db.db
      .prepare("SELECT action,at,data FROM hmem_ledger WHERE memory_id=? ORDER BY seq")
      .all(memoryId)
      .map((row) => ({ action: row.action, at: row.at, ...JSON.parse(row.data) }));
  }
}
