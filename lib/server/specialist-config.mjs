import { SPECIALIST_CATALOGUE } from "./specialist-catalogue.mjs";

const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const known = new Set(SPECIALIST_CATALOGUE.map((entry) => entry.manifest.id));

/** Server-owned reviewed bindings. No browser or model field can add a grant. */
/** @param {Record<string, string | undefined>} env */
export function loadSpecialistConfig(env = process.env) {
  const parse = (key, fallback) => {
    if (!env[key]) return fallback;
    try {
      return JSON.parse(env[key]);
    } catch {
      throw new Error(`Invalid ${key} JSON.`);
    }
  };
  const grants = parse("AGENT_TOWN_SPECIALIST_GRANTS", []);
  const profiles = parse("AGENT_TOWN_SPECIALIST_PROFILES", {});
  if (
    !Array.isArray(grants) ||
    grants.length > 32 ||
    grants.some(
      (row) =>
        !row ||
        Object.keys(row).some((key) => !["manifestId", "seatId", "sessionKey"].includes(key)) ||
        !known.has(row.manifestId) ||
        !id(row.seatId) ||
        (row.sessionKey !== undefined && !text(row.sessionKey, 256)),
    )
  )
    throw new Error("Invalid reviewed specialist grants.");
  if (
    !profiles ||
    typeof profiles !== "object" ||
    Array.isArray(profiles) ||
    Object.keys(profiles).length > 32 ||
    Object.entries(profiles).some(
      ([manifestId, row]) =>
        !known.has(manifestId) ||
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).some((key) => !["seatId", "name", "workspace", "label"].includes(key)) ||
        !id(row.seatId) ||
        !text(row.name, 80) ||
        !text(row.workspace, 512) ||
        (row.label !== undefined && !text(row.label, 80)),
    )
  )
    throw new Error("Invalid reviewed specialist provisioning profiles.");
  return { grants, profiles };
}
