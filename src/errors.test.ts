import { describe, expect, it } from "vitest";
import {
  AllProvidersFailedError,
  AuthError,
  GatewayError,
  InvalidRequestError,
  OverloadedError,
  RateLimitError,
  TimeoutError,
  classify,
  toGatewayError,
  type TimeoutClock,
} from "./errors.js";

describe("classify", () => {
  it.each([
    { status: 400, retryable: false, failoverable: false },
    { status: 401, retryable: false, failoverable: false },
    { status: 403, retryable: false, failoverable: false },
    { status: 404, retryable: false, failoverable: true },
    { status: 422, retryable: false, failoverable: false },
    { status: 429, retryable: true, failoverable: true },
    { status: 500, retryable: true, failoverable: true },
    { status: 502, retryable: true, failoverable: true },
    { status: 503, retryable: true, failoverable: true },
    { status: 529, retryable: true, failoverable: true },
    { status: null, retryable: true, failoverable: true },
  ] as const)(
    "$status → retryable=$retryable failoverable=$failoverable",
    ({ status, retryable, failoverable }) => {
      expect(classify(status)).toEqual({
        retryable,
        failoverable,
        retryAfterMs: null,
      });
    },
  );

  it("converts Retry-After seconds to milliseconds", () => {
    expect(classify(429, new Headers({ "retry-after": "2" }))).toEqual({
      retryable: true,
      failoverable: true,
      retryAfterMs: 2_000,
    });
  });

  it("ignores a malformed Retry-After value", () => {
    expect(classify(429, new Headers({ "retry-after": "later" }))).toEqual({
      retryable: true,
      failoverable: true,
      retryAfterMs: null,
    });
  });
});

describe("toGatewayError", () => {
  it.each([
    { status: 400, type: InvalidRequestError },
    { status: 401, type: AuthError },
    { status: 403, type: AuthError },
    { status: 404, type: GatewayError },
    { status: 422, type: InvalidRequestError },
    { status: 429, type: RateLimitError },
    { status: 500, type: OverloadedError },
    { status: 529, type: OverloadedError },
    { status: null, type: GatewayError },
  ] as const)("$status → $type.name", ({ status, type }) => {
    const cause = new Error("provider response");
    const error = toGatewayError("mock", status, undefined, cause);

    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({
      provider: "mock",
      status,
      ...classify(status),
      cause,
    });
  });
});

describe("TimeoutError", () => {
  it.each([
    {
      clock: "attempt" satisfies TimeoutClock,
      retryable: true,
      failoverable: true,
    },
    {
      clock: "ttft" satisfies TimeoutClock,
      retryable: true,
      failoverable: true,
    },
  ] as const)("makes the $clock clock recoverable", ({ clock, retryable, failoverable }) => {
    expect(new TimeoutError("mock", clock)).toMatchObject({
      clock,
      retryable,
      failoverable,
      status: null,
    });
  });

  it("makes an exhausted deadline terminal", () => {
    const cause = new Error("deadline exceeded");
    const error = new TimeoutError("openai", "deadline", cause);

    expect(error).toMatchObject({
      name: "TimeoutError",
      provider: "openai",
      status: null,
      clock: "deadline",
      retryable: false,
      failoverable: false,
      retryAfterMs: null,
      cause,
    });
  });
});

describe("AllProvidersFailedError", () => {
  it("retains a stable snapshot of every provider failure", () => {
    const openai = new GatewayError("openai", 429, true, true, 1_000);
    const anthropic = new GatewayError("anthropic", 503, true, true, null);
    const failures = [openai, anthropic];

    const error = new AllProvidersFailedError(failures);
    failures.pop();

    expect(error.errors).toEqual([openai, anthropic]);
    expect(error.errors).toHaveLength(2);
    expect(Object.isFrozen(error.errors)).toBe(true);
    expect(error).toMatchObject({
      name: "AllProvidersFailedError",
      provider: "all",
      retryable: false,
      failoverable: false,
    });
  });
});
