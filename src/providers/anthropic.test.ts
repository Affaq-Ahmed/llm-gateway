import { describe, expect, it } from "vitest";
import { InvalidRequestError, OverloadedError } from "../errors.js";
import type { GatewayRequest } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createFixtureFetch } from "./fixture-fetch.test-support.js";
import fixtures from "./fixtures/anthropic.json";

const request = {
  model: "anthropic:claude-haiku-4-5",
  system: "Use tools when appropriate.",
  messages: [{ role: "user", content: "Find order ORD-4471." }],
  maxTokens: 1_024,
  cacheHint: { type: "ephemeral", ttl: "5m" },
  tools: [
    {
      name: "get_order",
      description: "Look up an order.",
      inputSchema: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  ],
} satisfies GatewayRequest;

describe("Anthropic provider", () => {
  it("normalizes a recorded Messages API tool response", async () => {
    const provider = createAnthropicProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });

    await expect(provider.complete(request)).resolves.toEqual({
      model: "anthropic:claude-haiku-4-5",
      provider: "anthropic",
      text: "I'll look that up.",
      toolCalls: [
        {
          id: "toolu_order_1",
          name: "get_order",
          args: { orderId: "ORD-4471" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 763,
        outputTokens: 116,
        totalTokens: 975,
        reasoningTokens: 16,
        cachedInputTokens: 32,
        cacheCreationInputTokens: 64,
      },
      attempts: 1,
    });
    expect(provider.supports("cacheControl")).toBe(true);
    expect(provider.supports("constrainedJson")).toBe(true);
  });

  it("maps an SDK bad-request error inside the adapter", async () => {
    const provider = createAnthropicProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });
    const completion = provider.complete({
      model: "anthropic:claude-haiku-4-5",
      messages: [],
      maxTokens: 16,
    });

    await expect(completion).rejects.toMatchObject({
      name: "InvalidRequestError",
      provider: "anthropic",
      status: 400,
      retryable: false,
      failoverable: false,
    });
    await expect(completion).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("does not let the SDK retry provider failures", async () => {
    let calls = 0;
    const provider = createAnthropicProvider({
      apiKey: "fixture-key",
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "overloaded_error", message: "overloaded" },
          }),
          { status: 529, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.complete({
        model: "anthropic:claude-haiku-4-5",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 16,
      }),
    ).rejects.toBeInstanceOf(OverloadedError);
    expect(calls).toBe(1);
  });
});
