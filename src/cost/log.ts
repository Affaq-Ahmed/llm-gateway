import { appendFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostRecord, CostSink } from "./types.js";
import { clean } from "./estimate.js";

export class JsonlCostSink implements CostSink {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  async write(record: CostRecord): Promise<void> {
    // A record is serialized with its newline and appended in one write call.
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export type TraceCost = {
  readonly traceId: string;
  readonly requests: number;
  readonly cost: number | null;
};

export type CostDistribution = {
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

export type CostSummary = {
  readonly tasks: readonly TraceCost[];
  readonly distribution: CostDistribution;
};

export function summarize(path: string): CostSummary {
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as CostRecord);
  const grouped = new Map<string, { requests: number; cost: number; unknown: boolean }>();
  for (const record of records) {
    const item = grouped.get(record.traceId) ?? { requests: 0, cost: 0, unknown: false };
    item.requests += 1;
    if (record.cost === null) item.unknown = true;
    else item.cost = clean(item.cost + record.cost);
    grouped.set(record.traceId, item);
  }
  const tasks = [...grouped].map(([traceId, item]) => ({
    traceId,
    requests: item.requests,
    cost: item.unknown ? null : item.cost,
  }));
  const known = tasks
    .flatMap((task) => task.cost === null ? [] : [task.cost])
    .sort((left, right) => left - right);
  if (known.length === 0) throw new Error(`No known costs in ${path}`);
  return {
    tasks,
    distribution: {
      min: known[0]!,
      p50: percentile(known, 0.5),
      p95: percentile(known, 0.95),
      max: known.at(-1)!,
    },
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]!;
}
