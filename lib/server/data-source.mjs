import { assertDataScope, evidenceFromRecord } from "./data-evidence.mjs";

const allowedName = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(value);

/** Compile only a reviewed SELECT template. Parameters are SQL literals, never SQL fragments. */
export function compileReadQuery(template, parameters = {}) {
  if (!template || !allowedName(template.id) || !allowedName(template.source))
    throw new Error("Unknown data query template.");
  if (
    typeof template.sql !== "string" ||
    !/^SELECT\s/i.test(template.sql) ||
    /;|--|\/\*|\*\//.test(template.sql)
  )
    throw new Error("Data query must be a single reviewed SELECT statement.");
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters))
    throw new Error("Invalid data query parameters.");
  const definitions = template.parameters ?? {};
  const placeholders = new Set(
    [...template.sql.matchAll(/:([a-z][a-z0-9_]*)/gi)].map((match) => match[1]),
  );
  for (const name of Object.keys(parameters))
    if (!Object.hasOwn(definitions, name) || !placeholders.has(name))
      throw new Error("Unknown data query parameter.");
  for (const name of placeholders)
    if (!Object.hasOwn(definitions, name) || !Object.hasOwn(parameters, name))
      throw new Error("Missing data query parameter.");
  const sql = template.sql.replace(/:([a-z][a-z0-9_]*)/gi, (_match, name) => {
    const definition = definitions[name];
    const value = parameters[name];
    if (!definition || value === undefined || value === null)
      throw new Error("Missing data query parameter.");
    if (definition === "integer" && Number.isSafeInteger(value)) return String(value);
    if (
      definition === "text" &&
      typeof value === "string" &&
      value.length <= 128 &&
      !/[\u0000-\u001f]/.test(value)
    )
      return `'${value.replaceAll("'", "''")}'`;
    throw new Error("Invalid data query parameter.");
  });
  return sql;
}

export function createDataReader({ mode, templates, zetaris, synthetic, now = () => new Date() }) {
  if (!["zetaris", "synthetic"].includes(mode)) throw new Error("Choose a data source explicitly.");
  const adapter = mode === "zetaris" ? zetaris : synthetic;
  if (!adapter || typeof adapter.query !== "function") throw new Error("Data adapter unavailable.");
  return {
    serviceId: mode === "zetaris" ? "zetaris" : null,
    describeRead({ templateId, parameters = {} }) {
      const sql = compileReadQuery(templates?.[templateId], parameters);
      return { sql, ...adapter.describeQuery?.(sql) };
    },
    async read({ templateId, parameters = {}, scope }) {
      const verifiedScope = assertDataScope(scope);
      const template = templates?.[templateId];
      const sql = compileReadQuery(template, parameters);
      if (
        !Array.isArray(template.fields) ||
        !template.fields.length ||
        !template.fields.every(allowedName) ||
        !allowedName(template.recordIdField) ||
        (template.timestampField && !allowedName(template.timestampField)) ||
        (template.maxAgeMs !== undefined &&
          (!Number.isSafeInteger(template.maxAgeMs) || template.maxAgeMs < 1))
      )
        throw new Error("Invalid data evidence projection.");
      let rows;
      let queryDiagnostics;
      try {
        rows = await adapter.query({
          templateId,
          sql,
          parameters,
          onDiagnostics: (value) => {
            queryDiagnostics = value;
          },
        });
      } catch (error) {
        if (mode === "zetaris") error.queryDiagnostics = { ...error.queryDiagnostics, sql };
        throw error;
      }
      if (!Array.isArray(rows) || rows.length > 100)
        throw new Error("Data adapter exceeded the evidence row limit.");
      const retrievedAt = now().toISOString();
      const evidence = rows.map((row) =>
        evidenceFromRecord({ row, template, scope: verifiedScope, origin: mode, retrievedAt }),
      );
      return {
        evidence,
        scope: verifiedScope,
        mode,
        ...(queryDiagnostics ? { queryDiagnostics } : {}),
      };
    },
  };
}
