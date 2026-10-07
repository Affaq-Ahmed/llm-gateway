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

    for (const [index, provider] of this.providers.entries()) {
      try {
        const response = await this.breakerFor(provider.name).exec(() =>
          provider.complete(
            toProviderRequest(input, tier, provider.name, this.tierMap),
          ),
        );
        return {
          ...response,
          provider: provider.name,
          failedOver: index > 0,
        } as GatewayResponse<T>;
      } catch (error) {
        const gatewayError = asGatewayError(provider.name, error);
        errors.push(gatewayError);
        if (!gatewayError.failoverable) throw gatewayError;
      }
    }

    throw new AllProvidersFailedError(errors);
  }

  async *stream(
    input: GatewayInput,
    options: GatewayStreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    const tier = options.tier ?? "fast";
    const errors: GatewayError[] = [];
    let committed = false;

    for (const [index, provider] of this.providers.entries()) {
      try {
        const stream = () =>
          provider.stream(
            toProviderRequest(input, tier, provider.name, this.tierMap),
          );
        for await (const event of this.breakerFor(provider.name).execStream(
          () => throwStreamErrors(stream()),
        )) {
          if (event.type === "text" || event.type === "tool_call") {
            committed = true;
          }
          yield event;
        }
        return;
      } catch (error) {
        const gatewayError = asGatewayError(provider.name, error);
        errors.push(gatewayError);
        if (!gatewayError.failoverable) throw gatewayError;

        const next = this.providers[index + 1];
        if (next === undefined) break;
        if (!committed) continue;
        if (options.allowMidStreamRestart === true) {
          committed = false;
          yield { type: "restart", provider: next.name };
          continue;
        }
        throw gatewayError;
      }
    }

    throw new AllProvidersFailedError(errors);
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
    if (event.type === "error") throw event.error;
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
