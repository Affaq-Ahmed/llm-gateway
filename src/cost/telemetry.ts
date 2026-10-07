import type { GatewayInput } from "../router.js";
import { ZERO_USAGE, type GatewayResponse, type StreamEvent } from "../types.js";
import { estimateCost, clean } from "./estimate.js";
import {
  billable,
  component,
  hasUsage,
  sumAttempts,
  sumUsage,
  streamRoute,
  structuredBilling,
  type BillableComponent,
} from "./billing.js";
import type { CostRecord, CostSink, CostSource } from "./types.js";

export type TelemetryClock = () => Date;

export async function recordComplete<T>(
  sink: CostSink,
  input: GatewayInput<T>,
  startedAt: number,
  now: TelemetryClock,
  operation: () => Promise<GatewayResponse<T>>,
  logContent = false,
): Promise<GatewayResponse<T>> {
  try {
    const response = await operation();
    const components = componentsForResponse(response);
    await sink.write(toRecord({
      input,
      components,
      provider: response.provider,
      model: unqualified(response.model),
      latencyMs: now().getTime() - startedAt,
      ttftMs: null,
      failedOver: response.failedOver,
      structuredMode: response.structured?.mode ?? null,
      repairAttempts: response.structured?.repairAttempts ?? 0,
      at: now(),
      successful: true,
      logContent,
    }));
    return response;
  } catch (error) {
    const components = typeof error === "object" && error !== null ? billable(error) : [];
    const last = components.at(-1);
    const structured = structuredDetails(error);
    await sink.write(toRecord({
      input,
      components,
      provider: last?.provider ?? providerFromError(error) ?? "unknown",
      model: last?.model ?? "unknown",
      latencyMs: now().getTime() - startedAt,
      ttftMs: null,
      failedOver: new Set(components.map((item) => item.provider)).size > 1,
      structuredMode: structured?.mode ?? null,
      repairAttempts: structured?.repairAttempts ?? 0,
      at: now(),
      successful: false,
      logContent,
    }));
    throw error;
  }
}

export async function* recordStream(
  sink: CostSink,
  input: GatewayInput,
  startedAt: number,
  now: TelemetryClock,
  operation: () => AsyncIterable<StreamEvent>,
  logContent = false,
): AsyncIterable<StreamEvent> {
  let terminal: Extract<StreamEvent, { type: "done" }> | undefined;
  let failure: unknown;
  let firstContentAt: number | undefined;
  let provider = "unknown";
  let model = "unknown";
  let failedOver = false;
  let components: readonly BillableComponent[] = [];
  try {
    for await (const event of operation()) {
      if ((event.type === "text" || event.type === "tool_call") && firstContentAt === undefined) {
        firstContentAt = now().getTime();
      }
      if (event.type === "restart") failedOver = true;
      if (event.type === "done") {
        terminal = event;
        components = billable(event);
        const route = streamRoute(event);
        provider = route?.provider ?? components.at(-1)?.provider ?? provider;
        model = route === undefined ? components.at(-1)?.model ?? model : unqualified(route.model);
        failedOver ||= route?.failedOver ?? false;
      }
      yield event;
    }
  } catch (error) {
    failure = error;
    if (typeof error === "object" && error !== null) components = billable(error);
    provider = providerFromError(error) ?? components.at(-1)?.provider ?? provider;
    model = components.at(-1)?.model ?? model;
    throw error;
  } finally {
    await sink.write(toRecord({
      input,
      components,
      provider,
      model,
      latencyMs: now().getTime() - startedAt,
      ttftMs: terminal?.ttftMs ??
        (firstContentAt === undefined ? null : firstContentAt - startedAt),
      failedOver,
      structuredMode: null,
      repairAttempts: 0,
      at: now(),
      successful: terminal !== undefined && failure === undefined,
      logContent,
    }));
  }
}

function toRecord(input: {
  readonly input: GatewayInput;
  readonly components: readonly BillableComponent[];
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  readonly failedOver: boolean;
  readonly structuredMode: CostRecord["structuredMode"];
  readonly repairAttempts: number;
  readonly at: Date;
  readonly successful: boolean;
  readonly logContent: boolean;
}): CostRecord {
  const usage = sumUsage(input.components);
  const priced = priceComponents(input.components, input.at, input.provider, input.successful);
  return {
    timestamp: input.at.toISOString(),
    traceId: input.input.traceId ?? crypto.randomUUID(),
    provider: input.provider,
    model: input.model,
    usage,
    cost: priced.cost,
    costSource: priced.source,
    latencyMs: Math.max(0, input.latencyMs),
    ttftMs: input.ttftMs,
    attempts: sumAttempts(input.components),
    failedOver: input.failedOver,
    structuredMode: input.structuredMode,
    repairAttempts: input.repairAttempts,
    ...(input.logContent
      ? { content: JSON.stringify({ system: input.input.system, messages: input.input.messages }) }
      : {}),
  };
}

function priceComponents(
  components: readonly BillableComponent[],
  at: Date,
  servingProvider: string,
  successful: boolean,
): { cost: number | null; source: CostSource } {
  if (components.length === 0) return { cost: null, source: "unknown" };
  let total = 0;
  let providerPriced = false;
  try {
    for (const item of components) {
      if (item.provider === "openrouter") {
        if (item.providerCost === undefined) return { cost: null, source: "unknown" };
        total += item.providerCost;
        providerPriced = true;
      } else {
        total += estimateCost(item.usage, item.model, at).cost;
      }
    }
  } catch {
    return { cost: null, source: "unknown" };
  }
  if (!successful && !components.some((item) => hasUsage(item.usage))) {
    return { cost: null, source: "unknown" };
  }
  return {
    cost: clean(total),
    source: servingProvider === "openrouter" || providerPriced ? "provider" : "computed",
  };
}

function componentsForResponse(response: GatewayResponse): readonly BillableComponent[] {
  const attached = billable(response);
  return attached.length > 0
    ? attached
    : [component(response.provider, response.model, response.usage, response.attempts)];
}

function unqualified(model: string): string {
  return model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
}

function providerFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("provider" in error)) return undefined;
  return typeof error.provider === "string" ? error.provider : undefined;
}

function structuredDetails(error: unknown): ReturnType<typeof structuredBilling> {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = structuredBilling(error);
  if (direct !== undefined) return direct;
  if (!("errors" in error) || !Array.isArray(error.errors)) return undefined;
  const last = error.errors.at(-1);
  return typeof last === "object" && last !== null
    ? structuredBilling(last)
    : undefined;
}
