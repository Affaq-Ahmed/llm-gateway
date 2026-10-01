type RecordedRequest = {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
};

type RecordedFixture = {
  readonly request: RecordedRequest;
  readonly response: {
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: unknown;
  };
};

export function createFixtureFetch(
  fixtures: readonly RecordedFixture[],
): typeof fetch {
  const responses = new Map(
    fixtures.map((fixture) => [requestKey(fixture.request), fixture.response]),
  );

  return async (input, init) => {
    const request = await normalizeRequest(input, init);
    const key = requestKey(request);
    const recorded = responses.get(key);

    if (!recorded) {
      throw new Error(`No recorded fixture for request ${key}`);
    }

    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status,
      headers: {
        "content-type": "application/json",
        ...recorded.headers,
      },
    });
  };
}

function requestKey(request: RecordedRequest): string {
  return stableJson(request);
}

async function normalizeRequest(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<RecordedRequest> {
  const request = new Request(input, init);
  const rawBody = await request.text();

  return {
    url: request.url,
    method: request.method,
    body: rawBody === "" ? null : (JSON.parse(rawBody) as unknown),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}
