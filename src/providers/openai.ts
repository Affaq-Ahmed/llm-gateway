import OpenAI from "openai";
import {
  GatewayError,
  SchemaConstraintError,
  toGatewayError,
} from "../errors.js";
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
  type Provider,
  type ProviderFeature,
  type StructuredExecution,
  type StreamActivityHooks,
} from "./provider.js";
import { observeResponseBytes } from "./stream-activity.js";
import { timeoutFromSignal } from "../timeouts.js";
import { STRUCTURED_TOOL_NAME } from "../structured.js";

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
  const client = createOpenAIClient(options);

  return {
    name,

    async complete(request, completeOptions) {
      if (
        request.responseSchema !== undefined &&
        completeOptions?.structured === undefined
      ) {
        throw new SchemaConstraintError(name, [
          "responseSchema must be executed through createGateway",
        ]);
      }
      try {
        const requestClient = completeOptions?.onBytes === undefined
          ? client
          : createOpenAIClient(
              options,
              observeResponseBytes(
                options.fetch ?? globalThis.fetch,
                completeOptions.onBytes,
              ),
            );
        const response = await requestClient.chat.completions.create(
          toOpenAIRequest(
            request,
            name,
            options.constrainedJson ?? true,
            completeOptions?.structured,
          ),
          request.signal === undefined ? {} : { signal: request.signal },
        );
        return fromOpenAIResponse(request, name, response);
      } catch (error) {
        const timeout = request.signal === undefined
          ? undefined
          : timeoutFromSignal(request.signal);
        if (timeout !== undefined) throw timeout;
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

    stream(request, activity) {
      const streamClient = activity?.onBytes === undefined
        ? client
        : createOpenAIClient(
            options,
            observeResponseBytes(
              options.fetch ?? globalThis.fetch,
              activity.onBytes,
            ),
          );
      return streamOpenAI(
        streamClient,
        request,
        name,
        options.constrainedJson ?? true,
        activity,
      );
    },

    supports(feature: ProviderFeature) {
      if (feature === "cacheControl") return false;
      return options.constrainedJson ?? true;
    },
  };
}

function createOpenAIClient(
  options: OpenAIProviderOptions,
  fetchOverride?: typeof fetch,
): OpenAI {
  return new OpenAI({
    maxRetries: 0,
    timeout: SDK_TIMEOUT_DISABLED_MS,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(fetchOverride === undefined
      ? options.fetch === undefined
        ? {}
        : { fetch: options.fetch }
      : { fetch: fetchOverride }),
    ...(options.defaultHeaders === undefined
      ? {}
      : { defaultHeaders: options.defaultHeaders }),
  });
}

async function* streamOpenAI(
  client: OpenAI,
  request: GatewayRequest,
  provider: string,
  constrainedJson: boolean,
  activity?: StreamActivityHooks,
): AsyncIterable<import("../types.js").StreamEvent> {
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
    { id: string; name: string; argumentsJson: string }
  >();

  try {
    if (request.responseSchema !== undefined) {
      throw new SchemaConstraintError(provider, [
        "structured streaming is not supported",
      ]);
    }
    const base = toOpenAIRequest(request, provider, constrainedJson);
    const stream = await client.chat.completions.create(
      { ...base, stream: true, stream_options: { include_usage: true } },
      { signal },
    );

    for await (const chunk of stream) {
      if (chunk.usage != null) usage = openAIUsage(chunk.usage);

      const choice = chunk.choices[0];
      if (choice === undefined) continue;

      const text = choice.delta.content;
      if (typeof text === "string" && text !== "") {
        activity?.onContent?.();
        ttftMs ??= performance.now() - startedAt;
        yield { type: "text", delta: text };
      }

      for (const fragment of choice.delta.tool_calls ?? []) {
        let tool = tools.get(fragment.index);
        if (tool === undefined) {
          tool = { id: "", name: "", argumentsJson: "" };
          tools.set(fragment.index, tool);
        }
        if (fragment.id !== undefined) tool.id = fragment.id;
        if (fragment.function?.name !== undefined) tool.name += fragment.function.name;
        const argumentsDelta = fragment.function?.arguments;
        if (argumentsDelta !== undefined && argumentsDelta !== "") {
          activity?.onContent?.();
          tool.argumentsJson += argumentsDelta;
        }
      }

      if (choice.finish_reason !== null) {
        stopReason = normalizeOpenAIStopReason(choice.finish_reason);
      }
    }

    const timeout = timeoutFromSignal(signal);
    if (timeout !== undefined) throw timeout;

    for (const tool of tools.values()) {
      yield {
        type: "tool_call",
        id: tool.id,
        name: tool.name,
        args: parseArguments(tool.argumentsJson),
      };
    }
    yield { type: "done", stopReason, usage, ttftMs, attempts: 1 };
  } catch (error) {
    const timeout = timeoutFromSignal(signal);
    const mapped = timeout ?? (error instanceof GatewayError
      ? error
      : error instanceof OpenAI.APIError
        ? toGatewayError(provider, error.status ?? null, error.headers, error)
        : toGatewayError(provider, null, undefined, error));
    yield { type: "error", error: mapped, usage: ZERO_USAGE };
  } finally {
    controller.abort();
  }
}

function toOpenAIRequest(
  request: GatewayRequest,
  provider: string,
  constrainedJson: boolean,
  structured?: StructuredExecution,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const model = modelForProvider(request, provider);
  if (structured?.mode === "constrained" && !constrainedJson) {
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
  addOpenAIStructuredInstructions(messages, structured);

  const structuredTool = structured?.mode === "tool"
    ? {
        type: "function" as const,
        function: {
          name: STRUCTURED_TOOL_NAME,
          description: "Return the requested structured response.",
          parameters: schemaForSdk(structured.schema),
          strict: true,
        },
      }
    : undefined;

  return {
    model,
    messages,
    max_completion_tokens: completionBudget(model, request.maxTokens),
    ...(structuredTool !== undefined
      ? {
          tools: [structuredTool],
          tool_choice: {
            type: "function" as const,
            function: { name: STRUCTURED_TOOL_NAME },
          },
          parallel_tool_calls: false,
        }
      : request.tools === undefined
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
    ...(structured?.mode === "constrained"
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: "gateway_response",
              strict: true,
              schema: schemaForSdk(structured.schema),
            },
          },
        }
      : {}),
  };
}

function addOpenAIStructuredInstructions(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  structured?: StructuredExecution,
): void {
  if (structured?.mode === "prompt") {
    messages.unshift({
      role: "system",
      content:
        `Return only JSON matching this JSON Schema: ${JSON.stringify(structured.schema)}`,
    });
  }
  if (structured?.repairPrompt !== undefined) {
    messages.push({ role: "user", content: structured.repairPrompt });
  }
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
    stopReason:
      choice.message.refusal !== null && choice.message.refusal !== undefined
        ? "refusal"
        : normalizeOpenAIStopReason(choice.finish_reason),
    usage: response.usage === undefined ? ZERO_USAGE : openAIUsage(response.usage),
    attempts: 1,
    failedOver: false,
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
