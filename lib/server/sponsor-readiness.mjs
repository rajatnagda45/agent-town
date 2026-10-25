import { nightshiftBaseUrl } from "./nightshift-gateway.mjs";
import { createInventoryStartupReader, ZETARIS_REQUIRED_SETTINGS } from "./inventory-startup.mjs";
import { APPROVED_INVENTORY_ZETARIS_TEMPLATES } from "./inventory-zetaris-mapping.mjs";
import { compileReadQuery } from "./data-source.mjs";

const scope = (input) => {
  try {
    const url = new URL(input);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? "this_machine"
      : "remote_host";
  } catch {
    return "invalid";
  }
};

/** Offline configuration review. Does not connect, authenticate, or execute a query/model.
 * @param {Record<string, string | undefined>} env
 */
export function sponsorReadiness(env = process.env) {
  const nightshiftMissing = ["NIGHTSHIFT_BASE_URL", "NIGHTSHIFT_API_KEY"].filter(
    (key) => !env[key]?.trim(),
  );
  let nightshiftProfile = false;
  try {
    nightshiftBaseUrl(env.NIGHTSHIFT_BASE_URL);
    nightshiftProfile = !nightshiftMissing.length && env.NIGHTSHIFT_API_KEY !== "rt-local";
  } catch {}
  const zetarisMissing = [...ZETARIS_REQUIRED_SETTINGS, "ZETARIS_PROBE_SELECT"].filter(
    (key) => !env[key]?.trim(),
  );
  let zetarisProfile = false;
  let probeSelect = false;
  if (!zetarisMissing.length) {
    try {
      createInventoryStartupReader(
        { ...env, AGENT_TOWN_INVENTORY_MODE: "zetaris" },
        {
          approvedLiveTemplates: APPROVED_INVENTORY_ZETARIS_TEMPLATES,
        },
      );
      zetarisProfile = true;
    } catch {}
    try {
      compileReadQuery({
        id: "preflight",
        source: "preflight",
        sql: env.ZETARIS_PROBE_SELECT,
        parameters: {},
      });
      probeSelect = true;
    } catch {}
  }
  return {
    mode: "offline_configuration_only",
    nightshift: {
      missing: nightshiftMissing,
      profileValid: nightshiftProfile,
      endpointScope: scope(env.NIGHTSHIFT_BASE_URL),
      selectedForExecution: env.AGENT_PROVIDER === "nightshift",
    },
    zetaris: {
      missing: zetarisMissing,
      profileValid: zetarisProfile,
      probeSelectValid: probeSelect,
      endpointScope: scope(env.ZETARIS_OPEN_URL),
      selectedForEvidence: env.AGENT_TOWN_INVENTORY_MODE === "zetaris",
    },
    liveAcceptance: "NOT TESTED",
    guidance: [
      "Only variable names and validation outcomes are reported; configuration values are excluded.",
      "this_machine means services must listen on the computer running this command, not another laptop.",
      "A valid profile does not prove reachability, valid credentials, source freshness, or model availability.",
      "Next run nightshift:check and the approved read-only check-zetaris.mjs probe.",
    ],
  };
}
