import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  SchemaConstraintError,
  SchemaValidationError,
  StructuredOutputError,
} from "./errors.js";
import { createGateway } from "./gateway.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import type {
  Provider,
  ProviderCompleteOptions,
} from "./providers/provider.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createOpenRouterProvider } from "./providers/openrouter.js";
import finding3 from "./providers/fixtures/finding-3-openai-length.json";
import finding4 from "./providers/fixtures/finding-4-anthropic-overlong.json";
import { jsonSchemaFor } from "./structured.js";
import {
  ZERO_USAGE,
  type GatewayRequest,
  type GatewayResponse,
} from "./types.js";

const Value = z.object({ value: z.string().max(5) });
const input = {
  messages: [{ role: "user", content: "Return a value." }],
  maxTokens: 32,
  responseSchema: Value,
} as const;

describe("structured outputs", () => {
  it("returns typed data in the provider's actual mode across all adapters", async () => {
    const cases = [
      {
        name: "anthropic",
        mode: "constrained",
        provider: createAnthropicProvider({ apiKey: "test", fetch: structuredFetch("anthropic") }),
      },
      {
        name: "openai",
        mode: "constrained",
        provider: createOpenAIProvider({ apiKey: "test", fetch: structuredFetch("openai") }),
      },
      {
        name: "openrouter",
        mode: "tool",
        provider: createOpenRouterProvider({ apiKey: "test", fetch: structuredFetch("openrouter") }),
      },
    ] as const;

    for (const testCase of cases) {
      const gateway = createGateway({
        providers: [testCase.provider],
        tiers: { fast: { [testCase.name]: "model" } },
        resilience: { retry: { maxAttempts: 1 } },
      });
      const result = await gateway.complete(input);
      expect(result.structured).toMatchObject({
        data: { value: "valid" },
        mode: testCase.mode,
        repairAttempts: 0,
      });
      expectTypeOf(result.structured?.data).toEqualTypeOf<
        { value: string } | undefined
      >();
    }
  });

  it("can force prompt mode on a constrained provider", async () => {
    const seen: ProviderCompleteOptions[] = [];
    const provider = fakeProvider("openai", true, async (_request, options) => {
      if (options !== undefined) seen.push(options);
      return response(
        "openai",
        seen.length === 1 ? "not json" : '{"value":"valid"}',
      );
    });
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openai: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    const result = await gateway.complete({ ...input, structuredMode: "prompt" });
    expect(result.structured).toMatchObject({
      mode: "prompt",
      repairAttempts: 1,
      data: { value: "valid" },
    });
    expect(seen[0]?.structured?.mode).toBe("prompt");
    expect(seen[1]?.structured?.repairPrompt).toContain("not valid JSON");
  });

  it("reports the mode that actually served after structured failover", async () => {
    const a = fakeProvider("a", true, async () =>
      response("a", '{"value":"too-long"}'),
    );
    const b = fakeProvider("b", false, async () => ({
      ...response("b", ""),
      toolCalls: [
        {
          id: "structured",
          name: "gateway_structured_output",
          args: { value: "valid" },
        },
      ],
      stopReason: "tool_use",
    }));
    const gateway = createGateway({
      providers: [a, b],
      tiers: { fast: { a: "model", b: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    await expect(gateway.complete(input)).resolves.toMatchObject({
      provider: "b",
      failedOver: true,
      structured: { data: { value: "valid" }, mode: "tool" },
    });
  });

  it("handles Anthropic integer bounds according to schemaPolicy", async () => {
    const Bounded = z.object({ count: z.number().int().min(1).max(5) });
    let calls = 0;
    const wireSchemas: unknown[] = [];
    const provider = fakeProvider("anthropic", true, async (_request, options) => {
      calls += 1;
      wireSchemas.push(options?.structured?.schema);
      return response(
        "anthropic",
        calls === 1 ? '{"count":9}' : '{"count":3}',
      );
    });

    const strict = createGateway({
      providers: [provider],
      tiers: { fast: { anthropic: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    await expect(strict.complete({ ...input, responseSchema: Bounded, schemaPolicy: "strict" }))
      .rejects.toBeInstanceOf(SchemaConstraintError);
    expect(calls).toBe(0);

    const relaxed = await strict.complete({
      ...input,
      responseSchema: Bounded,
      schemaPolicy: "relax",
    });
    expect(relaxed.structured).toMatchObject({
      data: { count: 3 },
      repairAttempts: 1,
      strippedConstraints: [
        "/properties/count/minimum",
        "/properties/count/maximum",
      ],
    });
    expect(calls).toBe(2);
    expect(JSON.stringify(wireSchemas)).not.toMatch(/"minimum"|"maximum"/);
  });

  it("replays Finding 4, repairs once, then returns the Zod issues", async () => {
    const Ticket = z.object({
      summary: z.string().max(120),
      sentiment: z.enum(["angry", "neutral", "pleased"]),
      urgency: z.number(),
      products: z.array(z.object({ name: z.string(), issue: z.string() })),
      refundAsk: z.number().nullable(),
    });
    const requestBodies: Array<Record<string, unknown>> = [];
    const provider = createAnthropicProvider({
      apiKey: "test",
      fetch: async (_request, init) => {
        requestBodies.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(JSON.stringify({
          id: "msg_finding_4",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: finding4.text, citations: null }],
          model: "model",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 662, output_tokens: 122 },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { anthropic: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });

    await expect(gateway.complete({ ...input, responseSchema: Ticket }))
      .rejects.toMatchObject({
        name: "AllProvidersFailedError",
        errors: [{ name: "SchemaValidationError", issues: [{ code: "too_big" }] }],
      });
    expect(requestBodies).toHaveLength(2);
    expect(JSON.stringify(requestBodies[0])).toContain('"maxLength":120');
    expect(JSON.stringify(requestBodies[1]?.messages)).toContain("too_big");
  });

  it("replays Finding 3 as a typed error instead of empty structured data", async () => {
    const provider = createOpenAIProvider({
      apiKey: "test",
      fetch: async () => new Response(JSON.stringify({
        id: "chat_finding_3",
        object: "chat.completion",
        created: 1,
        model: "model",
        choices: [{
          index: 0,
          finish_reason: finding3.finishReason,
          message: {
            role: "assistant",
            content: "",
            refusal: finding3.refusal,
            tool_calls: finding3.observedCalls,
          },
        }],
        usage: {
          prompt_tokens: finding3.usage.inputTokens,
          completion_tokens: finding3.usage.outputTokens,
          total_tokens: finding3.usage.totalTokens,
          completion_tokens_details: {
            reasoning_tokens: finding3.usage.reasoningTokens,
          },
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openai: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    await expect(gateway.complete({ ...input, structuredMode: "tool" }))
      .rejects.toMatchObject({
        name: "AllProvidersFailedError",
        errors: [{ name: "StructuredOutputError" }],
      });
  });

  it("uses a single forced OpenAI tool with parallel calls disabled", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl: typeof fetch = async (request, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return structuredFetch("openrouter")(request, init);
    };
    const gateway = createGateway({
      providers: [createOpenAIProvider({ apiKey: "test", fetch: fetchImpl })],
      tiers: { fast: { openai: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    await gateway.complete({ ...input, structuredMode: "tool" });
    expect(requestBody).toMatchObject({
      parallel_tool_calls: false,
      tool_choice: {
        type: "function",
        function: { name: "gateway_structured_output" },
      },
    });
    expect(requestBody?.tools).toHaveLength(1);
  });

  it("surfaces refusals as a stop reason instead of a parse error", async () => {
    const provider = fakeProvider("openai", true, async () => ({
      ...response("openai", ""),
      stopReason: "refusal",
    }));
    const gateway = createGateway({
      providers: [provider],
      tiers: { fast: { openai: "model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });
    const result = await gateway.complete(input);
    expect(result.stopReason).toBe("refusal");
    expect(result.structured).toBeUndefined();
  });

  it("caches each converted Zod schema by object identity", () => {
    expect(jsonSchemaFor(Value)).toBe(jsonSchemaFor(Value));
  });
});

function fakeProvider(
  name: string,
  constrainedJson: boolean,
  complete: Provider["complete"],
): Provider {
  return {
    name,
    complete,
    stream: async function* () {},
    supports: (feature) => feature === "constrainedJson" && constrainedJson,
  };
}

function response(provider: string, text: string): GatewayResponse {
  return {
    model: `${provider}:model`,
    provider,
    text,
    toolCalls: [],
    stopReason: "end_turn",
    usage: { ...ZERO_USAGE },
    attempts: 1,
    failedOver: false,
  };
}

function structuredFetch(
  provider: "anthropic" | "openai" | "openrouter",
): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (provider === "anthropic") {
      expect(body.output_config).toBeDefined();
      return new Response(JSON.stringify({
        id: "msg_structured",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '{"value":"valid"}', citations: null }],
        model: "model",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (provider === "openai") expect(body.response_format).toBeDefined();
    if (provider === "openrouter") {
      expect(body.parallel_tool_calls).toBe(false);
      expect(body.tool_choice).toBeDefined();
    }
    return new Response(JSON.stringify({
      id: "chat_structured",
      object: "chat.completion",
      created: 1,
      model: "model",
      choices: [{
        index: 0,
        finish_reason: provider === "openrouter" ? "tool_calls" : "stop",
        message: provider === "openrouter"
          ? {
              role: "assistant",
              content: null,
              refusal: null,
              tool_calls: [{
                id: "call_structured",
                type: "function",
                function: {
                  name: "gateway_structured_output",
                  arguments: '{"value":"valid"}',
                },
              }],
            }
          : { role: "assistant", content: '{"value":"valid"}', refusal: null },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
