import Ajv from "ajv";

// Phase 0 wire contracts. Keep these independent of a model provider or UI seat name.
const id = { type: "string", minLength: 1, maxLength: 128 };
const text = { type: "string", minLength: 1 };
const strings = { type: "array", items: text, uniqueItems: true };
const timestamp = { type: "string", format: "operation-timestamp" };
const agentBinding = {
  type: "object",
  additionalProperties: false,
  required: ["seatId", "agentId", "bindingRevision", "gatewayId", "sessionKey"],
  properties: {
    seatId: id,
    agentId: id,
    bindingRevision: { type: "integer", minimum: 1 },
    gatewayId: id,
    sessionKey: id,
  },
};

export const OPERATION_TASK_STATUSES = [
  "planned",
  "blocked",
  "queued",
  "submitted",
  "returning",
  "running",
  "cancel_requested",
  "outcome_unknown",
  "waiting_approval",
  "waiting_question",
  "completed",
  "failed",
  "stopped",
  "interrupted",
];

export const OPERATION_SCHEMAS = {
  incident: {
    type: "object",
    additionalProperties: false,
    required: ["incidentId", "goal", "constraints", "taskType", "acceptanceCriteria", "createdAt"],
    properties: {
      incidentId: id,
      goal: text,
      constraints: strings,
      taskType: text,
      acceptanceCriteria: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterionId", "description"],
          properties: { criterionId: id, description: text },
        },
      },
      createdAt: timestamp,
    },
  },
  task: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "incidentId", "requester", "role", "dependencies", "status", "retryCount"],
    if: { properties: { status: { not: { enum: ["planned", "blocked"] } } } },
    then: { required: ["assignment"] },
    properties: {
      taskId: id,
      incidentId: id,
      parentTaskId: id,
      requester: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: { kind: { const: "user" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "seatId", "agentId", "bindingRevision", "gatewayId", "sessionKey"],
            properties: {
              kind: { const: "agent" },
              seatId: id,
              agentId: id,
              bindingRevision: { type: "integer", minimum: 1 },
              gatewayId: id,
              sessionKey: id,
            },
          },
        ],
      },
      role: text,
      dependencies: strings,
      status: { enum: OPERATION_TASK_STATUSES },
      retryCount: { type: "integer", minimum: 0 },
      assignment: {
        ...agentBinding,
        required: ["runtimeTaskId", ...agentBinding.required],
        properties: { runtimeTaskId: id, ...agentBinding.properties },
      },
    },
  },
  evidenceItem: {
    type: "object",
    additionalProperties: false,
    required: [
      "evidenceId",
      "incidentId",
      "taskId",
      "source",
      "recordId",
      "sourceTimestamp",
      "retrievedAt",
      "content",
    ],
    properties: {
      evidenceId: id,
      incidentId: id,
      taskId: id,
      source: text,
      recordId: id,
      sourceTimestamp: { anyOf: [timestamp, { type: "null" }] },
      retrievedAt: timestamp,
      freshUntil: timestamp,
      auditRef: id,
      content: text,
    },
  },
  artifact: {
    type: "object",
    additionalProperties: false,
    required: [
      "artifactId",
      "incidentId",
      "taskId",
      "mediaType",
      "uri",
      "sha256",
      "description",
      "createdAt",
    ],
    properties: {
      artifactId: id,
      incidentId: id,
      taskId: id,
      mediaType: text,
      uri: text,
      sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
      description: text,
      createdAt: timestamp,
    },
  },
  handoff: {
    type: "object",
    additionalProperties: false,
    required: [
      "handoffId",
      "incidentId",
      "fromTaskId",
      "toTaskId",
      "from",
      "to",
      "summary",
      "evidenceIds",
      "artifactIds",
      "status",
      "createdAt",
    ],
    properties: {
      handoffId: id,
      incidentId: id,
      fromTaskId: id,
      toTaskId: id,
      from: agentBinding,
      to: agentBinding,
      summary: text,
      evidenceIds: strings,
      artifactIds: strings,
      status: { enum: ["proposed", "accepted", "rejected"] },
      createdAt: timestamp,
    },
  },
  agentManifest: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "version",
      "source",
      "provider",
      "capabilities",
      "skills",
      "tools",
      "permissions",
      "limits",
    ],
    properties: {
      id,
      version: text,
      source: text,
      provider: text,
      capabilities: strings,
      skills: strings,
      tools: strings,
      permissions: {
        type: "object",
        additionalProperties: false,
        required: ["dataAccess", "sensitiveWrites"],
        properties: {
          dataAccess: { enum: ["none", "read_only", "scoped_write"] },
          sensitiveWrites: { enum: ["denied", "approval_required"] },
        },
      },
      limits: {
        type: "object",
        additionalProperties: false,
        required: ["maxRetries", "maxParallelTasks", "maxRuntimeSeconds", "maxToolCalls"],
        properties: {
          maxRetries: { type: "integer", minimum: 0 },
          maxParallelTasks: { type: "integer", minimum: 1 },
          maxRuntimeSeconds: { type: "integer", minimum: 1 },
          maxToolCalls: { type: "integer", minimum: 0 },
        },
      },
    },
  },
  verificationResult: {
    type: "object",
    additionalProperties: false,
    required: [
      "verificationId",
      "incidentId",
      "taskId",
      "verdict",
      "evidenceIds",
      "reason",
      "checkedAt",
    ],
    properties: {
      verificationId: id,
      incidentId: id,
      taskId: id,
      verdict: { enum: ["pass", "revise", "unresolved"] },
      evidenceIds: strings,
      artifactIds: strings,
      reason: text,
      checkedAt: timestamp,
    },
  },
};

const ajv = new Ajv({ allErrors: true });
ajv.addFormat("operation-timestamp", {
  type: "string",
  validate: (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
});
const validators = Object.fromEntries(
  Object.entries(OPERATION_SCHEMAS).map(([kind, schema]) => [kind, ajv.compile(schema)]),
);

export function assertOperationContract(kind, value) {
  const validate = validators[kind];
  if (!validate) throw new Error(`Unknown operation contract: ${kind}`);
  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Invalid ${kind}: ${details}`);
  }
  return value;
}

/** Project a durable Agent Town task into an incident task without changing execution. */
export function assignedOperationTask({
  incidentId,
  parentTaskId,
  requester,
  role,
  dependencies = [],
  retryCount = 0,
  task,
}) {
  if (
    !task?.taskId ||
    !task?.seatId ||
    !task?.agentId ||
    !task?.bindingRevision ||
    !task?.gatewayId ||
    !task?.sessionKey
  ) {
    throw new Error("A persisted runtime task with a verified binding is required.");
  }
  return assertOperationContract("task", {
    taskId: task.taskId,
    incidentId,
    ...(parentTaskId ? { parentTaskId } : {}),
    requester,
    role,
    dependencies,
    status: task.status,
    retryCount,
    assignment: {
      runtimeTaskId: task.taskId,
      seatId: task.seatId,
      agentId: task.agentId,
      bindingRevision: task.bindingRevision,
      gatewayId: task.gatewayId,
      sessionKey: task.sessionKey,
    },
  });
}
