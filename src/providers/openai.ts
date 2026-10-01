import OpenAI from "openai";
import { GatewayError, toGatewayError } from "../errors.js";
import {
  ZERO_USAGE,
  type GatewayMessage,
  type GatewayRequest,
  type GatewayResponse,
  type JsonSchema,
  type StopReason,
  type ToolCall,
  type Usage,
} from "../types.js";
import {
  streamNotImplemented,
  type Provider,
  type ProviderFeature,
} from "./provider.js";

const REASONING_MIN_COMPLETION_TOKENS = 4_000;

// The SDK requires a non-negative integer and implements 0 as an immediate
// timer. Use the largest timer Node supports so gateway deadlines own timing.
const SDK_TIMEOUT_DISABLED_MS = 2_147_483_647;

export type OpenAIProviderOptions = {
  readonly name?: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly constrainedJson?: boolean;
};

export function createOpenAIProvider(
  options: OpenAIProviderOptions = {},
): Provider {
  const name = options.name ?? "openai";
  const client = new OpenAI({
    maxRetries: 0,
    timeout: SDK_TIMEOUT_DISABLED_MS,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.defaultHeaders === undefined
      ? {}
      : { defaultHeaders: options.defaultHeaders }),
  });

  return {
    name,

    async complete(request) {
      try {
        const response = await client.chat.completions.create(
          toOpenAIRequest(request, name, options.constrainedJson ?? true),
          request.signal === undefined ? {} : { signal: request.signal },
        );
        return fromOpenAIResponse(request, name, response);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof OpenAI.APIError) {
          throw toGatewayError(
            name,
            error.status ?? null,
            error.headers,
            error,
          );
        }
        throw toGatewayError(name, null, undefined, error);
      }
    },

    stream() {
      return streamNotImplemented(name);
    },

    supports(feature: ProviderFeature) {
      if (feature === "cacheControl") return false;
      return options.constrainedJson ?? true;
    },
  };
}

function toOpenAIRequest(
  request: GatewayRequest,
  provider: string,
  constrainedJson: boolean,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const model = modelForProvider(request, provider);
  if (request.responseSchema !== undefined && !constrainedJson) {
    throw toGatewayError(
      provider,
      400,
      undefined,
      new Error(`${provider} does not advertise constrained JSON support`),
    );
  }
  const messages = toOpenAIMessages(request.messages);
  if (request.system !== undefined) {
    messages.unshift({ role: "system", content: request.system });
  }

  return {
    model,
    messages,
    max_completion_tokens: completionBudget(model, request.maxTokens),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              ...(tool.description === undefined
                ? {}
                : { description: tool.description }),
              parameters: schemaForSdk(tool.inputSchema),
              strict: true,
            },
          })),
        }),
    ...(request.responseSchema === undefined
      ? {}
      : {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: "gateway_response",
              strict: true,
              schema: schemaForSdk(request.responseSchema),
            },
          },
        }),
  };
}

function toOpenAIMessages(
  messages: readonly GatewayMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user", content: message.content };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              type: "function" as const,
              id: call.id,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            })),
          }),
    };
  });
}

function fromOpenAIResponse(
  request: GatewayRequest,
  provider: string,
  response: OpenAI.Chat.Completions.ChatCompletion,
): GatewayResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error(`${provider} returned no completion choices`);
  }

  return {
    model: request.model,
    provider,
    text: choice.message.content ?? "",
    toolCalls: extractOpenAIToolCalls(choice.message),
    stopReason: normalizeOpenAIStopReason(choice.finish_reason),
    usage: response.usage === undefined ? ZERO_USAGE : openAIUsage(response.usage),
  };
}

function extractOpenAIToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
): ToolCall[] {
  return (
    message.tool_calls?.flatMap((call) => {
      if (call.type !== "function") return [];
      return [
        {
          id: call.id,
          name: call.function.name,
          args: parseArguments(call.function.arguments),
        },
      ];
    }) ?? []
  );
}

function parseArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
}

export function normalizeOpenAIStopReason(reason: string): StopReason {
  if (reason === "stop") return "end_turn";
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "unknown";
}

function openAIUsage(usage: OpenAI.Completions.CompletionUsage): Usage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationInputTokens:
      usage.prompt_tokens_details?.cache_write_tokens ?? 0,
  };
}

function completionBudget(model: string, requested: number): number {
  return isReasoningModel(model)
    ? Math.max(requested, REASONING_MIN_COMPLETION_TOKENS)
    : requested;
}

function isReasoningModel(model: string): boolean {
  return /(?:^|[/:-])(?:o[134](?:-|$)|gpt-[5-9](?:-|$))/i.test(model);
}

function modelForProvider(request: GatewayRequest, provider: string): string {
  const separator = request.model.indexOf(":");
  const requestProvider = request.model.slice(0, separator);
  const model = request.model.slice(separator + 1);

  if (requestProvider !== provider || model === "") {
    throw toGatewayError(
      provider,
      400,
      undefined,
      new Error(`Expected model in the form ${provider}:model`),
    );
  }

  return model;
}

function schemaForSdk(schema: JsonSchema): Record<string, unknown> {
  return { ...schema };
}
