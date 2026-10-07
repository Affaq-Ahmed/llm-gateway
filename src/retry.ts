import { GatewayError, TimeoutError } from "./errors.js";
import { deadlineExceeded } from "./timeouts.js";

export const MAX_HONORED_RETRY_AFTER_MS = 5_000;

export type RetryPolicy = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly capMs: number;
  readonly deadlineMs: number;
  readonly maxHonoredRetryAfterMs: number;
};

export type AttemptLog = {
  readonly attempt: number;
  readonly status: number | null;
  readonly delayMs: number;
  readonly elapsedMs: number;
};

export type RetryHooks = {
  readonly provider?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: (entry: AttemptLog) => void;
};

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  capMs: 2_000,
  deadlineMs: 30_000,
  maxHonoredRetryAfterMs: MAX_HONORED_RETRY_AFTER_MS,
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  hooks: RetryHooks = {},
): Promise<T> {
  const provider = hooks.provider ?? "unknown";
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;
  const startedAt = now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (deadlineExceeded(startedAt, policy.deadlineMs, 0, now)) {
      throw new TimeoutError(provider, "deadline", lastError);
    }

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const elapsedMs = now() - startedAt;
      if (
        !(error instanceof GatewayError) ||
        !error.retryable ||
        attempt === policy.maxAttempts
      ) {
        hooks.log?.({
          attempt,
          status: error instanceof GatewayError ? error.status : null,
          delayMs: 0,
          elapsedMs,
        });
        throw error;
      }

      const delayMs = retryDelay(error, policy, attempt, random);
      hooks.log?.({ attempt, status: error.status, delayMs: delayMs ?? 0, elapsedMs });
      if (delayMs === null) throw error;
      if (deadlineExceeded(startedAt, policy.deadlineMs, delayMs, now)) {
        throw new TimeoutError(provider, "deadline", error);
      }
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function retryDelay(
  error: GatewayError,
  policy: RetryPolicy,
  attempt: number,
  random: () => number,
): number | null {
  if (error.retryAfterMs !== null) {
    return error.retryAfterMs > policy.maxHonoredRetryAfterMs
      ? null
      : error.retryAfterMs;
  }
  const ceiling = Math.min(
    policy.capMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );
  return random() * ceiling;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
