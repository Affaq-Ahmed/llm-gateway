import { z, type ZodIssue, type ZodType } from "zod";
import {
  SchemaConstraintError,
  SchemaValidationError,
  StructuredOutputError,
} from "./errors.js";
import type {
  Provider,
  ProviderCompleteOptions,
} from "./providers/provider.js";
import type {
  GatewayRequest,
  GatewayResponse,
  JsonSchema,
  SchemaPolicy,
  StructuredMode,
  Usage,
} from "./types.js";
import {
  billable,
  component,
  setBillable,
  setStructuredBilling,
  type BillableComponent,
} from "./cost/billing.js";

const STRUCTURED_TOOL_NAME = "gateway_structured_output";
const schemaCache = new WeakMap<ZodType, JsonSchema>();

export function jsonSchemaFor(schema: ZodType): JsonSchema {
  const cached = schemaCache.get(schema);
  if (cached !== undefined) return cached;
  const converted = z.toJSONSchema(schema);
  const jsonSchema = { ...converted } as unknown as JsonSchema;
  schemaCache.set(schema, jsonSchema);
  return jsonSchema;
}

export function withStructuredOutputs(provider: Provider): Provider {
  return {
    name: provider.name,
    supports: (feature) => provider.supports(feature),
    stream: (request, activity) => provider.stream(request, activity),
    async complete(request, options) {
      if (request.responseSchema === undefined) {
        return provider.complete(request, options);
      }
      return completeStructured(
        provider,
        request,
        request.responseSchema,
        options,
      );
    },
  };
}

async function completeStructured(
  provider: Provider,
  request: GatewayRequest,
  responseSchema: ZodType,
  options: ProviderCompleteOptions | undefined,
): Promise<GatewayResponse> {
  const mode = selectMode(provider, request.structuredMode ?? "auto");
  const prepared = prepareProviderSchema(
    provider.name,
    jsonSchemaFor(responseSchema),
    request.schemaPolicy ?? "strict",
  );
  let totalUsage = zeroUsage();
  let totalAttempts = 0;
  let issues: readonly ZodIssue[] = [];
  let invalidCandidate: unknown;
  const billed: BillableComponent[] = [];
  let repairsPerformed = 0;

  try {
    for (let repairAttempts = 0; repairAttempts <= 1; repairAttempts += 1) {
    repairsPerformed = repairAttempts;
    const repairPrompt = repairAttempts === 0
      ? undefined
      : `The previous JSON ${JSON.stringify(invalidCandidate)} failed validation. Correct these issues and return a complete replacement: ${JSON.stringify(issues)}`;
    const response = await provider.complete(request, {
      ...options,
      structured: {
        mode,
        schema: prepared.schema,
        ...(repairPrompt === undefined ? {} : { repairPrompt }),
      },
    });
    const responseBilling = billable(response);
    billed.push(...(responseBilling.length > 0
      ? responseBilling
      : [component(response.provider, response.model, response.usage, response.attempts)]));
    totalUsage = addUsage(totalUsage, response.usage);
    totalAttempts += response.attempts;

    if (response.stopReason === "refusal") {
      return setBillable(
        { ...response, usage: totalUsage, attempts: totalAttempts },
        billed,
      );
    }

    let candidate: unknown;
    try {
      candidate = extractCandidate(provider.name, response, mode);
    } catch (error) {
      if (mode !== "prompt" || !(error instanceof StructuredOutputError)) {
        throw error;
      }
      invalidCandidate = response.text;
      issues = [invalidJsonIssue()];
      continue;
    }
    const validation = await responseSchema.safeParseAsync(candidate);
    if (validation.success) {
      return setBillable({
        ...response,
        usage: totalUsage,
        attempts: totalAttempts,
        structured: {
          data: validation.data,
          mode,
          strippedConstraints: prepared.strippedConstraints,
          repairAttempts,
        },
      }, billed);
    }
    invalidCandidate = candidate;
    issues = validation.error.issues;
    }

    throw new SchemaValidationError(provider.name, issues);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const errorBilling = billable(error);
      setBillable(error, [...billed, ...errorBilling]);
      setStructuredBilling(error, { mode, repairAttempts: repairsPerformed });
    }
    throw error;
  }
}

function selectMode(
  provider: Provider,
  requested: StructuredMode | "auto",
): StructuredMode {
  if (requested !== "auto") return requested;
  return provider.supports("constrainedJson") ? "constrained" : "tool";
}

function extractCandidate(
  provider: string,
  response: GatewayResponse,
  mode: StructuredMode,
): unknown {
  if (mode === "tool") {
    const call = response.toolCalls.find(
      (toolCall) => toolCall.name === STRUCTURED_TOOL_NAME,
    );
    if (call === undefined) {
      throw new StructuredOutputError(
        provider,
        new Error(
          `Forced structured tool produced no call (stopReason=${response.stopReason})`,
        ),
      );
    }
    return call.args;
  }

  try {
    return JSON.parse(response.text) as unknown;
  } catch (cause) {
    throw new StructuredOutputError(provider, cause);
  }
}

function prepareProviderSchema(
  provider: string,
  source: JsonSchema,
  policy: SchemaPolicy,
): { schema: JsonSchema; strippedConstraints: readonly string[] } {
  const schema = structuredClone(source);
  const strippedConstraints: string[] = [];
  visitSchema(
    schema,
    "",
    strippedConstraints,
    provider === "anthropic" && policy === "relax",
  );
  if (
    provider === "anthropic" &&
    policy === "strict" &&
    strippedConstraints.length > 0
  ) {
    throw new SchemaConstraintError(provider, strippedConstraints);
  }
  if (provider !== "anthropic") return { schema, strippedConstraints: [] };
  return { schema, strippedConstraints };
}

function visitSchema(
  value: unknown,
  path: string,
  found: string[],
  strip: boolean,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitSchema(item, `${path}/${index}`, found, strip),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "integer") {
    for (const keyword of ["minimum", "maximum"] as const) {
      if (keyword in record) {
        found.push(`${path}/${keyword}` || `/${keyword}`);
        if (strip) delete record[keyword];
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    visitSchema(child, `${path}/${escapePointer(key)}`, found, strip);
  }
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function invalidJsonIssue(): ZodIssue {
  return {
    code: "custom",
    path: [],
    message: "Provider response was not valid JSON",
  };
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationInputTokens:
      left.cacheCreationInputTokens + right.cacheCreationInputTokens,
  };
}

function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

export { STRUCTURED_TOOL_NAME };
