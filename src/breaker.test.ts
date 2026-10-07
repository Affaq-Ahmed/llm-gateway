import { describe, expect, it } from "vitest";
import { GatewayError, toGatewayError } from "./errors.js";
import { Breaker, BreakerOpenError } from "./breaker.js";

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

describe("Breaker", () => {
  it("opens after five health failures and skips the next call", async () => {
    const breaker = new Breaker({ provider: "a" });
    for (let count = 0; count < 5; count += 1) {
      await expect(breaker.exec(async () => { throw toGatewayError("a", 500); })).rejects.toBeInstanceOf(GatewayError);
    }
    let calls = 0;
    await expect(breaker.exec(async () => { calls += 1; })).rejects.toBeInstanceOf(BreakerOpenError);
    expect(calls).toBe(0);
  });

  it("does not count a caller's 400 as a provider-health failure", async () => {
    const breaker = new Breaker({ provider: "a" });
    await expect(breaker.exec(async () => { throw toGatewayError("a", 400); })).rejects.toMatchObject({ status: 400 });
    expect(breaker.failureCount).toBe(0);
    expect(breaker.state).toBe("closed");
  });

  it("allows exactly one concurrent half-open probe", async () => {
    const time = clock();
    const breaker = new Breaker({ provider: "a", failureThreshold: 1, cooldownMs: 100, now: time.now });
    await expect(breaker.exec(async () => { throw toGatewayError("a", 500); })).rejects.toBeInstanceOf(GatewayError);
    time.advance(100);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let probes = 0;
    const first = breaker.exec(async () => { probes += 1; await gate; return "ok"; });
    const second = breaker.exec(async () => { probes += 1; return "wrong"; });
    await expect(second).rejects.toBeInstanceOf(BreakerOpenError);
    expect(probes).toBe(1);
    release();
    await expect(first).resolves.toBe("ok");
  });
});
