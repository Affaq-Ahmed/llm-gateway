import { Breaker, type BreakerOptions } from "./breaker.js";
import {
  AllProvidersFailedError,
  GatewayError,
  toGatewayError,
} from "./errors.js";
import type { Provider } from "./providers/provider.js";
import type {
  GatewayRequest,
  GatewayResponse,
  ModelId,
  StreamEvent,
} from "./types.js";
import {
  billable,
  component,
  setBillable,
  setStreamRoute,
  type BillableComponent,
} from "./cost/billing.js";

export const tiers = {
  fast: {
    anthropic: "claude-haiku-4-5",
    openai: "gpt-5-mini",
    openrouter: "openai/gpt-5-mini",
  },
} as const;

export type TierMap = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

export type GatewayInput<T = unknown> = Omit<GatewayRequest<T>, "model">;

export type GatewayStreamOptions = {
  readonly tier?: string;
  readonly allowMidStreamRestart?: boolean;
};

export type RouterOptions = {
  readonly providers: readonly Provider[];
  readonly tiers: TierMap;
  readonly breaker?: Omit<BreakerOptions, "provider">;
  readonly breakers?: Map<string, Breaker>;
};

export class Router {
  private readonly providers: readonly Provider[];
  private readonly tierMap: TierMap;
  private readonly breakerOptions: Omit<BreakerOptions, "provider">;
  private readonly breakers: Map<string, Breaker>;

  constructor(options: RouterOptions) {
    this.providers = options.providers;
    this.tierMap = options.tiers;
    this.breakerOptions = options.breaker ?? {};
    this.breakers = options.breakers ?? new Map();
  }

  async complete<T>(
    input: GatewayInput<T>,
    tier = "fast",
  ): Promise<GatewayResponse<T>> {
    const errors: GatewayError[] = [];
    const billed: BillableComponent[] = [];

    for (const [index, provider] of this.providers.entries()) {
      try {
        const response = await this.breakerFor(provider.name).exec(() =>
          provider.complete(
            toProviderRequest(input, tier, provider.name, this.tierMap),
          ),
        );
        const result = {
          ...response,
          provider: provider.name,
          failedOver: index > 0,
        } as GatewayResponse<T>;
        const responseBilling = billable(response);
        return setBillable(result, [
          ...billed,
          ...(responseBilling.length > 0
            ? responseBilling
            : [component(response.provider, response.model, response.usage, response.attempts)]),
        ]);
      } catch (error) {
        const gatewayError = asGatewayError(provider.name, error);
        billed.push(...billable(gatewayError));
        errors.push(gatewayError);
        if (!gatewayError.failoverable) {
          setBillable(gatewayError, billed);
          throw gatewayError;
        }
      }
    }

    throw setBillable(new AllProvidersFailedError(errors), billed);
  }

  async *stream(
    input: GatewayInput,
    options: GatewayStreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    const tier = options.tier ?? "fast";
    const errors: GatewayError[] = [];
    let committed = false;
    const billed: BillableComponent[] = [];

    for (const [index, provider] of this.providers.entries()) {
      try {
        const providerRequest = toProviderRequest(input, tier, provider.name, this.tierMap);
        const stream = () => provider.stream(providerRequest);
        for await (const event of this.breakerFor(provider.name).execStream(
          () => throwStreamErrors(stream()),
        )) {
          if (event.type === "text" || event.type === "tool_call") {
            committed = true;
          }
          if (event.type === "done") {
            const attached = billable(event);
            const current = attached.length > 0
              ? attached
              : [component(provider.name, providerRequest.model, event.usage, event.attempts)];
            const terminal = setBillable({ ...event }, [...billed, ...current]);
            yield setStreamRoute(terminal, {
              provider: provider.name,
              model: providerRequest.model,
              failedOver: index > 0,
            });
          } else {
            yield event;
          }
        }
        return;
      } catch (error) {
        const gatewayError = asGatewayError(provider.name, error);
        billed.push(...billable(gatewayError));
        errors.push(gatewayError);
        if (!gatewayError.failoverable) {
          setBillable(gatewayError, billed);
          throw gatewayError;
        }

        const next = this.providers[index + 1];
        if (next === undefined) break;
        if (!committed) continue;
        if (options.allowMidStreamRestart === true) {
          committed = false;
          yield { type: "restart", provider: next.name };
          continue;
        }
        setBillable(gatewayError, billed);
        throw gatewayError;
      }
    }

    throw setBillable(new AllProvidersFailedError(errors), billed);
  }

  private breakerFor(provider: string): Breaker {
    const existing = this.breakers.get(provider);
    if (existing !== undefined) return existing;
    const created = new Breaker({ ...this.breakerOptions, provider });
    this.breakers.set(provider, created);
    return created;
  }
}

async function* throwStreamErrors(
  stream: AsyncIterable<StreamEvent>,
): AsyncIterable<StreamEvent> {
  for await (const event of stream) {
    if (event.type === "error") {
      if (typeof event.error === "object" && event.error !== null) {
        setBillable(event.error, billable(event));
      }
      throw event.error;
    }
    yield event;
  }
}

function toProviderRequest(
  input: GatewayInput,
  tier: string,
  provider: string,
  tierMap: TierMap,
): GatewayRequest {
  const model = tierMap[tier]?.[provider];
  if (model === undefined || model === "") {
    throw new Error(`No model configured for tier=${tier} provider=${provider}`);
  }
  const qualifiedModel: ModelId = `${provider}:${model}`;
  return { ...input, model: qualifiedModel };
}

function asGatewayError(provider: string, error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : toGatewayError(provider, null, undefined, error);
}
