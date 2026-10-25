/** Fixtures are deliberately scoped to exact template parameters and never impersonate live data. */
export function createSyntheticDataSource(fixtures) {
  return {
    async query({ templateId, parameters }) {
      const fixture = fixtures?.[templateId];
      if (!fixture || JSON.stringify(fixture.parameters ?? {}) !== JSON.stringify(parameters))
        throw new Error("No synthetic fixture matches this reviewed query.");
      if (!Array.isArray(fixture.rows)) throw new Error("Invalid synthetic fixture.");
      return structuredClone(fixture.rows);
    },
  };
}
