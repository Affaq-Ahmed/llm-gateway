import { describe, expect, expectTypeOf, it } from "vitest";
import { ZERO_USAGE } from "./types.js";
import type {
  GatewayRequest,
  GatewayResponse,
  ModelId,
  StreamEvent,
  Usage,
  ZeroUsage,
} from "./types.js";

describe("public gateway types", () => {
  it("describe a provider-qualified request and complete response", () => {
    const request = {
      model: "openai:gpt-5-mini",
      messages: [{ role: "user", content: "Reply with one word." }],
      system: "Be concise.",
      maxTokens: 16,
      traceId: "readme-quickstart",
    } satisfies GatewayRequest;

    const response = {
      model: request.model,
      provider: "openai",
      text: "Done",
      toolCalls: [],
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 1,
        totalTokens: 13,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    } satisfies GatewayResponse;

    expectTypeOf(request.model).toMatchTypeOf<ModelId>();
    expectTypeOf(response.usage).toMatchTypeOf<Usage>();
    expectTypeOf<GatewayResponse>().toMatchTypeOf<{ usage: Usage }>();
    expectTypeOf<Extract<StreamEvent, { type: "error" }>["usage"]>()
      .toEqualTypeOf<ZeroUsage>();
    expect(response.usage.totalTokens).toBe(13);
  });

  it("requires zero usage on stream errors", () => {
    const event = {
      type: "error",
      error: new Error("provider disconnected"),
      usage: ZERO_USAGE,
    } satisfies StreamEvent;

    expect(event.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});
