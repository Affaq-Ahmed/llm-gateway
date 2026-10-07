import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createGateway } from "../gateway.js";
import type { Provider } from "../providers/provider.js";
import { createOpenRouterProvider } from "../providers/openrouter.js";
import { ZERO_USAGE, type GatewayResponse } from "../types.js";
import type { CostRecord, CostSink } from "./types.js";

class MemorySink implements CostSink {
  readonly records: CostRecord[] = [];
  write(record: CostRecord): void {
    this.records.push(record);
  }
}

describe("gateway cost telemetry", () => {
  it("logs failed-but-billed structured attempts in one logical record", async () => {
    const sink = new MemorySink();
    const provider = fakeProvider(() => ({
      ...response(),
      text: JSON.stringify({ answer: "too long" }),
      usage: {
        ...ZERO_USAGE,
        outputTokens: 1_024,
        reasoningTokens: 1_024,
        totalTokens: 1_024,
      },
    }));
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openai: "gpt-5-mini" } },
      resilience: { retry: { maxAttempts: 1 } },
      costSink: sink,
      now: () => new Date("2026-09-01T00:00:00Z"),
    });

    await expect(
      gateway.complete({
        traceId: "failed-structured",
        messages: [{ role: "user", content: "SECRET_PROMPT" }],
        maxTokens: 32,
        responseSchema: z.object({ answer: z.string().max(3) }),
        structuredMode: "prompt",
      }),
    ).rejects.toThrow();

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      traceId: "failed-structured",
      provider: "openai",
      usage: { outputTokens: 2_048, reasoningTokens: 2_048 },
      cost: 0.004096,
      costSource: "computed",
      attempts: 2,
      structuredMode: "prompt",
      repairAttempts: 1,
    });
    expect(JSON.stringify(sink.records[0])).not.toContain("SECRET_PROMPT");
  });

  it("logs an errored stream with unknown cost when no usage arrives", async () => {
    const sink = new MemorySink();
    const provider = fakeProvider(
      () => response(),
      async function* () {
        throw new Error("stream broke");
      },
    );
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openai: "gpt-5-mini" } },
      resilience: { retry: { maxAttempts: 1 } },
      costSink: sink,
      now: () => new Date("2026-09-01T00:00:00Z"),
    });

    await expect(collect(gateway.stream({
      traceId: "broken-stream",
      messages: [{ role: "user", content: "hidden" }],
      maxTokens: 8,
    }))).rejects.toThrow();
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      traceId: "broken-stream",
      cost: null,
      costSource: "unknown",
    });
  });

  it("uses OpenRouter's provider-reported cost", async () => {
    const sink = new MemorySink();
    const provider = createOpenRouterProvider({
      apiKey: "fixture-key",
      fetch: async () => new Response(JSON.stringify({
        id: "gen-recorded",
        object: "chat.completion",
        created: 1_789_366_970,
        model: "anthropic/claude-haiku-4.5",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        }],
        usage: {
          prompt_tokens: 14,
          completion_tokens: 4,
          total_tokens: 18,
          cost: 0.000034,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openrouter: "anthropic/claude-haiku-4.5" } },
      costSink: sink,
      now: () => new Date("2026-09-01T00:00:00Z"),
    });

    await gateway.complete({
      traceId: "openrouter-cost",
      messages: [{ role: "user", content: "Reply ok." }],
      maxTokens: 16,
    });
    expect(sink.records[0]).toMatchObject({
      provider: "openrouter",
      cost: 0.000034,
      costSource: "provider",
    });
  });
});

function fakeProvider(
  complete: () => GatewayResponse,
  stream: Provider["stream"] = async function* () {},
): Provider {
  return {
    name: "openai",
    complete: async () => complete(),
    stream,
    supports: () => true,
  };
}

function response(): GatewayResponse {
  return {
    model: "openai:gpt-5-mini",
    provider: "openai",
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: ZERO_USAGE,
    attempts: 1,
    failedOver: false,
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
