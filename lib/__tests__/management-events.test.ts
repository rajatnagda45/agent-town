import { describe, expect, it } from "vitest";
import { TaskDatabase } from "../server/task-db.mjs";
import { ManagementService } from "../server/management.mjs";

describe("management event replay", () => {
  it("stores an agent configuration snapshot for reconnecting clients", () => {
    const db = new TaskDatabase(":memory:");
    try {
      const runtime = {
        db,
        gatewayId: "fixture-gateway",
        agentsReady: true,
        closed: false,
        agents: [{ agentId: "main", model: "fixture/two" }],
      };
      const management = new ManagementService(runtime);
      const cursor = db.cursor();

      management.captureAgents();

      const replayed = db.replay(cursor).find((event) => event.kind === "management");
      expect(replayed?.seq).toBeGreaterThan(cursor);
      expect(replayed?.data.agents).toMatchObject([{ agentId: "main", model: "fixture/two" }]);
    } finally {
      db.close();
    }
  });
});
