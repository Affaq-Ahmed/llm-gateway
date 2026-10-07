import { afterEach, describe, expect, it } from "vitest";
import { InvalidRequestError, RateLimitError } from "./errors.js";
import { startMockServer, type MockServer } from "./mock-server.test-support.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAIProvider } from "./providers/openai.js";
import type { Provider } from "./providers/provider.js";
import { withResilience } from "./resilience.js";
import type { GatewayRequest, StreamEvent } from "./types.js";

const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("resilient real-SDK stack", () => {
  it.each(["openai", "anthropic"] as const)("sends a 400 through the real %s SDK exactly once", async (kind) => {
    const server = await mock({ kind: "status", status: 400 });
    const provider = resilient(realProvider(kind, server), { maxAttempts: 3 });
    await expect(provider.complete(requestFor(kind))).rejects.toBeInstanceOf(InvalidRequestError);
    expect(server.calls()).toBe(1);
  });

  it("honors retry-after: 2 and succeeds with its attempt count", async () => {
    const server = await mock({ kind: "status", status: 429, retryAfter: "2", failTimes: 1 });
    const sleeps: number[] = [];
    const provider = resilient(realProvider("openai", server), { maxAttempts: 2 }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    await expect(provider.complete(requestFor("openai"))).resolves.toMatchObject({ attempts: 2 });
    expect(sleeps).toEqual([2_000]);
  });

  it("uses different full-jitter delays for bare 429 responses", async () => {
    const delays = await Promise.all([0.2, 0.8].map(async (random) => {
      const server = await mock({ kind: "status", status: 429, failTimes: 1 });
      const sleeps: number[] = [];
      const provider = resilient(realProvider("openai", server), { maxAttempts: 2 }, {
        random: () => random,
        sleep: async (ms) => { sleeps.push(ms); },
      });
      await provider.complete(requestFor("openai"));
      return sleeps[0];
    }));
    expect(delays).toEqual([20, 80]);
  });

  it("does not sleep an over-cap retry-after", async () => {
    const server = await mock({ kind: "status", status: 429, retryAfter: "60" });
    const sleeps: number[] = [];
    const provider = resilient(realProvider("openai", server), { maxAttempts: 3 }, {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    const completion = provider.complete(requestFor("openai"));
    await expect(completion).rejects.toBeInstanceOf(RateLimitError);
    await expect(completion).rejects.toMatchObject({ failoverable: true });
    expect(sleeps).toEqual([]);
    expect(server.calls()).toBe(1);
  });

  it("recovers from two 500s on attempt three", async () => {
    const server = await mock({ kind: "status", status: 500, failTimes: 2 });
    const provider = resilient(realProvider("openai", server), { maxAttempts: 3 }, {
      sleep: async () => {},
    });
    await expect(provider.complete(requestFor("openai"))).resolves.toMatchObject({ attempts: 3 });
    expect(server.calls()).toBe(3);
  });

  it.each([
    { fault: { kind: "hang" } as const, clock: "attempt", content: false, attempts: 1 },
    { fault: { kind: "stream-stall" } as const, clock: "ttft", content: true, attempts: 3 },
    { fault: { kind: "ping-stall" } as const, clock: "ttft", content: false, attempts: 3 },
  ])("labels $fault.kind with the $clock clock", async ({ fault, clock, content, attempts }) => {
    const server = await mock(fault);
    const provider = withResilience(realProvider("anthropic", server), {
      retry: { maxAttempts: attempts, deadlineMs: 500 },
      attemptTimeoutMs: 40,
      stallTimeoutMs: 50,
      hooks: { sleep: async () => {} },
    });
    const events = await collect(provider.stream(requestFor("anthropic")));
    expect(events.some((event) => event.type === "text")).toBe(content);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { clock } });
    expect(server.calls()).toBe(content ? 1 : attempts);
  });

  it("retries a stream that stalls before content and records the successful attempt", async () => {
    const server = await mock({ kind: "ping-stall", failTimes: 1 });
    const provider = withResilience(realProvider("anthropic", server), {
      retry: { maxAttempts: 2, deadlineMs: 500 },
      attemptTimeoutMs: 40,
      stallTimeoutMs: 50,
      hooks: { sleep: async () => {} },
    });
    const events = await collect(provider.stream(requestFor("anthropic")));
    expect(events.at(-1)).toMatchObject({ type: "done", attempts: 2 });
    expect(server.calls()).toBe(2);
  });
});

async function mock(fault: Parameters<typeof startMockServer>[0]): Promise<MockServer> {
  const server = await startMockServer(fault);
  servers.push(server);
  return server;
}

function realProvider(kind: "openai" | "anthropic", server: MockServer): Provider {
  return kind === "openai"
    ? createOpenAIProvider({ apiKey: "test", baseURL: `${server.baseUrl}/openai` })
    : createAnthropicProvider({ apiKey: "test", baseURL: `${server.baseUrl}/anthropic` });
}

function resilient(provider: Provider, retry: { maxAttempts: number }, hooks: NonNullable<Parameters<typeof withResilience>[1]>["hooks"] = {}): Provider {
  return withResilience(provider, {
    retry: { ...retry, deadlineMs: 10_000 },
    attemptTimeoutMs: 1_000,
    hooks,
  });
}

function requestFor(kind: "openai" | "anthropic"): GatewayRequest {
  return {
    model: kind === "openai" ? "openai:gpt-4o-mini" : "anthropic:claude-haiku-4-5",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 16,
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
