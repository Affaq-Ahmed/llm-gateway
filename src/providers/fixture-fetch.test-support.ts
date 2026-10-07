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

export type RecordedStreamFixture = {
  readonly protocol: "openai" | "anthropic";
  readonly request: RecordedRequest;
  readonly events: readonly Readonly<Record<string, unknown>>[];
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

export function createStreamingFixtureFetch(
  fixture: RecordedStreamFixture,
  observeSignal?: (signal: AbortSignal | null) => void,
): typeof fetch {
  return async (input, init) => {
    const request = await normalizeRequest(input, init);
    if (requestKey(request) !== requestKey(fixture.request)) {
      throw new Error(`No recorded fixture for request ${requestKey(request)}`);
    }
    observeSignal?.(init?.signal ?? null);
    const chunks = fixture.events.map((event) => {
      const name =
        fixture.protocol === "anthropic"
          ? `event: ${String(event.type)}\n`
          : "";
      return `${name}data: ${JSON.stringify(event)}\n\n`;
    });
    if (fixture.protocol === "openai") chunks.push("data: [DONE]\n\n");
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
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
