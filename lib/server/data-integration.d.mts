import type { DataReader, DataReadScope } from "./data-source.mjs";
import type { EvidenceItem } from "../operations-contracts.mjs";
import type { OperationRecords } from "./operation-records.mjs";
import type { TaskRuntime } from "./task-runtime.mjs";

export function resolveDataTaskScope(
  runtime: TaskRuntime,
  records: OperationRecords,
  incidentId: string,
  taskId: string,
): DataReadScope;

export class DataEvidenceService {
  constructor(
    runtime: TaskRuntime,
    records: OperationRecords,
    reader: DataReader,
    options?: { clock?: () => Date },
  );
  read(input: {
    incidentId: string;
    taskId: string;
    templateId: string;
    parameters?: Record<string, string | number>;
    requestId?: string;
  }): Promise<{ evidence: EvidenceItem[]; auditRef: string; scope: DataReadScope }>;
}
