import type { StructuredMode, Usage } from "../types.js";

export type CostSource = "provider" | "computed" | "unknown";

export type CostRecord = {
  readonly timestamp: string;
  readonly traceId: string;
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  readonly cost: number | null;
  readonly costSource: CostSource;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  readonly attempts: number;
  readonly failedOver: boolean;
  readonly structuredMode: StructuredMode | null;
  readonly repairAttempts: number;
  readonly content?: string;
};

export interface CostSink {
  write(record: CostRecord): void | Promise<void>;
}
