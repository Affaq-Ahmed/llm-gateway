# `@affaqahmed/llm-gateway`

A provider-neutral TypeScript contract for routing requests to large language
model providers. The runtime gateway is not implemented yet; version `0.0.0`
establishes the package and module-resolution contract, and the current source
defines its request, response, streaming, and error vocabulary.

## Quickstart

Models are provider-qualified as `"provider:model"`. A request can be written
without importing any provider SDK types:

```ts
import type {
  GatewayRequest,
  GatewayResponse,
  StreamEvent,
} from "@affaqahmed/llm-gateway";

const request = {
  model: "openai:gpt-5-mini",
  messages: [{ role: "user", content: "Reply with one word." }],
  system: "Be concise.",
  maxTokens: 16,
  traceId: "readme-quickstart",
} satisfies GatewayRequest;

function recordResponse(response: GatewayResponse) {
  // Usage is always present on a completed response.
  console.log(response.text, response.stopReason, response.usage.totalTokens);
}

function recordStreamEvent(event: StreamEvent) {
  if (event.type === "error") {
    // Error events carry the complete zero-valued Usage shape.
    console.error(event.error, event.usage.totalTokens); // 0
  }
}
```

`GatewayRequest` also accepts provider-neutral tool definitions, a JSON response
schema, ephemeral cache hints, a trace ID, and an `AbortSignal`.

## Error taxonomy

Provider failures are normalized as `GatewayError` subclasses. Rate limits and
provider overloads are retryable and failoverable. Authentication and invalid
requests are terminal. `TimeoutError.clock` identifies `"attempt"`, `"ttft"`,
or `"deadline"`; an exhausted deadline is terminal because no retry budget
remains. `AllProvidersFailedError.errors` retains every attempted provider
failure in order.
