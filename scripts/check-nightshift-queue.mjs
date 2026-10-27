/** Live read-only Nightshift queue smoke check. No synthetic provider or warehouse rows. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTaskService } from "../lib/server/runtime-api.mjs";

const env = process.env;
if (!env.NIGHTSHIFT_API_KEY || !env.NIGHTSHIFT_BASE_URL) {
  console.error("live Nightshift queue: missing_configuration");
  process.exitCode = 2;
} else {
  const directory = mkdtempSync(join(tmpdir(), "agent-town-nightshift-queue-"));
  const requestId = randomUUID().replaceAll("-", "");
  const incidentId = `nightshift_queue_${requestId}`;
  let service;
  try {
    service = await createTaskService({
      gatewayUrl: "ws://127.0.0.1:18789/",
      provider: "nightshift",
      env: {
        ...env,
        AGENT_TOWN_DB_PATH: join(directory, "tasks.sqlite"),
        AGENT_TOWN_SPECIALIST_GRANTS: JSON.stringify([
          {
            manifestId: "nightshift-planner",
            seatId: "live-plan",
            sessionKey: "agent:main:nightshift-planner-live-smoke",
          },
        ]),
        AGENT_TOWN_SPECIALIST_PROFILES: "{}",
      },
    });
    await service.start();
    if (service.runtime.gateway.status !== "connected")
      throw new Error(
        `Nightshift discovery failed: ${service.runtime.gateway.lastError ?? "unknown"}`,
      );
    await service.runtime.refresh();
    service.runtime.saveSeat({
      seatId: "live-plan",
      label: "Live read-only planner",
      seatType: "worker",
      assigned: true,
      revision: 0,
    });
    const plan = service.operations.create({
      incident: {
        incidentId,
        goal: "Verify one read-only durable Nightshift reasoning task",
        constraints: ["No tools, inventory reads, or writes"],
        taskType: "investigation",
        acceptanceCriteria: [
          {
            criterionId: "queue-response",
            description: "Task completes through the durable queue",
          },
        ],
        createdAt: new Date().toISOString(),
      },
      tasks: [
        {
          taskId: "planner",
          role: "nightshift-planner",
          message:
            "Return one short JSON object with a plan for a read-only inventory investigation. Do not use tools or claim verification.",
        },
      ],
    });
    const taskId = plan.children[0].operation.taskId;
    const deadline = Date.now() + 90000;
    let task;
    while (Date.now() < deadline) {
      task = service.runtime.db.getTask(taskId);
      if (["completed", "failed", "cancelled"].includes(task?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const audit = service.runtime.gateway.runAudit(taskId);
    console.log(
      JSON.stringify({
        provider: "nightshift",
        model: audit?.responseModel ?? audit?.model ?? null,
        taskStatus: task?.status ?? "timeout",
        runOutcome: audit?.outcome ?? null,
        errorCode: audit?.errorCode ?? null,
        durableTask: !!service.runtime.db.getTask(taskId),
        dispatchRecorded: service.operations.journal
          .list("dispatch")
          .some((item) => item.taskId === taskId),
      }),
    );
    if (task?.status !== "completed" || audit?.outcome !== "completed") process.exitCode = 1;
  } catch (error) {
    console.error(
      `live Nightshift queue failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    process.exitCode = 1;
  } finally {
    service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
