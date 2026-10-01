import Anthropic from "@anthropic-ai/sdk";
import { GatewayError, toGatewayError } from "../errors.js";
import type {
  CacheHint,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  JsonSchema,
  StopReason,
  ToolCall,
  Usage,
} from "../types.js";
import {
  streamNotImplemented,
  type Provider,
  type ProviderFeature,
} from "./provider.js";

const SDK_TIMEOUT_DISABLED_MS = 2_147_483_647;

export type AnthropicProviderOptions = {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
};

export function createAnthropicProvider(
  options: AnthropicProviderOptions = {},
): Provider {
  const name = "anthropic";
  const client = new Anthropic({
    maxRetries: 0,
    timeout: SDK_TIMEOUT_DISABLED_MS,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    name,

    async complete(request) {
      try {
        const response = await client.messages.create(
          toAnthropicRequest(request),
          request.signal === undefined ? {} : { signal: request.signal },
        );
        return fromAnthropicResponse(request, response);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof Anthropic.APIError) {
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
      return feature === "cacheControl" || feature === "constrainedJson";
    },
  };
}

function toAnthropicRequest(
  request: GatewayRequest,
): Anthropic.MessageCreateParamsNonStreaming {
  const model = modelForAnthropic(request);
  const tools = toAnthropicTools(request);
  const cacheSystem = request.cacheHint !== undefined && tools === undefined;

  return {
    model,
    max_tokens: request.maxTokens,
    messages: toAnthropicMessages(
      request.messages,
      cacheSystem && request.system === undefined ? request.cacheHint : undefined,
    ),
    ...(request.system === undefined
      ? {}
      : {
          system: cacheSystem
            ? [
                {
                  type: "text" as const,
                  text: request.system,
                  cache_control: request.cacheHint,
                },
              ]
            : request.system,
        }),
    ...(tools === undefined ? {} : { tools }),
    ...(request.responseSchema === undefined
      ? {}
      : {
          output_config: {
            format: {
              type: "json_schema" as const,
              schema: schemaForSdk(request.responseSchema),
            },
          },
        }),
  };
}

function toAnthropicMessages(
  messages: readonly GatewayMessage[],
  cacheLastMessage?: CacheHint,
): Anthropic.MessageParam[] {
  const lastIndex = messages.length - 1;

  return messages.map((message, index) => {
    if (message.role === "user") {
      return {
        role: "user",
        content:
          cacheLastMessage !== undefined && index === lastIndex
            ? [
                {
                  type: "text",
                  text: message.content,
                  cache_control: cacheLastMessage,
                },
              ]
            : message.content,
      };
    }

    if (message.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
            ...(message.isError === undefined
              ? {}
              : { is_error: message.isError }),
          },
        ],
      };
    }

    const content: Anthropic.ContentBlockParam[] = [];
    if (message.content !== "") {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.args,
      });
    }
    return { role: "assistant", content };
  });
}

function toAnthropicTools(
  request: GatewayRequest,
): Anthropic.Tool[] | undefined {
  const gatewayTools = request.tools;
  if (gatewayTools === undefined) return undefined;

  return gatewayTools.map((tool, index) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: {
      ...schemaForSdk(tool.inputSchema),
      type: "object" as const,
    },
    strict: true,
    ...(request.cacheHint !== undefined && index === gatewayTools.length - 1
      ? { cache_control: request.cacheHint }
      : {}),
  }));
}

function fromAnthropicResponse(
  request: GatewayRequest,
  response: Anthropic.Message,
): GatewayResponse {
  const text = response.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls: ToolCall[] = response.content.flatMap((block) =>
    block.type === "tool_use"
      ? [{ id: block.id, name: block.name, args: block.input }]
      : [],
  );

  return {
    model: request.model,
    provider: "anthropic",
    text,
    toolCalls,
    stopReason: normalizeAnthropicStopReason(response.stop_reason),
    usage: anthropicUsage(response.usage),
  };
}

function normalizeAnthropicStopReason(
  reason: Anthropic.Message["stop_reason"],
): StopReason {
  if (reason === "end_turn") return "end_turn";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "unknown";
}

function anthropicUsage(usage: Anthropic.Usage): Usage {
  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens:
      usage.input_tokens +
      usage.output_tokens +
      cacheCreationInputTokens +
      cachedInputTokens,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    cachedInputTokens,
    cacheCreationInputTokens,
  };
}

function modelForAnthropic(request: GatewayRequest): string {
  const separator = request.model.indexOf(":");
  const provider = request.model.slice(0, separator);
  const model = request.model.slice(separator + 1);

  if (provider !== "anthropic" || model === "") {
    throw toGatewayError(
      "anthropic",
      400,
      undefined,
      new Error("Expected model in the form anthropic:model"),
    );
  }

  return model;
}

function schemaForSdk(schema: JsonSchema): Record<string, unknown> {
  return { ...schema };
}
