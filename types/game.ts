// --- Studio domain types ---

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"
  | "auth_failed"
  | "device_pairing"
  | "unreachable"
  | "rate_limited"
  | "protocol_mismatch";

export type SeatFacing = "right" | "up" | "left" | "down";

export type SeatStatus = "empty" | "returning" | "running" | "done" | "failed";

export type SeatType = "worker" | "agent";

/** Identity info read from an OpenClaw agent's IDENTITY.md / config. */
export interface AgentIdentity {
  name?: string;
  emoji?: string;
  avatar?: string;
}

/** Configuration snapshot for an OpenClaw independent agent. */
export interface AgentConfig {
  agentId: string;
  name?: string;
  configRevision?: string;
  workspace?: string;
  model?: string;
  identity?: AgentIdentity;
  soul?: string;
}

export interface SeatState {
  seatId: string;
  label: string;
  /** "worker" = tool-slot for main agent; "agent" = independent OpenClaw agent. */
  seatType: SeatType;
  roleTitle?: string;
  assigned?: boolean;
  spriteKey?: string;
  spritePath?: string;
  spawnX?: number;
  spawnY?: number;
  spawnFacing?: SeatFacing;
  status: SeatStatus;
  taskSnippet?: string;
  runId?: string;
  startedAt?: string;
  /** Present only when seatType === "agent". */
  agentConfig?: AgentConfig;
  /** Server-owned routing identity; labels never select a backend agent. */
  binding?: SeatBinding;
}

export interface SeatBinding {
  seatId: string;
  agentId: string | null;
  sessionKey: string | null;
  revision: number;
  available: boolean;
  reason?: string;
}

export interface Capability {
  available: boolean;
  reason: string;
}

export type GatewayCapabilities = Record<string, Capability>;

export type TaskStatus =
  | "submitted"
  | "queued"
  | "returning"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancel_requested"
  | "outcome_unknown"
  | "waiting_approval"
  | "waiting_question";

export interface TaskItem {
  taskId: string;
  /** Null only for unresolved imported legacy records. */
  agentId?: string | null;
  bindingRevision?: number;
  gatewayId?: string;
  message: string;
  status: TaskStatus;
  runId?: string | null;
  seatId?: string;
  sessionKey: string;
  actorName?: string;
  result?: string;
  createdAt: string;
  completedAt?: string;
  /** Pin execution to the conversation in which the request was made. */
  sessionPinned?: boolean;
  /** Conversation context for execution; message remains the user's visible request. */
  executionMessage?: string;
  error?: string;
  sourceMessageId?: string;
  orchestrationId?: string;
  stepId?: string;
  attempt?: number;
  cancelRequestedAt?: string;
  cancelState?: "awaiting_run" | "sending" | "acknowledged" | "rejected" | "outcome_unknown";
  cancelAttempt?: number;
  cancellationError?: string;
}

export interface TaskDispatchOptions {
  sessionKey?: string;
  sourceMessageId?: string;
  context?: string;
  /** Called when the server sent the request to the work pipeline instead of the seat. */
  onRedirect?: (redirect: { composerTaskId: string; reason: string }) => void;
}

/** New server-accepted tasks always carry these fields; TaskItem also reads legacy caches. */
export interface PersistentTaskItem extends TaskItem {
  agentId: string;
  runId: string | null;
  gatewayId: string;
  bindingRevision: number;
}

export interface ChatMessageBase {
  id: string;
  runId: string;
  timestamp: string;
  sessionKey: string;
  actorName?: string;
  source?: "voice" | "group";
  incidentId?: string;
  seatId?: string;
  taskId?: string;
  /** The assistant fragment was cut short by the user's interruption. */
  interrupted?: boolean;
}

interface TextChatMessage extends ChatMessageBase {
  role: "user" | "assistant" | "system";
  content: string;
  /** true while assistant message is still receiving streaming deltas */
  streaming?: boolean;
}

export interface ToolChatMessage extends ChatMessageBase {
  role: "tool";
  content: string;
  toolName: string;
  toolInput?: string;
  toolOutput?: string;
}

export type ChatMessage = TextChatMessage | ToolChatMessage;

export type AgentProvider = "openclaw" | "auggie" | "nightshift";

export interface GatewayConfig {
  url: string;
  provider?: AgentProvider;
}

export interface SessionMetrics {
  usedTokens?: number;
  maxContextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  fresh: boolean;
  model?: string;
  provider?: string;
  updatedAt?: string;
}

export interface SessionRecord {
  seatId?: string;
  agentId?: string;
  key: string;
  label?: string;
  createdAt: string;
}

export interface StudioSnapshot {
  connection: ConnectionStatus;
  seats: SeatState[];
  tasks: TaskItem[];
  chatMessages: ChatMessage[];
  activeSessionKey?: string;
  sessionMetrics: SessionMetrics;
  sessions: SessionRecord[];
  capabilities?: GatewayCapabilities;
  runtimeError?: string;
  /** Set when a seat request was sent to the verified work pipeline instead of the agent. */
  workRedirect?: { composerTaskId: string; reason: string };
  reviews?: ReviewRequest[];
  reviewRecovery?: Record<string, string>;
  management?: ManagementSnapshot;
  voice?: import("@/lib/voice/diagnostics-types").VoiceDiagnosticsSnapshot;
  sharedAgentId?: string;
  /** The seat that acts as office lead (Alice by default), when assigned. */
  officeLead?: { seatId: string; label: string } | null;
}

export interface ReviewQuestion {
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; value?: string; description?: string }>;
  multiSelect?: boolean;
  allowEmpty?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  secretStore?: unknown;
  resource?: unknown;
}
export interface ReviewRequest {
  id: string;
  backendId: string;
  kind: "approval" | "question";
  revision: number;
  status: "pending" | "submitting" | "outcome_unknown" | "resolved" | "expired";
  backendStatus: string;
  agentId?: string;
  sessionKey?: string;
  taskId?: string;
  association?: "run" | "session";
  expiresAtMs: number;
  error?: string;
  payload: {
    questions?: ReviewQuestion[];
    presentation?: {
      kind: string;
      commandText?: string;
      commandPreview?: string;
      title?: string;
      description?: string;
      detail?: string;
      warningText?: string;
      host?: string;
      scope?: unknown;
      allowedDecisions: string[];
      externalResolution?: { label: string; decisions: string[] };
    };
  };
}
export interface ManagementOperation {
  id: string;
  operationId: string;
  method: string;
  agentId?: string;
  sessionKey?: string;
  status: "sending" | "confirmed" | "rejected" | "outcome_unknown";
  error?: string;
}
export interface ManagementSnapshot {
  agents: AgentConfig[];
  operations: ManagementOperation[];
}
