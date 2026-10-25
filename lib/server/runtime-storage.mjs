/** A secondary runtime shares durable tasks/evidence but never aliases another gateway's
 * seats, sessions, message IDs, inbound frames or management records. No second DB owner. */
export function runtimeStorage(db, gatewayId) {
  const ns = (kind) => `execution.${gatewayId}.${kind}`;
  const own = (task) => task?.gatewayId === gatewayId;
  const records = (kind) => db.records(ns(kind));
  const get = (kind, id) => db.record(ns(kind), id);
  const put = (kind, id, value) => db.saveRecord(ns(kind), id, value);
  const scoped = {
    sharedDatabase: db,
    gatewayId,
    seats: () => records("seat"),
    getSeat: (id) => get("seat", id),
    saveSeat: (seat) => {
      put("seat", seat.seatId, seat);
      return seat;
    },
    sessions: () => records("session"),
    saveSession: (session, agentId) => put("session", session.key, { ...session, agentId }),
    saveMessage: (message) => put("message", message.id, message),
    getMessage: (id) => get("message", id),
    messages: (key) =>
      records("message")
        .filter((message) => message.sessionKey === key)
        .slice(-400),
    getTask: (id) => {
      const task = db.getTask(id);
      return own(task) ? task : null;
    },
    activeTasks: () => db.activeTasks().filter(own),
    listTasks: (limit = 200, offset = 0) =>
      db
        .listTasks(10000)
        .filter(own)
        .slice(offset, offset + limit),
    tasksForSession: (key) => db.tasksForSession(key).filter(own),
    insertTask: (task, options) => {
      if (!own(task) || db.getTask(task.taskId))
        throw new Error("Task identity crosses runtime scope.");
      return db.insertTask(task, options);
    },
    updateTask: (id, patch, dispatch) => {
      if (!own(db.getTask(id)) || (patch.gatewayId && patch.gatewayId !== gatewayId))
        throw new Error("Task update crosses runtime scope.");
      return db.updateTask(id, patch, dispatch);
    },
    record: (kind, id) => get(kind, id),
    records,
    saveRecord: (kind, id, value, revision, projection) =>
      db.saveRecord(ns(kind), id, value, revision, projection),
    saveInbound: (id, frame) => put("inbound", id, { frame }),
    inbound: () => records("inbound").filter((row) => !row.deleted),
    deleteInbound: (id) => put("inbound", id, { deleted: true }),
    hasImport: (id) => !!get("import", id),
    finishImport: (id) => put("import", id, {}),
    emit: (kind, data) => db.emit(ns(kind), { ...data, gatewayId }),
    publish: (event) =>
      db.publish({
        ...event,
        kind: event.kind.startsWith(ns("")) ? event.kind : ns(event.kind),
        data: { ...event.data, gatewayId },
      }),
    subscribe: (listener) =>
      db.subscribe((event) => {
        if (event.kind === "task" && own(event.data)) listener(event);
        else if (event.kind.startsWith(ns("")))
          listener({ ...event, kind: event.kind.slice(ns("").length) });
      }),
    close: () => {},
    acquireOwner: () => {
      throw new Error("Only the coordinating database owns the process lease.");
    },
  };
  return new Proxy(scoped, {
    get(target, key) {
      if (key in target) return target[key];
      const value = db[key];
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
}
