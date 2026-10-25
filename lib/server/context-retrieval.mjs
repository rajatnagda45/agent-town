// Retrieval uses only the server-owned gateway. Never read workspace files from disk,
// accept model-provided paths, or send a chat task to simulate a memory search.
export const CONTEXT_LIMITS = Object.freeze({
  historyMessages: 24,
  historyBytes: 24000,
  conversationMessages: 8,
  messageChars: 1000,
  instructionChars: 1600,
  requestTimeoutMs: 2000,
});
export const INSTRUCTION_FILES = Object.freeze(["AGENTS.md", "SOUL.md", "IDENTITY.md"]);

const unavailable = (reason) => ({ status: "unavailable", reason });
const failed = () => ({
  status: "error",
  reason: "Backend context could not be verified. Showing server-saved context only.",
});
const textContent = (content) => {
  if (typeof content === "string") return content.slice(0, CONTEXT_LIMITS.messageChars);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content.slice(0, 24)) {
    if (block?.type === "text" && typeof block.text === "string")
      text += block.text.slice(0, CONTEXT_LIMITS.messageChars - text.length);
    if (text.length === CONTEXT_LIMITS.messageChars) break;
  }
  return text;
};
const matches = (value, context) =>
  value &&
  (value.agentId === undefined || value.agentId === context.agentId) &&
  (value.sessionKey === undefined || value.sessionKey === context.sessionKey) &&
  (value.seatId === undefined || value.seatId === context.seatId) &&
  (value.bindingRevision === undefined || value.bindingRevision === context.bindingRevision);

/** One bounded, uncached retrieval tied to a previously resolved server selection. */
export async function retrieveAgentContext(voice, input) {
  const initial = voice.context(input);
  const selection = {
    seatId: initial.seatId,
    bindingRevision: initial.bindingRevision,
    sessionKey: initial.sessionKey,
    ...(input.taskIds ? { taskIds: [...input.taskIds] } : {}),
  };
  const runtime = voice.runtime;
  const gateway = runtime.gateway;
  const permitted = (method, params) =>
    gateway.capabilities()[method]?.available === true && gateway.audit.validate(method, params);
  const request = (method, params) =>
    gateway.request(method, params, CONTEXT_LIMITS.requestTimeoutMs);
  const ownTasks = voice.tasksForContext(initial);
  const ownRuns = new Set(ownTasks.map((task) => task.runId).filter(Boolean));
  const ownTaskIds = new Set(ownTasks.map((task) => task.taskId));
  const foreignRuns = new Set(
    runtime.db
      .tasksForSession(initial.sessionKey)
      .filter((task) => !ownTaskIds.has(task.taskId))
      .map((task) => task.runId)
      .filter(Boolean),
  );
  const shared = runtime.db.getSeat(initial.seatId).seatType === "worker";

  const history = async () => {
    const base = { sessionKey: initial.sessionKey, limit: CONTEXT_LIMITS.historyMessages };
    // Use extra backend byte/text bounds only when the installed schema permits them.
    const bounded = {
      ...base,
      agentId: initial.agentId,
      maxBytes: CONTEXT_LIMITS.historyBytes,
      maxChars: CONTEXT_LIMITS.messageChars,
      toolResultMaxChars: 1,
    };
    const params = permitted("chat.history", bounded) ? bounded : base;
    let method;
    let data;
    if (permitted("chat.history", params)) {
      method = "chat.history";
      data = await request(method, params);
      if (!matches(data, initial) || !Array.isArray(data.messages)) throw new Error();
    } else {
      // Previews have no task/run attribution, so cannot isolate shared workers.
      const preview = {
        keys: [initial.sessionKey],
        limit: CONTEXT_LIMITS.conversationMessages,
        maxChars: CONTEXT_LIMITS.messageChars,
      };
      if (shared || !permitted("sessions.preview", preview))
        return { messages: [], state: unavailable("No verified history read for this selection.") };
      method = "sessions.preview";
      data = await request(method, preview);
      if (!Array.isArray(data?.previews)) throw new Error();
      const entry = data.previews.find((entry) => entry?.key === initial.sessionKey);
      if (entry && (!matches(entry, initial) || !Array.isArray(entry.items))) throw new Error();
      data = { messages: entry?.items ?? [] };
    }
    if (!gateway.capabilities()[method]?.available) throw new Error();
    const messages = data.messages
      .slice(-CONTEXT_LIMITS.historyMessages)
      .filter(
        (message) =>
          matches(message, initial) &&
          (message.gatewayId === undefined || message.gatewayId === runtime.gatewayId) &&
          ["user", "assistant"].includes(message.role) &&
          !message.streaming &&
          (!message.taskId || ownTaskIds.has(message.taskId)) &&
          !foreignRuns.has(message.runId) &&
          (!shared || ownRuns.has(message.runId) || ownTaskIds.has(message.taskId)),
      )
      .map((message) => {
        const task = ownTasks.find(
          (task) => task.taskId === message.taskId || (task.runId && task.runId === message.runId),
        );
        return {
          role: message.role,
          // Execution prompts can contain routing wrappers and prior voice turns.
          text: textContent(
            message.role === "user" && task
              ? task.message
              : method === "sessions.preview"
                ? message.text
                : message.content,
          ),
          ...(message.interrupted === true && message.role === "assistant"
            ? { interrupted: true }
            : {}),
        };
      })
      .filter((message) => message.text.trim());
    return { messages, state: { status: "available", source: method, limited: true } };
  };

  const instructions = async () => {
    if (!gateway.audit.validators.has("AgentsFilesGetResultSchema"))
      return { files: [], state: unavailable("Instruction response schema is unavailable.") };
    if (
      !INSTRUCTION_FILES.every((name) =>
        permitted("agents.files.get", { agentId: initial.agentId, name }),
      )
    )
      return {
        files: [],
        state: unavailable("Instruction reads are not permitted by this backend."),
      };
    const results = await Promise.allSettled(
      INSTRUCTION_FILES.map(async (name) => {
        const data = await request("agents.files.get", { agentId: initial.agentId, name });
        if (
          !gateway.capabilities()["agents.files.get"]?.available ||
          !gateway.audit.validate("AgentsFilesGetResultSchema", data) ||
          data.agentId !== initial.agentId ||
          data.file.name !== name
        )
          throw new Error();
        if (data.file.missing) return null;
        if (typeof data.file.content !== "string") throw new Error();
        return {
          name,
          text: data.file.content.slice(0, CONTEXT_LIMITS.instructionChars),
          truncated: data.file.content.length > CONTEXT_LIMITS.instructionChars,
        };
      }),
    );
    return {
      files: results.flatMap((result) =>
        result.status === "fulfilled" && result.value ? [result.value] : [],
      ),
      state: results.some((result) => result.status === "rejected")
        ? { ...failed(), reason: "Some instruction excerpts could not be verified." }
        : { status: "available", source: "agents.files.get", limited: true },
    };
  };

  const memory = () => {
    const query = (
      typeof input.query === "string" && input.query.length <= 500
        ? input.query
        : (initial.conversation.filter((message) => message.role === "user").at(-1)?.text ??
          initial.tasks[0]?.message ??
          "")
    ).slice(0, 500);
    return {
      items: runtime.memory.retrieve({
        gatewayId: runtime.gatewayId,
        agentId: initial.agentId,
        sessionKey: initial.sessionKey,
        seatId: initial.seatId,
        bindingRevision: initial.bindingRevision,
        query,
        limit: 5,
      }),
      state: { status: "available", source: "Meterless H-MEM local store", limited: true },
    };
  };

  const [historyResult, instructionResult, memoryResult] = await Promise.allSettled([
    history(),
    instructions(),
    Promise.resolve().then(memory),
  ]);
  // Backend reads await IO. Reject a rebind during retrieval and refresh local task results.
  const current = voice.context(selection);
  let retrievedHistory = historyResult.status === "fulfilled" ? historyResult.value : null;
  let retrievedInstructions =
    instructionResult.status === "fulfilled" ? instructionResult.value : null;
  const retrievedMemory = memoryResult.status === "fulfilled" ? memoryResult.value : null;
  // Another read can finish after permission was revoked for an earlier response.
  if (
    retrievedHistory?.state.source &&
    !gateway.capabilities()[retrievedHistory.state.source]?.available
  )
    retrievedHistory = null;
  if (retrievedInstructions?.files.length && !gateway.capabilities()["agents.files.get"]?.available)
    retrievedInstructions = null;
  const localKeys = new Set(
    current.conversation.map((message) => JSON.stringify([message.role, message.text])),
  );
  const conversation = [
    ...(retrievedHistory?.messages ?? []).filter(
      (message) => !localKeys.has(JSON.stringify([message.role, message.text])),
    ),
    ...current.conversation,
  ];
  return {
    ...current,
    conversation: conversation.slice(-CONTEXT_LIMITS.conversationMessages),
    instructions: retrievedInstructions?.files ?? [],
    memory: retrievedMemory?.items ?? [],
    retrieval: {
      history: retrievedHistory?.state ?? failed(),
      instructions: retrievedInstructions?.state ?? failed(),
      memory: retrievedMemory?.state ?? failed(),
      workspace: unavailable("General workspace retrieval has no verified backend contract."),
    },
  };
}
