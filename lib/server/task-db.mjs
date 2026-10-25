import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TERMINAL = new Set(["completed", "failed", "stopped", "interrupted"]);
export const ACTIVE = [
  "submitted",
  "running",
  "cancel_requested",
  "outcome_unknown",
  "waiting_approval",
  "waiting_question",
];

export class TaskDatabase {
  constructor(filename) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.listeners = new Set();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS seats(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, gateway TEXT NOT NULL, session TEXT NOT NULL,
        status TEXT NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_lane ON tasks(gateway, session, status, created);
      CREATE TABLE IF NOT EXISTS dispatches(task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        idempotency_key TEXT UNIQUE NOT NULL, state TEXT NOT NULL, run_id TEXT, request_id TEXT);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, agent TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS runtime_owner(id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbound(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES (1);`);
    // Additive migration: existing task/dispatch records are retained verbatim.
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_records (
      namespace TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(namespace,id));
      INSERT OR IGNORE INTO migrations VALUES (2);`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  emit(kind, data) {
    const seq = Number(
      this.db.prepare("INSERT INTO events(kind,data) VALUES (?,?)").run(kind, JSON.stringify(data))
        .lastInsertRowid,
    );
    return { seq, kind, data };
  }
  publish(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* disconnected subscriber */
      }
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  cursor() {
    return Number(this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get().seq);
  }
  replay(after) {
    return this.db
      .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 1001")
      .all(after)
      .map((row) => ({ seq: Number(row.seq), kind: row.kind, data: JSON.parse(row.data) }));
  }
  taskEvents(id) {
    return this.db
      .prepare(
        "SELECT seq,kind,data FROM events WHERE kind='task' AND json_extract(data,'$.taskId')=? ORDER BY seq LIMIT 1000",
      )
      .all(id)
      .map((row) => ({ seq: Number(row.seq), kind: row.kind, data: JSON.parse(row.data) }));
  }
  getTask(id) {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  record(namespace, id) {
    const row = this.db
      .prepare("SELECT data FROM runtime_records WHERE namespace=? AND id=?")
      .get(namespace, id);
    return row ? JSON.parse(row.data) : null;
  }
  records(namespace) {
    return this.db
      .prepare("SELECT data FROM runtime_records WHERE namespace=? ORDER BY rowid")
      .all(namespace)
      .map((row) => JSON.parse(row.data));
  }
  saveRecord(namespace, id, value, expectedRevision, eventProjection) {
    const result = this.transaction(() => {
      const previous = this.record(namespace, id);
      if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision)
        throw Object.assign(
          new Error("State changed in another client. Refresh and review again."),
          { status: 409 },
        );
      const data = { ...value, id, revision: (previous?.revision ?? 0) + 1 };
      this.db
        .prepare(
          "INSERT INTO runtime_records VALUES (?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET data=excluded.data",
        )
        .run(namespace, id, JSON.stringify(data));
      return { data, event: this.emit(namespace, eventProjection ? eventProjection(data) : data) };
    });
    this.publish(result.event);
    return result.data;
  }
  listTasks(limit = 200, offset = 0) {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset)
      .map((row) => JSON.parse(row.data));
  }
  activeTasks() {
    return this.db
      .prepare(
        "SELECT data FROM tasks WHERE status NOT IN ('completed','failed','stopped','interrupted') ORDER BY created,rowid",
      )
      .all()
      .map((row) => JSON.parse(row.data));
  }
  seats() {
    return this.db
      .prepare("SELECT data FROM seats ORDER BY id")
      .all()
      .map((row) => JSON.parse(row.data));
  }
  getSeat(id) {
    const row = this.db.prepare("SELECT data FROM seats WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  saveSeat(seat) {
    const event = this.transaction(() => {
      this.db
        .prepare("INSERT INTO seats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(seat.seatId, JSON.stringify(seat));
      return this.emit("seat", seat);
    });
    this.publish(event);
    return seat;
  }
  insertTask(task, { imported = false } = {}) {
    const events = this.transaction(() => {
      if (this.getTask(task.taskId)) return [];
      this.db
        .prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?)")
        .run(
          task.taskId,
          task.gatewayId,
          task.sessionKey,
          task.status,
          task.createdAt,
          JSON.stringify(task),
        );
      this.db
        .prepare("INSERT INTO dispatches VALUES (?,?,?,?,NULL)")
        .run(task.taskId, task.taskId, imported ? "imported" : "pending", task.runId ?? null);
      const message = {
        id: `task_${task.taskId}`,
        taskId: task.taskId,
        runId: task.runId ?? "",
        role: "user",
        content: task.message,
        timestamp: task.createdAt,
        sessionKey: task.sessionKey,
        seatId: task.seatId,
        actorName: task.actorName,
      };
      if (!task.sourceMessageId)
        this.db
          .prepare("INSERT OR IGNORE INTO messages VALUES (?,?,?)")
          .run(message.id, message.sessionKey, JSON.stringify(message));
      return [
        this.emit("task", task),
        ...(!task.sourceMessageId ? [this.emit("message", message)] : []),
      ];
    });
    events.forEach((event) => this.publish(event));
    return this.getTask(task.taskId);
  }
  updateTask(id, patch, dispatchPatch = {}) {
    const event = this.transaction(() => {
      const old = this.getTask(id);
      if (!old) return null;
      // A late acknowledgement must never revive a terminal task.
      if (TERMINAL.has(old.status) && patch.status && patch.status !== old.status) return null;
      const task = {
        ...old,
        ...patch,
        taskId: old.taskId,
        agentId: old.agentId,
        sessionKey: old.sessionKey,
        gatewayId: old.gatewayId,
        bindingRevision: old.bindingRevision,
      };
      if (TERMINAL.has(task.status)) delete task.cancellationError;
      this.db
        .prepare("UPDATE tasks SET status=?,data=? WHERE id=?")
        .run(task.status, JSON.stringify(task), id);
      const ledger = this.ledger(id);
      if (ledger)
        this.db
          .prepare("UPDATE dispatches SET state=?,run_id=?,request_id=? WHERE task_id=?")
          .run(
            dispatchPatch.state ?? ledger.state,
            task.runId ?? ledger.run_id ?? null,
            dispatchPatch.requestId ?? ledger.request_id ?? null,
            id,
          );
      return this.emit("task", task);
    });
    if (event) this.publish(event);
    return this.getTask(id);
  }
  ledger(id) {
    return this.db.prepare("SELECT * FROM dispatches WHERE task_id=?").get(id);
  }
  claim(id) {
    const event = this.transaction(() => {
      const task = this.getTask(id);
      if (!task || task.status !== "queued" || this.ledger(id)?.state !== "pending") return null;
      const busy = this.db
        .prepare(
          "SELECT 1 FROM tasks WHERE gateway=? AND session=? AND status IN ('submitted','running','cancel_requested','outcome_unknown','waiting_approval','waiting_question') LIMIT 1",
        )
        .get(task.gatewayId, task.sessionKey);
      if (busy) return null;
      task.status = "submitted";
      this.db.prepare("UPDATE dispatches SET state='sending' WHERE task_id=?").run(id);
      this.db
        .prepare("UPDATE tasks SET status=?,data=? WHERE id=?")
        .run(task.status, JSON.stringify(task), id);
      return this.emit("task", task);
    });
    if (event) this.publish(event);
    return event?.data ?? null;
  }
  saveMessage(message) {
    const event = this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO messages VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        )
        .run(message.id, message.sessionKey, JSON.stringify(message));
      return this.emit("message", message);
    });
    this.publish(event);
  }
  messages(sessionKey) {
    return this.db
      .prepare("SELECT data FROM messages WHERE session=? ORDER BY rowid DESC LIMIT 400")
      .all(sessionKey)
      .reverse()
      .map((row) => JSON.parse(row.data));
  }
  getMessage(id) {
    const row = this.db.prepare("SELECT data FROM messages WHERE id=?").get(id);
    return row ? JSON.parse(row.data) : null;
  }
  tasksForSession(key) {
    return this.db
      .prepare("SELECT data FROM tasks WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 400")
      .all(key)
      .map((row) => JSON.parse(row.data));
  }
  saveSession(record, agentId) {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO sessions VALUES (?,?,?)")
      .run(record.key, agentId, JSON.stringify(record));
    if (inserted.changes) this.publish(this.emit("session", record));
  }
  sessions() {
    return this.db
      .prepare("SELECT data FROM sessions ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(row.data));
  }
  saveInbound(key, frame) {
    this.db.prepare("INSERT OR IGNORE INTO inbound VALUES (?,?)").run(key, JSON.stringify(frame));
  }
  inbound() {
    return this.db
      .prepare("SELECT * FROM inbound")
      .all()
      .map((row) => ({ id: row.id, frame: JSON.parse(row.data) }));
  }
  deleteInbound(key) {
    this.db.prepare("DELETE FROM inbound WHERE id=?").run(key);
  }
  hasImport(id) {
    return !!this.db.prepare("SELECT 1 FROM imports WHERE id=?").get(id);
  }
  acquireOwner() {
    this.transaction(() => {
      const previous = this.db.prepare("SELECT pid FROM runtime_owner WHERE id=1").get();
      if (previous) {
        let alive = true;
        try {
          process.kill(Number(previous.pid), 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error(
            "Another Agent Town process owns this database. Use a separate AGENT_TOWN_DB_PATH or stop that process.",
          );
      }
      this.db.prepare("INSERT OR REPLACE INTO runtime_owner VALUES (1,?)").run(process.pid);
      this.ownsRuntime = true;
    });
  }
  finishImport(id) {
    this.db.prepare("INSERT OR IGNORE INTO imports VALUES (?)").run(id);
  }
  close() {
    if (this.ownsRuntime) this.db.prepare("DELETE FROM runtime_owner WHERE pid=?").run(process.pid);
    this.db.close();
  }
}
