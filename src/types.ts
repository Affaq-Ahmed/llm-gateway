import type { ZodType } from "zod";

export type ModelId = `${string}:${string}`;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonSchema = { readonly [key: string]: JsonValue };

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
};

export type GatewayMessage =
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export type ToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchema;
};

export type CacheHint = {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
};

export type StructuredMode = "constrained" | "tool" | "prompt";
export type SchemaPolicy = "strict" | "relax";

export type StructuredOutput<T> = {
  readonly data: T;
  readonly mode: StructuredMode;
  readonly strippedConstraints: readonly string[];
  readonly repairAttempts: number;
};

export type GatewayRequest<T = unknown> = {
  readonly model: ModelId;
  readonly messages: readonly GatewayMessage[];
  readonly system?: string;
  readonly maxTokens: number;
  readonly tools?: readonly ToolDefinition[];
  readonly responseSchema?: ZodType<T>;
  readonly structuredMode?: StructuredMode | "auto";
  readonly schemaPolicy?: SchemaPolicy;
  readonly cacheHint?: CacheHint;
  readonly traceId?: string;
  readonly signal?: AbortSignal;
};

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationInputTokens: number;
};

export type ZeroUsage = {
  readonly [Key in keyof Usage]: 0;
};

export const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 0,
}) satisfies ZeroUsage;

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "unknown";

export type GatewayResponse<T = unknown> = {
  readonly model: ModelId;
  readonly provider: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly attempts: number;
  readonly failedOver: boolean;
  readonly structured?: StructuredOutput<T>;
};

export type StreamEvent =
  | { readonly type: "text"; readonly delta: string }
  | {
      readonly type: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: "done";
      readonly stopReason: StopReason;
      readonly usage: Usage;
      /** Null when the stream completes without producing text (for example, tool-only output). */
      readonly ttftMs: number | null;
      readonly attempts: number;
    }
  | {
      readonly type: "error";
      readonly error: unknown;
      readonly usage: ZeroUsage;
    }
  | { readonly type: "restart"; readonly provider: string };
