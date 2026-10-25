import type { VerificationResult } from "../operations-contracts.mjs";
import type { OperationRecords } from "./operation-records.mjs";
import type { TaskRuntime } from "./task-runtime.mjs";

export class TrustedVerificationService {
  constructor(runtime: TaskRuntime, records: OperationRecords, options?: { clock?: () => Date });
  record(input: {
    verification: VerificationResult;
    lesson?: { content: string; applicability: string };
  }): {
    verification: VerificationResult;
    revision: number;
    lesson: {
      id: string;
      source: { taskId: string; incidentId: string; verificationId: string; evidenceIds: string[] };
    } | null;
  };
}
