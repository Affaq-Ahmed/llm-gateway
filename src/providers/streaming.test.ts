import { describe, expect, it } from "vitest";
import type { GatewayRequest, Usage } from "../types.js";
import { ZERO_USAGE } from "../types.js";
import { createAnthropicProvider } from "./anthropic.js";
import { consumeStream } from "./consume-stream.test-support.js";
import {
  createStreamingFixtureFetch,
  type RecordedStreamFixture,
} from "./fixture-fetch.test-support.js";
import anthropicFixtureJson from "./fixtures/anthropic-stream.json";
import openAIFixtureJson from "./fixtures/openai-stream.json";
import openRouterFixtureJson from "./fixtures/openrouter-stream.json";
import { createOpenAIProvider } from "./openai.js";
import { createOpenRouterProvider } from "./openrouter.js";

const anthropicFixture = anthropicFixtureJson as RecordedStreamFixture;
const openAIFixture = openAIFixtureJson as RecordedStreamFixture;
const openRouterFixture = openRouterFixtureJson as RecordedStreamFixture;

const cases = [
  {
    provider: createAnthropicProvider({
      apiKey: "fixture-key",
      fetch: createStreamingFixtureFetch(anthropicFixture),
    }),
    request: {
      model: "anthropic:claude-haiku-4-5",
      messages: [{ role: "user", content: "Say hi." }],
      maxTokens: 16,
    } satisfies GatewayRequest,
    usage: {
      inputTokens: 8,
      outputTokens: 2,
      totalTokens: 13,
      reasoningTokens: 0,
      cachedInputTokens: 1,
      cacheCreationInputTokens: 2,
    } satisfies Usage,
  },
  {
    provider: createOpenAIProvider({
      apiKey: "fixture-key",
      fetch: createStreamingFixtureFetch(openAIFixture),
    }),
    request: {
      model: "openai:gpt-4o-mini",
      messages: [{ role: "user", content: "Use both tools." }],
      maxTokens: 32,
    } satisfies GatewayRequest,
    usage: {
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      reasoningTokens: 2,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 0,
    } satisfies Usage,
  },
  {
    provider: createOpenRouterProvider({
      apiKey: "fixture-key",
      fetch: createStreamingFixtureFetch(openRouterFixture),
    }),
    request: {
      model: "openrouter:openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say hi." }],
      maxTokens: 16,
    } satisfies GatewayRequest,
    usage: {
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
    } satisfies Usage,
  },
] as const;

describe("normalized provider streaming", () => {
  it.each(cases)("drives $provider.name through one consumer", async ({ provider, request, usage }) => {
    const events = await consumeStream(provider, request);
    expect(events.at(-1)).toMatchObject({ type: "done", usage });
    expect(events.some((event) => event.type === "text")).toBe(true);
  });

  it("assembles interleaved parallel tool calls by index", async () => {
    const openAI = cases[1];
    const events = await consumeStream(openAI.provider, openAI.request);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_a", name: "first", args: { x: 1 } },
      { type: "tool_call", id: "call_b", name: "second", args: { y: 2 } },
    ]);
  });

  it("aborts the SDK request when the consumer breaks early", async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const provider = createOpenAIProvider({
      apiKey: "fixture-key",
      fetch: createStreamingFixtureFetch(openAIFixture, (signal) => { observed.signal = signal; }),
    });
    for await (const event of provider.stream(cases[1].request)) {
      if (event.type === "text") break;
    }
    expect(observed.signal?.aborted).toBe(true);
  });

  it("separates byte activity from content activity", async () => {
    let bytes = 0;
    let content = 0;
    const anthropic = cases[0];
    for await (const _event of anthropic.provider.stream(anthropic.request, {
      onBytes: () => { bytes += 1; },
      onContent: () => { content += 1; },
    })) {
      // consume
    }
    expect(bytes).toBe(7);
    expect(content).toBe(1);
  });

  it.each(cases)("emits a taxonomy error with zero usage for malformed $provider.name requests", async ({ provider }) => {
    const events = await consumeStream(provider, {
      model: "wrong:model",
      messages: [],
      maxTokens: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      error: { name: "InvalidRequestError", retryable: false },
      usage: ZERO_USAGE,
    });
  });
});
