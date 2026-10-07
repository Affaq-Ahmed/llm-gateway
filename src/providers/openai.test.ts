import { describe, expect, it } from "vitest";
import { InvalidRequestError, OverloadedError } from "../errors.js";
import type { GatewayRequest } from "../types.js";
import { createFixtureFetch } from "./fixture-fetch.test-support.js";
import fixtures from "./fixtures/openai.json";
import {
  createOpenAIProvider,
  normalizeOpenAIStopReason,
} from "./openai.js";

const request = {
  model: "openai:gpt-5-mini",
  system: "Use tools when appropriate.",
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

describe("OpenAI provider", () => {
  it("normalizes a recorded Chat Completions tool response", async () => {
    const provider = createOpenAIProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });

    await expect(provider.complete(request)).resolves.toEqual({
      model: "openai:gpt-5-mini",
      provider: "openai",
      text: "",
      toolCalls: [
        {
          id: "call_order_1",
          name: "get_order",
          args: { orderId: "ORD-4471" },
        },
      ],
      stopReason: "tool_use",
      usage: {
        inputTokens: 225,
        outputTokens: 187,
        totalTokens: 412,
        reasoningTokens: 128,
        cachedInputTokens: 32,
        cacheCreationInputTokens: 0,
      },
      attempts: 1,
    });
    expect(provider.supports("cacheControl")).toBe(false);
    expect(provider.supports("constrainedJson")).toBe(true);
  });

  it("maps an SDK bad-request error inside the adapter", async () => {
    const provider = createOpenAIProvider({
      apiKey: "fixture-key",
      fetch: createFixtureFetch(fixtures),
    });

    const completion = provider.complete({
      model: "openai:gpt-5-mini",
      messages: [],
      maxTokens: 32,
    });

    await expect(completion).rejects.toMatchObject({
      name: "InvalidRequestError",
      provider: "openai",
      status: 400,
      retryable: false,
      failoverable: false,
    });
    await expect(completion).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("normalizes a token-limit stop at the adapter boundary", () => {
    expect(normalizeOpenAIStopReason("length")).toBe("max_tokens");
  });

  it("keys fixtures by the whole request", async () => {
    const fixture = fixtures[0];
    if (!fixture) throw new Error("Expected an OpenAI fixture");
    const fetchFixture = createFixtureFetch(fixtures);

    const changedBody = {
      ...fixture.request.body,
      max_completion_tokens: 3_999,
    };

    await expect(
      fetchFixture(fixture.request.url, {
        method: fixture.request.method,
        body: JSON.stringify(changedBody),
      }),
    ).rejects.toThrow("No recorded fixture for request");
  });

  it("does not let the SDK retry provider failures", async () => {
    let calls = 0;
    const provider = createOpenAIProvider({
      apiKey: "fixture-key",
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ error: { message: "overloaded" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      },
    });

    await expect(
      provider.complete({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
        maxTokens: 16,
      }),
    ).rejects.toBeInstanceOf(OverloadedError);
    expect(calls).toBe(1);
  });
});
