import { Breaker, type BreakerOptions } from "./breaker.js";
import type { Provider } from "./providers/provider.js";
import { withResilience, type ResilienceOptions } from "./resilience.js";
import {
  Router,
  tiers as defaultTiers,
  type GatewayInput,
  type GatewayStreamOptions,
  type TierMap,
} from "./router.js";
import type { GatewayResponse, StreamEvent } from "./types.js";

export type Gateway = {
  complete(input: GatewayInput, tier?: string): Promise<GatewayResponse>;
  stream(
    input: GatewayInput,
    options?: GatewayStreamOptions,
  ): AsyncIterable<StreamEvent>;
};

export type CreateGatewayOptions = {
  readonly providers: readonly Provider[];
  readonly tiers?: TierMap;
  readonly resilience?: ResilienceOptions;
  readonly breaker?: Omit<BreakerOptions, "provider">;
  readonly breakers?: Map<string, Breaker>;
};

export function createGateway(options: CreateGatewayOptions): Gateway {
  const router = new Router({
    providers: options.providers.map((provider) =>
      withResilience(provider, options.resilience),
    ),
    tiers: options.tiers ?? defaultTiers,
    ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
  });
  return {
    complete: (input, tier) => router.complete(input, tier),
    stream: (input, streamOptions) => router.stream(input, streamOptions),
  };
}
