import { describe, expect, it } from "vitest";
import {
  GatewayError,
  RateLimitError,
  TimeoutError,
  toGatewayError,
} from "./errors.js";
import { withRetry, type RetryPolicy } from "./retry.js";

const policy: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 100,
  capMs: 1_000,
  deadlineMs: 10_000,
  maxHonoredRetryAfterMs: 5_000,
};

describe("withRetry", () => {
  it("reads the mapped retryable property instead of reclassifying status", async () => {
    let calls = 0;
    const error = new GatewayError("mock", 500, false, true, null);
    await expect(withRetry(async () => {
      calls += 1;
      throw error;
    }, policy, { sleep: async () => {} })).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it("honors retry-after and rejects an over-cap value without sleeping", async () => {
    const sleeps: number[] = [];
    const short = toGatewayError("mock", 429, new Headers({ "retry-after": "2" }));
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      if (calls === 1) throw short;
      return "ok";
    }, policy, { sleep: async (ms) => { sleeps.push(ms); } })).resolves.toBe("ok");
    expect(sleeps).toEqual([2_000]);

    const long = toGatewayError("mock", 429, new Headers({ "retry-after": "60" }));
    await expect(withRetry(async () => { throw long; }, policy, {
      sleep: async (ms) => { sleeps.push(ms); },
    })).rejects.toBeInstanceOf(RateLimitError);
    expect(long.failoverable).toBe(true);
    expect(sleeps).toEqual([2_000]);
  });

  it("uses full jitter and checks the deadline before sleeping", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const values = [0.2, 0.8];
    let randomIndex = 0;
    await expect(withRetry(async () => {
      throw toGatewayError("mock", 500);
    }, { ...policy, maxAttempts: 3, deadlineMs: 100 }, {
      now: () => time,
      random: () => values[randomIndex++] ?? 1,
      sleep: async (ms) => { sleeps.push(ms); time += ms; },
    })).rejects.toMatchObject({ clock: "deadline" });
    expect(sleeps).toEqual([20]);
    expect(time).toBeLessThanOrEqual(100);
  });

  it("never retries a terminal deadline timeout", async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new TimeoutError("mock", "deadline");
    }, policy, { sleep: async () => {} })).rejects.toMatchObject({ clock: "deadline" });
    expect(calls).toBe(1);
  });
});
