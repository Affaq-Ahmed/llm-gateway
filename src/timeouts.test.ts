import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StallTimer, startTimeout, timeoutFromSignal } from "./timeouts.js";

describe("timeout clocks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("labels a hanging attempt", async () => {
    const timer = startTimeout("mock", "attempt", 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(timeoutFromSignal(timer.signal)).toMatchObject({ clock: "attempt" });
  });

  it("resets a stall only for content", async () => {
    const timer = new StallTimer("mock", 50);
    timer.arm();
    await vi.advanceTimersByTimeAsync(40);
    timer.contentArrived();
    await vi.advanceTimersByTimeAsync(40);
    expect(timer.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(timeoutFromSignal(timer.signal)).toMatchObject({ clock: "ttft" });
  });
});
