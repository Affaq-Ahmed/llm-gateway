import { TimeoutError } from "./errors.js";

export type TimeoutTimer = {
  readonly signal: AbortSignal;
  clear(): void;
};

export function startTimeout(
  provider: string,
  clock: "attempt" | "ttft" | "deadline",
  ms: number,
): TimeoutTimer {
  const controller = new AbortController();
  const handle = setTimeout(() => {
    controller.abort(new TimeoutError(provider, clock));
  }, ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(handle),
  };
}

export function remainingMs(
  startedAt: number,
  deadlineMs: number,
  now: () => number = Date.now,
): number {
  return deadlineMs - (now() - startedAt);
}

export function deadlineExceeded(
  startedAt: number,
  deadlineMs: number,
  extraMs = 0,
  now: () => number = Date.now,
): boolean {
  return now() - startedAt + extraMs >= deadlineMs;
}

export function timeoutFromSignal(
  signal: AbortSignal,
): TimeoutError | undefined {
  return signal.reason instanceof TimeoutError ? signal.reason : undefined;
}

export class StallTimer {
  private handle: ReturnType<typeof setTimeout> | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly provider: string,
    private readonly stallMs: number,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    if (!this.controller.signal.aborted) this.schedule();
  }

  contentArrived(): void {
    if (!this.controller.signal.aborted) this.schedule();
  }

  clear(): void {
    if (this.handle !== undefined) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  private schedule(): void {
    this.clear();
    this.handle = setTimeout(() => {
      this.controller.abort(new TimeoutError(this.provider, "ttft"));
    }, this.stallMs);
  }
}
