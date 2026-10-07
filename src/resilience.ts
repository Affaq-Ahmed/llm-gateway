import { GatewayError, TimeoutError, toGatewayError } from "./errors.js";
import type { Provider, StreamActivityHooks } from "./providers/provider.js";
import {
  defaultRetryPolicy,
  retryDelay,
  withRetry,
  type RetryHooks,
  type RetryPolicy,
} from "./retry.js";
import { deadlineExceeded, StallTimer, startTimeout } from "./timeouts.js";
import { ZERO_USAGE, type GatewayRequest, type StreamEvent } from "./types.js";

export type ResilienceOptions = {
  readonly retry?: Partial<RetryPolicy>;
  readonly attemptTimeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly hooks?: RetryHooks;
};

export function withResilience(
  provider: Provider,
  options: ResilienceOptions = {},
): Provider {
  const policy = { ...defaultRetryPolicy, ...options.retry };
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 30_000;
  const stallTimeoutMs = options.stallTimeoutMs ?? 10_000;
  const hooks = options.hooks ?? {};

  return {
    name: provider.name,
    supports: (feature) => provider.supports(feature),

    async complete(request, options) {
      const deadline = startTimeout(provider.name, "deadline", policy.deadlineMs);
      try {
        return await withRetry(
          async (attempt) => {
            const attemptTimer = startTimeout(
              provider.name,
              "attempt",
              attemptTimeoutMs,
            );
            const signal = mergeSignals(
              request.signal,
              deadline.signal,
              attemptTimer.signal,
            );
            try {
              const response = await provider.complete(
                { ...request, signal },
                {
                  ...options,
                  onBytes: () => {
                    attemptTimer.clear();
                    options?.onBytes?.();
                  },
                },
              );
              return { ...response, attempts: attempt };
            } finally {
              attemptTimer.clear();
            }
          },
          policy,
          { ...hooks, provider: provider.name },
        );
      } finally {
        deadline.clear();
      }
    },

    stream(request, activity) {
      return resilientStream(provider, request, activity, {
        policy,
        hooks,
        attemptTimeoutMs,
        stallTimeoutMs,
      });
    },
  };
}

async function* resilientStream(
  provider: Provider,
  request: GatewayRequest,
  activity: StreamActivityHooks | undefined,
  options: {
    readonly policy: RetryPolicy;
    readonly hooks: RetryHooks;
    readonly attemptTimeoutMs: number;
    readonly stallTimeoutMs: number;
  },
): AsyncIterable<StreamEvent> {
  const now = options.hooks.now ?? Date.now;
  const sleep = options.hooks.sleep ?? defaultSleep;
  const random = options.hooks.random ?? Math.random;
  const startedAt = now();
  const deadline = startTimeout(
    provider.name,
    "deadline",
    options.policy.deadlineMs,
  );
  let lastError: GatewayError | undefined;

  try {
    for (
      let attempt = 1;
      attempt <= options.policy.maxAttempts;
      attempt += 1
    ) {
      if (deadlineExceeded(startedAt, options.policy.deadlineMs, 0, now)) {
        yield errorEvent(new TimeoutError(provider.name, "deadline", lastError));
        return;
      }

      const attemptTimer = startTimeout(
        provider.name,
        "attempt",
        options.attemptTimeoutMs,
      );
      const stall = new StallTimer(provider.name, options.stallTimeoutMs);
      const signal = mergeSignals(
        request.signal,
        deadline.signal,
        attemptTimer.signal,
        stall.signal,
      );
      let sawBytes = false;
      let sawContent = false;
      let failure: GatewayError | undefined;

      try {
        for await (const event of provider.stream(
          { ...request, signal },
          {
            onBytes: () => {
              attemptTimer.clear();
              if (!sawBytes) {
                sawBytes = true;
                stall.arm();
              }
              activity?.onBytes?.();
            },
            onContent: () => {
              sawContent = true;
              stall.contentArrived();
              activity?.onContent?.();
            },
          },
        )) {
          if (event.type === "error") {
            failure = asGatewayError(provider.name, event.error);
            break;
          }
          if (event.type === "done") {
            yield { ...event, attempts: attempt };
            return;
          }
          yield event;
        }
      } finally {
        attemptTimer.clear();
        stall.clear();
      }

      failure ??= asGatewayError(
        provider.name,
        signal.aborted ? signal.reason : new Error("Provider stream ended without a terminal event"),
      );
      lastError = failure;

      if (sawContent || !failure.retryable || attempt === options.policy.maxAttempts) {
        yield errorEvent(failure);
        return;
      }

      const delayMs = retryDelay(failure, options.policy, attempt, random);
      options.hooks.log?.({
        attempt,
        status: failure.status,
        delayMs: delayMs ?? 0,
        elapsedMs: now() - startedAt,
      });
      if (delayMs === null) {
        yield errorEvent(failure);
        return;
      }
      if (deadlineExceeded(startedAt, options.policy.deadlineMs, delayMs, now)) {
        yield errorEvent(new TimeoutError(provider.name, "deadline", failure));
        return;
      }
      await sleep(delayMs);
    }
  } finally {
    deadline.clear();
  }
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(
    signals.filter((signal): signal is AbortSignal => signal !== undefined),
  );
}

function asGatewayError(provider: string, error: unknown): GatewayError {
  return error instanceof GatewayError
    ? error
    : toGatewayError(provider, null, undefined, error);
}

function errorEvent(error: GatewayError): StreamEvent {
  return { type: "error", error, usage: ZERO_USAGE };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
