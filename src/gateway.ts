import { Breaker, type BreakerOptions } from "./breaker.js";
import type { Provider } from "./providers/provider.js";
import { withResilience, type ResilienceOptions } from "./resilience.js";
import { withStructuredOutputs } from "./structured.js";
import {
  Router,
  tiers as defaultTiers,
  type GatewayInput,
  type GatewayStreamOptions,
  type TierMap,
} from "./router.js";
import type { GatewayResponse, StreamEvent } from "./types.js";
import type { CostSink } from "./cost/types.js";
import { recordComplete, recordStream, type TelemetryClock } from "./cost/telemetry.js";

export type Gateway = {
  complete<T>(
    input: GatewayInput<T>,
    tier?: string,
  ): Promise<GatewayResponse<T>>;
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
  readonly costSink?: CostSink;
  readonly now?: TelemetryClock;
  readonly logContent?: boolean;
};

export function createGateway(options: CreateGatewayOptions): Gateway {
  const router = new Router({
    providers: options.providers.map((provider) =>
      withStructuredOutputs(withResilience(provider, options.resilience)),
    ),
    tiers: options.tiers ?? defaultTiers,
    ...(options.breaker === undefined ? {} : { breaker: options.breaker }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
  });
  const now = options.now ?? (() => new Date());
  if (options.costSink === undefined) {
    return {
      complete: (input, tier) => router.complete(input, tier),
      stream: (input, streamOptions) => router.stream(input, streamOptions),
    };
  }
  const sink = options.costSink;
  return {
    complete: (input, tier) => {
      const startedAt = now().getTime();
      return recordComplete(
        sink,
        input,
        startedAt,
        now,
        () => router.complete(input, tier),
        options.logContent ?? false,
      );
    },
    stream: (input, streamOptions) => {
      const startedAt = now().getTime();
      return recordStream(
        sink,
        input,
        startedAt,
        now,
        () => router.stream(input, streamOptions),
        options.logContent ?? false,
      );
    },
  };
}
