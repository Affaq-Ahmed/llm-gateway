import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCost } from "./estimate.js";
import { JsonlCostSink, summarize } from "./log.js";
import { rateFor } from "./pricing.js";
import { ZERO_USAGE, type Usage } from "../types.js";

const cachedAnthropicUsage: Usage = {
  inputTokens: 18,
  outputTokens: 88,
  totalTokens: 3_086,
  reasoningTokens: 0,
  cachedInputTokens: 2_980,
  cacheCreationInputTokens: 0,
};

describe("estimateCost", () => {
  it("matches the recorded Anthropic cache-read calculation", () => {
    expect(
      estimateCost(
        cachedAnthropicUsage,
        "claude-sonnet-4-5",
        new Date("2026-09-01T00:00:00Z"),
      ),
    ).toEqual({
      cost: 0.002268,
      breakdown: {
        input: 0.000054,
        output: 0.00132,
        cacheWrite: 0,
        cacheRead: 0.000894,
      },
      source: "computed",
    });
  });

  it("treats reasoning as an output breakdown, not extra output", () => {
    const estimate = estimateCost(
      {
        ...ZERO_USAGE,
        outputTokens: 1_024,
        reasoningTokens: 1_024,
        totalTokens: 1_024,
      },
      "gpt-5-mini",
      new Date("2026-09-01T00:00:00Z"),
    );
    expect(estimate.breakdown.output).toBe(0.002048);
    expect(estimate.cost).toBe(0.002048);
  });

  it("selects different Sonnet rates on either side of 1 September", () => {
    const august = rateFor("claude-sonnet-5", new Date("2026-08-31T23:59:59Z"));
    const september = rateFor("claude-sonnet-5", new Date("2026-09-01T00:00:00Z"));
    expect(august).not.toEqual(september);
    expect(august.cacheRead).toBe(0.2);
    expect(september.cacheRead).toBe(0.3);
  });
});

describe("JSONL cost telemetry", () => {
  it("writes one content-free line per call and summarizes trace totals", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "gateway-cost-")), "calls.jsonl");
    const sink = new JsonlCostSink(path);
    const base = {
      timestamp: "2026-09-01T00:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      usage: ZERO_USAGE,
      costSource: "computed" as const,
      latencyMs: 10,
      ttftMs: null,
      attempts: 1,
      failedOver: false,
      structuredMode: null,
      repairAttempts: 0,
    };
    await sink.write({ ...base, traceId: "multi", cost: 0.01 });
    await sink.write({ ...base, traceId: "multi", cost: 0.02 });
    await sink.write({ ...base, traceId: "a", cost: 0.04 });
    await sink.write({ ...base, traceId: "b", cost: 0.08 });
    await sink.write({ ...base, traceId: "c", cost: 0.16 });

    const raw = readFileSync(path, "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(5);
    expect(raw).not.toContain("messages");
    expect(raw).not.toContain("content");
    expect(summarize(path).distribution).toEqual({
      min: 0.03,
      p50: 0.04,
      p95: 0.16,
      max: 0.16,
    });
  });
});
