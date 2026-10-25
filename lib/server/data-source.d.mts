import type { EvidenceItem } from "../operations-contracts";

export interface DataReadScope {
  incidentId: string;
  taskId: string;
  /** Caller must obtain this identity from the server's verified task binding. */
  agentId: string;
  seatId: string;
  gatewayId: string;
  sessionKey: string;
  bindingRevision: number;
}

export interface ReadTemplate {
  id: string;
  source: string;
  sql: string;
  parameters?: Record<string, "text" | "integer">;
  recordIdField: string;
  timestampField?: string;
  fields: string[];
  maxAgeMs?: number;
}

export interface DataReader {
  /** Server-owned service identity; synthetic fixtures never advertise a live service. */
  serviceId?: "zetaris" | null;
  read(input: {
    templateId: string;
    parameters?: Record<string, string | number>;
    scope: DataReadScope;
  }): Promise<{ evidence: EvidenceItem[]; scope: DataReadScope; mode: "zetaris" | "synthetic" }>;
}

export function compileReadQuery(
  template: ReadTemplate,
  parameters?: Record<string, string | number>,
): string;
export function createDataReader(input: {
  mode: "zetaris" | "synthetic";
  templates: Record<string, ReadTemplate>;
  zetaris?: {
    query(input: {
      templateId: string;
      sql: string;
      parameters: Record<string, string | number>;
    }): Promise<unknown[]>;
  };
  synthetic?: {
    query(input: {
      templateId: string;
      sql: string;
      parameters: Record<string, string | number>;
    }): Promise<unknown[]>;
  };
  now?: () => Date;
}): DataReader;
