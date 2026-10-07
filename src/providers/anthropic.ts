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
  StreamEvent,
} from "../types.js";
import { ZERO_USAGE } from "../types.js";
import {
  type Provider,
  type ProviderFeature,
  type StreamActivityHooks,
} from "./provider.js";
import { observeResponseBytes } from "./stream-activity.js";
import { timeoutFromSignal } from "../timeouts.js";

const SDK_TIMEOUT_DISABLED_MS = 2_147_483_647;

export type AnthropicProviderOptions = {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
};

export function createAnthropicProvider(
  options: AnthropicProviderOptions = {},
): Provider {
  const name = "anthropic";
  const client = createAnthropicClient(options);

  return {
    name,

    async complete(request, activity) {
      try {
        const requestClient = activity?.onBytes === undefined
          ? client
          : createAnthropicClient(
              options,
              observeResponseBytes(
                options.fetch ?? globalThis.fetch,
                activity.onBytes,
              ),
            );
        const response = await requestClient.messages.create(
          toAnthropicRequest(request),
          request.signal === undefined ? {} : { signal: request.signal },
        );
        return fromAnthropicResponse(request, response);
      } catch (error) {
        const timeout = request.signal === undefined
          ? undefined
          : timeoutFromSignal(request.signal);
        if (timeout !== undefined) throw timeout;
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

    stream(request, activity) {
      const streamClient = activity?.onBytes === undefined
        ? client
        : createAnthropicClient(
            options,
            observeResponseBytes(
              options.fetch ?? globalThis.fetch,
              activity.onBytes,
            ),
          );
      return streamAnthropic(streamClient, request, activity);
    },

    supports(feature: ProviderFeature) {
      return feature === "cacheControl" || feature === "constrainedJson";
    },
  };
}

function createAnthropicClient(
  options: AnthropicProviderOptions,
  fetchOverride?: typeof fetch,
): Anthropic {
  return new Anthropic({
    maxRetries: 0,
    timeout: SDK_TIMEOUT_DISABLED_MS,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(fetchOverride === undefined
      ? options.fetch === undefined
        ? {}
        : { fetch: options.fetch }
      : { fetch: fetchOverride }),
  });
}

async function* streamAnthropic(
  client: Anthropic,
  request: GatewayRequest,
  activity?: StreamActivityHooks,
): AsyncIterable<StreamEvent> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const signal = request.signal === undefined
    ? controller.signal
    : AbortSignal.any([request.signal, controller.signal]);
  let ttftMs: number | null = null;
  let usage: Usage = ZERO_USAGE;
  let stopReason: StopReason = "unknown";
  const tools = new Map<
    number,
    {
      id: string;
      name: string;
      argumentsJson: string;
      initialInput: unknown;
    }
  >();

  try {
    const stream = await client.messages.create(
      { ...toAnthropicRequest(request), stream: true },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "message_start") {
        usage = anthropicUsage(event.message.usage);
      } else if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        tools.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          argumentsJson: "",
          initialInput: event.content_block.input,
        });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta" && event.delta.text !== "") {
          activity?.onContent?.();
          ttftMs ??= performance.now() - startedAt;
          yield { type: "text", delta: event.delta.text };
        } else if (
          event.delta.type === "input_json_delta" &&
          event.delta.partial_json !== ""
        ) {
          activity?.onContent?.();
          const tool = tools.get(event.index);
          if (tool !== undefined) tool.argumentsJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        const tool = tools.get(event.index);
        if (tool !== undefined) {
          tools.delete(event.index);
          yield {
            type: "tool_call",
            id: tool.id,
            name: tool.name,
            args:
              tool.argumentsJson === ""
                ? tool.initialInput
                : parseAnthropicArguments(tool.argumentsJson),
          };
        }
      } else if (event.type === "message_delta") {
        stopReason = normalizeAnthropicStopReason(event.delta.stop_reason);
        usage = mergeAnthropicStreamUsage(usage, event.usage);
      }
    }

    const timeout = timeoutFromSignal(signal);
    if (timeout !== undefined) throw timeout;

    for (const tool of tools.values()) {
      yield {
        type: "tool_call",
        id: tool.id,
        name: tool.name,
        args:
          tool.argumentsJson === ""
            ? tool.initialInput
            : parseAnthropicArguments(tool.argumentsJson),
      };
    }
    yield { type: "done", stopReason, usage, ttftMs, attempts: 1 };
  } catch (error) {
    const timeout = timeoutFromSignal(signal);
    const mapped = timeout ?? (error instanceof GatewayError
      ? error
      : error instanceof Anthropic.APIError
        ? toGatewayError("anthropic", error.status ?? null, error.headers, error)
        : toGatewayError("anthropic", null, undefined, error));
    yield { type: "error", error: mapped, usage: ZERO_USAGE };
  } finally {
    controller.abort();
  }
}

function parseAnthropicArguments(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return argumentsJson;
  }
}

function mergeAnthropicStreamUsage(
  previous: Usage,
  terminal: Anthropic.MessageDeltaUsage,
): Usage {
  const inputTokens = terminal.input_tokens ?? previous.inputTokens;
  const outputTokens = terminal.output_tokens;
  const cachedInputTokens =
    terminal.cache_read_input_tokens ?? previous.cachedInputTokens;
  const cacheCreationInputTokens =
    terminal.cache_creation_input_tokens ?? previous.cacheCreationInputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens,
    reasoningTokens:
      terminal.output_tokens_details?.thinking_tokens ??
      previous.reasoningTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
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
    attempts: 1,
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
