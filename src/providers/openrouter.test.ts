import { describe, expect, it } from "vitest";
import { InvalidRequestError } from "../errors.js";
import type { GatewayRequest } from "../types.js";
import { createFixtureFetch } from "./fixture-fetch.test-support.js";
import fixtures from "./fixtures/openrouter.json";
import { createOpenRouterProvider } from "./openrouter.js";

const request = {
  model: "openrouter:openai/gpt-5-mini",
  messages: [{ role: "user", content: "Find order ORD-4471." }],
  maxTokens: 32,
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

describe("OpenRouter provider", () => {
  it("reuses Chat Completions normalization and forwards strict tools", async () => {
    const provider = createOpenRouterProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });

    await expect(provider.complete(request)).resolves.toEqual({
      model: "openrouter:openai/gpt-5-mini",
      provider: "openrouter",
      text: "",
      toolCalls: [
        {
          id: "call_openrouter_order_1",
          name: "get_order",
          args: { orderId: "ORD-4471" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 31,
        outputTokens: 19,
        totalTokens: 50,
        reasoningTokens: 8,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      attempts: 1,
      failedOver: false,
    });
    expect(provider.supports("cacheControl")).toBe(false);
    expect(provider.supports("constrainedJson")).toBe(false);
  });

  it("maps an SDK bad-request error inside the composed adapter", async () => {
    const provider = createOpenRouterProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });
    const completion = provider.complete({
      model: "openrouter:openai/gpt-5-mini",
      messages: [],
      maxTokens: 16,
    });

    await expect(completion).rejects.toMatchObject({
      name: "InvalidRequestError",
      provider: "openrouter",
      status: 400,
      retryable: false,
      failoverable: false,
    });
    await expect(completion).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("rejects constrained JSON until OpenRouter forwarding is verified", async () => {
    const provider = createOpenRouterProvider({ apiKey: "fixture-key" });

    await expect(
      provider.complete({
        model: "openrouter:openai/gpt-5-mini",
        messages: [{ role: "user", content: "Return JSON" }],
        maxTokens: 16,
        responseSchema: { type: "object" },
      }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
