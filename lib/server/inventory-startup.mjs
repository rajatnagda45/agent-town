import { zetarisDeadlines } from "./zetaris-deadlines.mjs";
import { createZetarisDataSource, createZetarisHttpTransport } from "./data-zetaris.mjs";
import { createSyntheticDataSource } from "./data-synthetic.mjs";
import { createInventoryReader } from "./inventory-investigation.mjs";
import { createSyntheticInventoryFixtures } from "./inventory-synthetic.mjs";
import { decodeZetarisInventoryRow } from "./inventory-zetaris-mapping.mjs";

export const ZETARIS_REQUIRED_SETTINGS = [
  "ZETARIS_OPEN_URL",
  "ZETARIS_PAGE_URL",
  "ZETARIS_CLOSE_URL",
  "ZETARIS_PAGE_METHOD",
  "ZETARIS_CLOSE_METHOD",
  "ZETARIS_BEARER_TOKEN",
  "ZETARIS_ROWS_KEY",
  "ZETARIS_QUERY_TOKEN_KEY",
  "ZETARIS_ORG_ID",
];

/** Startup is opt-in. A live selection needs an approved mapping and complete credentials;
 * neither a missing setting nor a failed live read can select synthetic fixtures. */
/** @param {Record<string, string | undefined>} env
 * @param {{approvedLiveTemplates?: Record<string, import("./data-source.d.mts").ReadTemplate>}} options */
export function createInventoryStartupReader(env = process.env, { approvedLiveTemplates } = {}) {
  const mode = env.AGENT_TOWN_INVENTORY_MODE;
  if (!mode) return undefined;
  if (mode === "synthetic") {
    const scenario = env.AGENT_TOWN_INVENTORY_SYNTHETIC_CASE;
    if (!scenario) throw new Error("Select an explicit synthetic inventory case.");
    const profile = env.AGENT_TOWN_INVENTORY_SYNTHETIC_PROFILE;
    if (profile && profile !== "sku17-bin-a")
      throw new Error("Unknown synthetic inventory profile.");
    const fixtureOptions =
      profile === "sku17-bin-a"
        ? { sku: "SKU-17", locationId: "BIN-A", openingQuantity: 10, countedQuantity: 9 }
        : undefined;
    if (scenario === "demo-pair") {
      if (profile !== "sku17-bin-a")
        throw new Error("The paired inventory demonstration requires the SKU-17/BIN-A profile.");
      const sharedFixtureOptions = { ...fixtureOptions, now: new Date() };
      const sources = Object.fromEntries(
        ["incomplete", "complete"].map((name) => [
          name,
          createSyntheticDataSource(createSyntheticInventoryFixtures(name, sharedFixtureOptions)),
        ]),
      );
      return createInventoryReader({
        mode,
        synthetic: {
          query(input) {
            const source = sources[input.parameters?.scenarioId];
            if (!source) throw new Error("No synthetic fixture matches this evidence scenario.");
            return source.query(input);
          },
        },
      });
    }
    return createInventoryReader({
      mode,
      synthetic: createSyntheticDataSource(
        createSyntheticInventoryFixtures(scenario, fixtureOptions),
      ),
    });
  }
  if (mode !== "zetaris") throw new Error("Unknown inventory reader mode.");
  if (!approvedLiveTemplates)
    throw new Error("Approved live inventory table and field mappings are required.");
  const missing = ZETARIS_REQUIRED_SETTINGS.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing Zetaris inventory settings: ${missing.join(", ")}.`);
  if (env.ZETARIS_ROWS_KEY !== "records" || env.ZETARIS_QUERY_TOKEN_KEY !== "queryToken")
    throw new Error("Installed Zetaris response keys must be records and queryToken.");
  const transport = createZetarisHttpTransport({
    ...zetarisDeadlines(env),
    profile: "installed-sql-v1",
    openUrl: env.ZETARIS_OPEN_URL,
    pageUrl: env.ZETARIS_PAGE_URL,
    closeUrl: env.ZETARIS_CLOSE_URL,
    pageMethod: env.ZETARIS_PAGE_METHOD,
    closeMethod: env.ZETARIS_CLOSE_METHOD,
    bearerToken: env.ZETARIS_BEARER_TOKEN,
    orgId: env.ZETARIS_ORG_ID,
    allowLoopbackHttp: env.ZETARIS_ALLOW_LOOPBACK_HTTP === "1",
  });
  const source = createZetarisDataSource({ transport });
  return createInventoryReader({
    mode,
    approvedLiveTemplates,
    zetaris: {
      async query(input) {
        return (await source.query(input)).map(decodeZetarisInventoryRow);
      },
    },
  });
}
