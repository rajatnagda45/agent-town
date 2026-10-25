/** Demonstration only: every row produced by this fixture is labelled synthetic in EvidenceItem.source. */
export const SYNTHETIC_DATA_FIXTURES = Object.freeze({
  "pump-pressure-readings": {
    parameters: { buildingId: "building-a" },
    rows: [
      {
        reading_id: "pump-101",
        observed_at: "2026-10-25T08:00:00Z",
        pressure_kpa: 310,
        pump_state: "running",
      },
      {
        reading_id: "pump-102",
        observed_at: "2026-10-25T08:05:00Z",
        pressure_kpa: 185,
        pump_state: "stopped",
      },
    ],
  },
});

/** Example reviewed template; replace dataset/column names with the approved Zetaris catalog mapping. */
export const EXAMPLE_DATA_TEMPLATES = Object.freeze({
  "pump-pressure-readings": {
    id: "pump-pressure-readings",
    source: "pump_pressure_readings",
    sql: "SELECT reading_id, observed_at, pressure_kpa, pump_state FROM pump_pressure_readings WHERE building_id = :buildingId",
    parameters: { buildingId: "text" },
    recordIdField: "reading_id",
    timestampField: "observed_at",
    fields: ["pressure_kpa", "pump_state"],
    maxAgeMs: 15 * 60 * 1000,
  },
});
