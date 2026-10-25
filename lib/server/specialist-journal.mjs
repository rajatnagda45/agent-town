/** Lane-local journal adapter over existing revisioned runtime records.
 * The integration owner must approve namespace/event wiring before mounting it in the app.
 */
export class SpecialistJournal {
  constructor(db, gatewayId) {
    this.db = db;
    this.gatewayId = gatewayId;
  }
  namespace(kind) {
    if (!["provision", "dispatch", "message"].includes(kind))
      throw new Error("Unknown specialist journal kind.");
    return `laneD.${kind}`;
  }
  get(kind, id) {
    const row = this.db.record(this.namespace(kind), id);
    return row?.gatewayId === this.gatewayId ? row : null;
  }
  list(kind) {
    return this.db.records(this.namespace(kind)).filter((row) => row.gatewayId === this.gatewayId);
  }
  put(kind, id, value) {
    const old = this.get(kind, id);
    return this.db.saveRecord(
      this.namespace(kind),
      id,
      { ...value, gatewayId: this.gatewayId },
      old?.revision ?? 0,
      (record) => ({
        id: record.id,
        revision: record.revision,
        gatewayId: record.gatewayId,
        status: record.status,
      }),
    );
  }
}
