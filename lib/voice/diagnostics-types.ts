export interface VoiceUsage {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}

export interface VoiceCallRecord {
  id: string;
  name: string;
  seatId: string;
  sessionKey: string;
  model?: string;
  apiVersion?: string;
  createdAt: string;
  updatedAt?: string;
  endedAt?: string;
  status?: "provisioned" | "connected" | "ended" | "error";
  durationMs?: number;
  diagnostic?: {
    code: string;
    phase: string;
    message: string;
    httpStatus?: number;
    closeCode?: number;
  };
  usageReports?: Array<{ sequence: number; reportedAt: string; usage: VoiceUsage }>;
}

export interface VoiceDiagnosticsSnapshot {
  billingNotice: string;
  calls: VoiceCallRecord[];
}
