import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskService } from "../server/runtime-api.mjs";

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const eventually = async (check: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
};

it("persists office replies through the real task runtime and restores them after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-group-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const posted: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("/models"))
      return new Response(JSON.stringify({ data: [{ id: "fixture/model" }] }), { status: 200 });
    const request = JSON.parse(String(init?.body));
    posted.push(request);
    const actor = request.messages[0].content.includes("Alice") ? "Alice" : "Bob";
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: `${actor} contribution` } }],
      }),
      { status: 200 },
    );
  };
  const options = {
    gatewayUrl: "ws://unused/",
    provider: "nightshift",
    nightshiftFetch: fetchImpl,
    env: {
      AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
      NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1",
      NIGHTSHIFT_API_KEY: "fixture-token",
      NIGHTSHIFT_MODEL: "fixture/model",
    },
  };
  const firstService = await createTaskService(options);
  cleanup.push(() => firstService.close());
  let service = firstService;
  await service.start();
  await service.runtime.refresh();
  for (const seatId of ["alice", "bob"])
    service.runtime.saveSeat({
      seatId,
      label: seatId === "alice" ? "Alice" : "Bob",
      seatType: "worker",
      assigned: true,
      roleTitle: seatId === "bob" ? "Analyst" : "Worker",
      revision: 0,
    });
  service.groupChat.send({ turnId: "durable1", message: "Assess a tutoring idea" });
  await eventually(() => service.groupChat.messages().length === 3);
  expect(service.groupChat.messages().map((message: { role: string }) => message.role)).toEqual([
    "user",
    "assistant",
    "assistant",
  ]);
  service.close();

  service = await createTaskService(options);
  cleanup.push(() => service.close());
  await service.start();
  await service.runtime.refresh();
  expect(service.groupChat.messages()).toHaveLength(3);
  expect(service.groupChat.send({ turnId: "durable1", message: "Assess a tutoring idea" }).id).toBe(
    "group_user_durable1",
  );
  expect(posted).toHaveLength(2);
  service.groupChat.send({ turnId: "durable2", message: "Plan an office demo" });
  await eventually(() => posted.length >= 3);
  expect(JSON.stringify(posted[2])).not.toContain("tutoring idea");
});
