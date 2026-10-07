import { describe, expect, it } from "vitest";
import { Breaker } from "./breaker.js";
import {
  AllProvidersFailedError,
  AuthError,
  InvalidRequestError,
  TimeoutError,
  toGatewayError,
} from "./errors.js";
import { createGateway } from "./gateway.js";
import type { Provider } from "./providers/provider.js";
import { ZERO_USAGE, type GatewayResponse, type StreamEvent } from "./types.js";

const input = {
  messages: [{ role: "user", content: "hello" }],
  maxTokens: 16,
} as const;

describe("createGateway", () => {
  it("fails over a provider 500 and marks B's response", async () => {
    const a = fakeProvider("a", async () => { throw toGatewayError("a", 500); });
    const b = fakeProvider("b", async () => response("b"));
    const gateway = createGateway({
      providers: [a.provider, b.provider],
      tiers: { fast: { a: "a-model", b: "b-model" } },
      resilience: { retry: { maxAttempts: 1 } },
    });

    await expect(gateway.complete(input)).resolves.toMatchObject({
      provider: "b",
      failedOver: true,
    });
    expect(a.calls.complete).toBe(1);
    expect(b.calls.complete).toBe(1);
  });

  it("surfaces a 401 immediately without calling B", async () => {
    const a = fakeProvider("a", async () => { throw toGatewayError("a", 401); });
    const b = fakeProvider("b", async () => response("b"));
    const gateway = testGateway(a.provider, b.provider);
    await expect(gateway.complete(input)).rejects.toBeInstanceOf(AuthError);
    expect(b.calls.complete).toBe(0);
  });

  it("does not fail over or penalize the breaker for a 400", async () => {
    const breaker = new Breaker({ provider: "a" });
    const a = fakeProvider("a", async () => { throw toGatewayError("a", 400); });
    const b = fakeProvider("b", async () => response("b"));
    const gateway = createGateway({
      providers: [a.provider, b.provider],
      tiers: testTiers,
      breakers: new Map([["a", breaker]]),
      resilience: { retry: { maxAttempts: 1 } },
    });
    await expect(gateway.complete(input)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(breaker.failureCount).toBe(0);
    expect(b.calls.complete).toBe(0);
  });

  it("opens after five failures and then makes zero calls to A", async () => {
    const a = fakeProvider("a", async () => { throw toGatewayError("a", 500); });
    const b = fakeProvider("b", async () => response("b"));
    const gateway = testGateway(a.provider, b.provider);
    for (let count = 0; count < 5; count += 1) await gateway.complete(input);
    expect(a.calls.complete).toBe(5);
    await gateway.complete(input);
    expect(a.calls.complete).toBe(5);
    expect(b.calls.complete).toBe(6);
  });

  it("allows exactly one A probe for two concurrent half-open requests", async () => {
    let time = 0;
    let mode: "fail" | "probe" = "fail";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let probes = 0;
    const a = fakeProvider("a", async () => {
      if (mode === "fail") throw toGatewayError("a", 500);
      probes += 1;
      await gate;
      return response("a");
    });
    const b = fakeProvider("b", async () => response("b"));
    const gateway = createGateway({
      providers: [a.provider, b.provider],
      tiers: testTiers,
      breaker: { failureThreshold: 1, cooldownMs: 100, now: () => time },
      resilience: { retry: { maxAttempts: 1 } },
    });
    await gateway.complete(input);
    mode = "probe";
    time = 100;
    const concurrent = Promise.all([
      gateway.complete(input),
      gateway.complete(input),
    ]);
    await Promise.resolve();
    expect(probes).toBe(1);
    release();
    const results = await concurrent;
    expect(results.map((result) => result.provider).sort()).toEqual(["a", "b"]);
    expect(a.calls.complete).toBe(2);
  });

  it("retains one underlying error per provider when all fail", async () => {
    const a = fakeProvider("a", async () => { throw toGatewayError("a", 500); });
    const b = fakeProvider("b", async () => { throw toGatewayError("b", 500); });
    try {
      await testGateway(a.provider, b.provider).complete(input);
      throw new Error("expected all providers to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AllProvidersFailedError);
      expect((error as AllProvidersFailedError).errors).toHaveLength(2);
    }
  });

  it("propagates a post-commit typed error without calling B by default", async () => {
    const a = fakeProvider("a", async () => response("a"), async function* () {
      yield { type: "text", delta: "from-a" };
      yield { type: "error", error: new TimeoutError("a", "ttft"), usage: ZERO_USAGE };
    });
    const b = fakeProvider("b", async () => response("b"), async function* () {
      yield { type: "text", delta: "from-b" };
      yield done();
    });
    const events: StreamEvent[] = [];
    try {
      for await (const event of testGateway(a.provider, b.provider).stream(input)) {
        events.push(event);
      }
      throw new Error("expected stream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(TimeoutError);
    }
    expect(events).toEqual([{ type: "text", delta: "from-a" }]);
    expect(b.calls.stream).toBe(0);
  });

  it("fails over transparently before the first content event", async () => {
    const a = fakeProvider("a", async () => response("a"), async function* () {
      yield { type: "error", error: toGatewayError("a", 500), usage: ZERO_USAGE };
    });
    const b = fakeProvider("b", async () => response("b"), async function* () {
      yield { type: "text", delta: "from-b" };
      yield done();
    });
    await expect(collect(testGateway(a.provider, b.provider).stream(input))).resolves.toEqual([
      { type: "text", delta: "from-b" },
      done(),
    ]);
  });

  it("signals an explicit restart before continuing on B", async () => {
    const a = fakeProvider("a", async () => response("a"), async function* () {
      yield { type: "text", delta: "from-a" };
      yield { type: "error", error: new TimeoutError("a", "ttft"), usage: ZERO_USAGE };
    });
    const b = fakeProvider("b", async () => response("b"), async function* () {
      yield { type: "text", delta: "from-b" };
      yield done();
    });
    const events = await collect(testGateway(a.provider, b.provider).stream(input, {
      allowMidStreamRestart: true,
    }));
    expect(events).toEqual([
      { type: "text", delta: "from-a" },
      { type: "restart", provider: "b" },
      { type: "text", delta: "from-b" },
      done(),
    ]);
  });
});

const testTiers = { fast: { a: "a-model", b: "b-model" } } as const;

function testGateway(a: Provider, b: Provider) {
  return createGateway({
    providers: [a, b],
    tiers: testTiers,
    resilience: { retry: { maxAttempts: 1 } },
  });
}

function fakeProvider(
  name: string,
  complete: Provider["complete"],
  stream: Provider["stream"] = async function* () {
    yield done();
  },
): { provider: Provider; calls: { complete: number; stream: number } } {
  const calls = { complete: 0, stream: 0 };
  return {
    calls,
    provider: {
      name,
      async complete(request, activity) {
        calls.complete += 1;
        return complete(request, activity);
      },
      stream(request, activity) {
        calls.stream += 1;
        return stream(request, activity);
      },
      supports: () => false,
    },
  };
}

function response(provider: string): GatewayResponse {
  return {
    model: `${provider}:model`,
    provider,
    text: "ok",
    toolCalls: [],
    stopReason: "end_turn",
    usage: ZERO_USAGE,
    attempts: 1,
    failedOver: false,
  };
}

function done(): StreamEvent {
  return {
    type: "done",
    stopReason: "end_turn",
    usage: ZERO_USAGE,
    ttftMs: null,
    attempts: 1,
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
