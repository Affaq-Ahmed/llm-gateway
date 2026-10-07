import type { Usage } from "../types.js";
import { rateFor } from "./pricing.js";

export type CacheTtl = "5m" | "1h";
export type CostBreakdown = {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
};
export type CostEstimate = {
  readonly cost: number;
  readonly breakdown: CostBreakdown;
  readonly source: "computed";
};

export function estimateCost(
  usage: Usage,
  model: string,
  at: Date,
  options: { readonly cacheTtl?: CacheTtl } = {},
): CostEstimate {
  const rate = rateFor(model, at);
  const inclusiveCachedInput = usage.cacheCreationInputTokens === 0 &&
    usage.inputTokens >= usage.cachedInputTokens;
  const inputTokens = inclusiveCachedInput
    ? usage.inputTokens - usage.cachedInputTokens
    : usage.inputTokens;
  const writeRate = options.cacheTtl === "1h"
    ? rate.cacheWrite1h
    : rate.cacheWrite5m;
  const breakdown = {
    input: dollars(inputTokens, rate.inputPerMTok),
    // reasoningTokens is a breakdown of outputTokens, never a fifth term.
    output: dollars(usage.outputTokens, rate.outputPerMTok),
    cacheWrite: dollars(usage.cacheCreationInputTokens, writeRate),
    cacheRead: dollars(usage.cachedInputTokens, rate.cacheRead),
  };
  return {
    cost: clean(
      breakdown.input + breakdown.output + breakdown.cacheWrite + breakdown.cacheRead,
    ),
    breakdown,
    source: "computed",
  };
}

function dollars(tokens: number, rate: number): number {
  return clean((tokens * rate) / 1_000_000);
}

export function clean(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
