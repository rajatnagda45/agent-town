// Verified supplier findings remembered across sessions through the Meterless H-MEM reference
// engine (vendored unmodified in lib/vendor/hmem-reference, built to dist/ by scripts/build-hmem.mjs;
// the official conformance suite passes 13/13 against that built engine).
// H-MEM stores and ranks the memory, keeps provenance and confidence, and records every change
// in its trust ledger. Recall is filtered to the exact purchase order. A recalled finding is
// prior context: callers re-verify it, and report back whether current records confirmed it.
import { HMEM } from "../vendor/hmem-reference/dist/index.mjs";

const STATE = "hmem.state";
const STATE_ID = "supplier-decisions";
const EPISODE = "decisionMemory";
const LEDGER = "decisionMemoryLedger";
const tag = (poId) => `po:${String(poId).toUpperCase()}`;

export class DecisionMemory {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.engine = new HMEM({ clock: now, actor: "agent-town" });
    const saved = db.record(STATE, STATE_ID);
    if (saved?.records) this.engine.store.restoreAll(saved.records, saved.seq);
  }

  /** Persist the engine's records in the task database after each change. */
  persist() {
    const snapshot = this.engine.store.snapshotAll();
    const existing = this.db.record(STATE, STATE_ID);
    this.db.saveRecord(STATE, STATE_ID, snapshot, existing?.revision);
  }

  log(action, poId, detail) {
    const at = new Date(this.now()).toISOString();
    this.db.saveRecord(LEDGER, `${tag(poId)}:${at}:${action}`, { action, poId, at, ...detail });
  }

  /** Latest live H-MEM record for exactly this order (superseded records excluded). */
  current(poId) {
    return this.engine.store
      .all()
      .filter((record) => record.tags.includes(tag(poId)) && !record.supersededBy)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
  }

  /** Store a finding only from a completed task whose verification passed. */
  remember({ poId, taskId, verified, checks, decision }) {
    if (!verified || !poId || !taskId) throw new Error("Only verified findings are remembered.");
    const previous = this.current(poId);
    const conclusions = Object.fromEntries(checks.conclusions.map((c) => [c.code, c.quantity]));
    const record = this.engine.add({
      content: `${poId} (supplier ${checks.supplierId ?? "unknown"}): ordered ${checks.ordered}, received ${checks.received}, gap ${checks.gap}. Verified finding: ${Object.entries(
        conclusions,
      )
        .map(([code, quantity]) => `${quantity} ${code.replaceAll("_", " ")}`)
        .join(", ")}. Recommended: ${decision.decision}`,
      type: "factual",
      layer: "long_term",
      tags: [tag(poId), "supplier-decision", "verified", "synthetic-data"],
      confidence: decision.confidence ?? 0.5,
      source: `agent-town:work-task:${taskId}`,
      provenance: {
        origin: "plan_completion",
        learnedAt: this.now(),
        label: `Independently verified Work task ${taskId} (SYNTHETIC DATA test records)`,
        refs: checks.evidenceIds ?? [],
      },
      ...(previous ? { supersedes: previous.id } : {}),
    });
    if (previous) this.engine.store.update(previous.id, { supersededBy: record.id });
    const episode = {
      poId,
      taskId,
      memoryId: record.id,
      verifiedAt: new Date(this.now()).toISOString(),
      gap: checks.gap,
      ordered: checks.ordered,
      received: checks.received,
      status: checks.status,
      conclusions,
      evidenceIds: checks.evidenceIds ?? [],
      decision: decision.decision,
      confidence: record.confidence,
      label: "SYNTHETIC DATA",
    };
    this.db.saveRecord(EPISODE, record.id, episode);
    this.persist();
    this.log("remember", poId, { taskId, memoryId: record.id, supersedes: previous?.id ?? null });
    return episode;
  }

  /** The latest verified finding for exactly this order, retrieved through H-MEM, or null. */
  recall(poId, { taskId } = {}) {
    const result = this.engine.query(`${poId} supplier delivery verified finding`, { topN: 5 });
    const hit = result.memories
      .map(({ memory }) => memory)
      .find((memory) => memory.tags.includes(tag(poId)) && !memory.supersededBy);
    const memory = hit ?? this.current(poId);
    const stored = memory && this.db.record(EPISODE, memory.id);
    const episode = stored
      ? { ...stored, confidence: memory.confidence, retrieval: result.trace.retrievalReason }
      : null;
    this.persist();
    this.log("recall", poId, { taskId: taskId ?? null, memoryId: memory?.id ?? null });
    return episode;
  }

  /** Report whether current records confirmed a recalled finding (H-MEM feedback). */
  feedback(episode, status, { taskId } = {}) {
    if (!episode?.memoryId || !["confirmed", "conflicts"].includes(status)) return null;
    this.engine.feedback(episode.memoryId, status === "confirmed" ? "helpful" : "wrong");
    this.persist();
    const confidence = this.engine.store.get(episode.memoryId)?.confidence ?? null;
    this.log("feedback", episode.poId, { taskId: taskId ?? null, status, confidence });
    return confidence;
  }
}
