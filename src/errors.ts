import type { ZodIssue } from "zod";

export class GatewayError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly failoverable: boolean,
    readonly retryAfterMs: number | null,
    cause?: unknown,
  ) {
    super(
      `${new.target.name} provider=${provider} status=${status}`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = new.target.name;
  }
}

export class RateLimitError extends GatewayError {}

export class OverloadedError extends GatewayError {}

export class InvalidRequestError extends GatewayError {}

export class SchemaConstraintError extends GatewayError {
  constructor(
    provider: string,
    readonly constraints: readonly string[],
  ) {
    super(provider, null, false, false, null);
    this.message =
      `Unsupported schema constraints for provider=${provider}: ` +
      constraints.join(", ");
  }
}

export class SchemaValidationError extends GatewayError {
  constructor(
    provider: string,
    readonly issues: readonly ZodIssue[],
    cause?: unknown,
  ) {
    super(provider, null, false, true, null, cause);
    this.message = `Structured output failed Zod validation for provider=${provider}`;
  }
}

export class StructuredOutputError extends GatewayError {
  constructor(provider: string, cause?: unknown) {
    super(provider, null, false, true, null, cause);
    this.message = `Provider=${provider} did not return usable structured output`;
  }
}

export class AuthError extends GatewayError {}

export type TimeoutClock = "attempt" | "ttft" | "deadline";

export class TimeoutError extends GatewayError {
  constructor(
    provider: string,
    readonly clock: TimeoutClock,
    cause?: unknown,
  ) {
    const terminal = clock === "deadline";
    super(provider, null, !terminal, !terminal, null, cause);
  }
}

export class AllProvidersFailedError extends GatewayError {
  readonly errors: readonly GatewayError[];

  constructor(errors: readonly GatewayError[]) {
    super("all", null, false, false, null);
    this.errors = Object.freeze([...errors]);
  }
}

export type Classified = Pick<
  GatewayError,
  "retryable" | "failoverable" | "retryAfterMs"
>;

export function classify(
  status: number | null,
  headers?: Headers,
): Classified {
  if (status === null) {
    return { retryable: true, failoverable: true, retryAfterMs: null };
  }

  const retryAfterMs = parseRetryAfter(headers);

  if (status === 429) {
    return { retryable: true, failoverable: true, retryAfterMs };
  }

  if (status === 401 || status === 403) {
    return { retryable: false, failoverable: false, retryAfterMs: null };
  }

  if (status === 400 || status === 422) {
    return { retryable: false, failoverable: false, retryAfterMs: null };
  }

  if (status === 404) {
    return { retryable: false, failoverable: true, retryAfterMs: null };
  }

  if (status >= 500) {
    return { retryable: true, failoverable: true, retryAfterMs: null };
  }

  if (status >= 400) {
    return { retryable: false, failoverable: true, retryAfterMs: null };
  }

  return { retryable: false, failoverable: false, retryAfterMs: null };
}

export function toGatewayError(
  provider: string,
  status: number | null,
  headers?: Headers,
  cause?: unknown,
): GatewayError {
  const classification = classify(status, headers);
  const ErrorType = subclassFor(status);

  return new ErrorType(
    provider,
    status,
    classification.retryable,
    classification.failoverable,
    classification.retryAfterMs,
    cause,
  );
}

type GatewayErrorConstructor = new (
  provider: string,
  status: number | null,
  retryable: boolean,
  failoverable: boolean,
  retryAfterMs: number | null,
  cause?: unknown,
) => GatewayError;

function subclassFor(status: number | null): GatewayErrorConstructor {
  if (status === 429) return RateLimitError;
  if (status === 400 || status === 422) return InvalidRequestError;
  if (status === 401 || status === 403) return AuthError;
  if (status !== null && status >= 500) return OverloadedError;
  return GatewayError;
}

function parseRetryAfter(headers?: Headers): number | null {
  const raw = headers?.get("retry-after")?.trim();
  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Number(raw) * 1_000;
  }

  const retryAt = Date.parse(raw);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(0, retryAt - Date.now());
}
