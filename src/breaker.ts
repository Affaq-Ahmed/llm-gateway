import { GatewayError } from "./errors.js";

export type BreakerState = "closed" | "open" | "half-open";

export const DEFAULT_BREAKER = {
  failureThreshold: 5,
  windowMs: 30_000,
  cooldownMs: 60_000,
} as const;

export type BreakerOptions = {
  readonly provider?: string;
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
};

export class BreakerOpenError extends GatewayError {
  constructor(provider: string) {
    super(provider, null, false, true, null);
  }
}

export class Breaker {
  private readonly provider: string;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private inner: BreakerState = "closed";
  private failures: number[] = [];
  private openedAt = 0;
  private probeInFlight = false;

  constructor(options: BreakerOptions = {}) {
    this.provider = options.provider ?? "unknown";
    this.failureThreshold =
      options.failureThreshold ?? DEFAULT_BREAKER.failureThreshold;
    this.windowMs = options.windowMs ?? DEFAULT_BREAKER.windowMs;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_BREAKER.cooldownMs;
    this.now = options.now ?? Date.now;
  }

  get state(): BreakerState {
    this.maybeHalfOpen();
    return this.inner;
  }

  get failureCount(): number {
    this.pruneFailures();
    return this.failures.length;
  }

  async exec<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire()) throw new BreakerOpenError(this.provider);
    try {
      const value = await operation();
      this.recordHealthy();
      return value;
    } catch (error) {
      if (isHealthFailure(error)) this.recordFailure();
      else this.recordHealthy();
      throw error;
    }
  }

  async *execStream<T>(operation: () => AsyncIterable<T>): AsyncIterable<T> {
    if (!this.tryAcquire()) throw new BreakerOpenError(this.provider);
    try {
      for await (const value of operation()) yield value;
      this.recordHealthy();
    } catch (error) {
      if (isHealthFailure(error)) this.recordFailure();
      else this.recordHealthy();
      throw error;
    } finally {
      this.probeInFlight = false;
    }
  }

  private tryAcquire(): boolean {
    this.maybeHalfOpen();
    if (this.inner === "open") return false;
    if (this.inner === "half-open") {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
    }
    return true;
  }

  private maybeHalfOpen(): void {
    if (this.inner !== "open") return;
    if (this.now() - this.openedAt < this.cooldownMs) return;
    this.inner = "half-open";
    this.probeInFlight = false;
  }

  private recordHealthy(): void {
    this.probeInFlight = false;
    if (this.inner === "half-open") {
      this.failures = [];
      this.inner = "closed";
    }
  }

  private recordFailure(): void {
    const time = this.now();
    this.probeInFlight = false;
    this.pruneFailures();
    this.failures.push(time);
    if (
      this.inner === "half-open" ||
      this.failures.length >= this.failureThreshold
    ) {
      this.inner = "open";
      this.openedAt = time;
    }
  }

  private pruneFailures(): void {
    const time = this.now();
    this.failures = this.failures.filter(
      (failureAt) => time - failureAt <= this.windowMs,
    );
  }
}

function isHealthFailure(error: unknown): boolean {
  return error instanceof GatewayError && error.retryable && error.failoverable;
}
