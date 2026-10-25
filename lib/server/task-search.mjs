// Cross-task recall adapted from NousResearch/hermes-agent hermes_state_search.py (MIT):
// SQLite FTS5 with BM25 ranking over past team tasks. No LLM call; results are actual stored
// records, scoped to this gateway, and every query term is quoted so user text can never
// become FTS syntax.
const MAX_RESULTS = 20;

function sourcesOf(record) {
  return (record.evidence ?? [])
    .map((item) => {
      try {
        const parsed = JSON.parse(item.content);
        return parsed?.title ?? parsed?.url ?? item.source;
      } catch {
        return item.source;
      }
    })
    .join(" ")
    .slice(0, 4000);
}

export function ftsQuery(text) {
  const terms = String(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}]{2,}/gu)
    ?.slice(0, 12);
  return terms?.length ? terms.map((term) => `"${term}"`).join(" ") : null;
}

export class TaskSearch {
  constructor(db) {
    this.db = db;
    db.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS task_search USING fts5(
        task_id UNINDEXED, gateway UNINDEXED, goal, summary, sources, tokenize = 'unicode61');
      CREATE TABLE IF NOT EXISTS task_search_state (task_id TEXT PRIMARY KEY, updated TEXT NOT NULL);`);
  }

  /** Incremental: only records whose updatedAt changed are re-indexed. */
  refresh() {
    const known = new Map(
      this.db.db
        .prepare("SELECT task_id, updated FROM task_search_state")
        .all()
        .map((row) => [row.task_id, row.updated]),
    );
    const records = this.db.records("composer.task");
    const changed = records.filter((record) => known.get(record.id) !== (record.updatedAt ?? ""));
    if (!changed.length) return 0;
    this.db.transaction(() => {
      for (const record of changed) {
        this.db.db.prepare("DELETE FROM task_search WHERE task_id = ?").run(record.id);
        this.db.db
          .prepare(
            "INSERT INTO task_search(task_id, gateway, goal, summary, sources) VALUES (?,?,?,?,?)",
          )
          .run(
            record.id,
            record.gatewayId ?? "",
            String(record.input?.goal ?? "").slice(0, 2000),
            String(record.report?.summary ?? record.analysis?.summary ?? "").slice(0, 4000),
            sourcesOf(record),
          );
        this.db.db
          .prepare("INSERT OR REPLACE INTO task_search_state(task_id, updated) VALUES (?, ?)")
          .run(record.id, record.updatedAt ?? "");
      }
    });
    return changed.length;
  }

  search({ query, gatewayId, limit = 10 }) {
    const match = ftsQuery(query);
    if (!match || typeof gatewayId !== "string") return [];
    this.refresh();
    const rows = this.db.db
      .prepare(
        `SELECT task_id, goal, snippet(task_search, -1, '[', ']', ' … ', 12) AS snippet,
          bm25(task_search) AS rank
        FROM task_search WHERE task_search MATCH ? AND gateway = ?
        ORDER BY rank LIMIT ?`,
      )
      .all(match, gatewayId, Math.min(Math.max(1, limit), MAX_RESULTS));
    return rows.map((row) => {
      const record = this.db.record("composer.task", row.task_id);
      return {
        taskId: row.task_id,
        goal: row.goal,
        status: record?.status ?? "unknown",
        verdict: record?.verdict ?? null,
        snippet: row.snippet,
        link: `/work/${encodeURIComponent(row.task_id)}`,
      };
    });
  }
}
