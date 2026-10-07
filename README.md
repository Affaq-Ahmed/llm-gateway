# `@affaqahmed/llm-gateway`

A provider-neutral TypeScript gateway for routing requests to large language
model providers with normalized responses, streaming, retries, timeouts,
failover, and circuit breaking.

## Quickstart

Create providers once, then route through a plain tier map. The gateway applies
the provider-qualified model internally, so application requests contain no SDK
types or provider branches:

```ts
import {
  createAnthropicProvider,
  createGateway,
  createOpenAIProvider,
} from "@affaqahmed/llm-gateway";

const gateway = createGateway({
  providers: [createAnthropicProvider(), createOpenAIProvider()],
  tiers: {
    fast: {
      anthropic: "claude-haiku-4-5",
      openai: "gpt-5-mini",
    },
  },
});

const response = await gateway.complete({
  messages: [{ role: "user", content: "Reply with one word." }],
  system: "Be concise.",
  maxTokens: 16,
  traceId: "readme-quickstart",
}, "fast");

console.log(response.text, response.provider, response.failedOver);
console.log(response.usage.totalTokens, response.attempts);
```

The input also accepts provider-neutral tool definitions, a JSON response
schema, ephemeral cache hints, a trace ID, and an `AbortSignal`. Direct adapter
calls still use `GatewayRequest` and provider-qualified `"provider:model"` IDs.

## Providers

The non-streaming adapters normalize provider responses before returning them:

```ts
import {
  createAnthropicProvider,
  createOpenAIProvider,
  createOpenRouterProvider,
} from "@affaqahmed/llm-gateway";

const openai = createOpenAIProvider();
const anthropic = createAnthropicProvider();
const openrouter = createOpenRouterProvider();
```

OpenRouter composes the OpenAI adapter against
`https://openrouter.ai/api/v1`. SDK retries are disabled and their timeout is
set beyond any gateway-owned deadline; retry and deadline policy belong above
the adapter boundary.

| Provider | Cache control | Constrained JSON |
| --- | --- | --- |
| Anthropic | yes | yes |
| OpenAI | no | yes |
| OpenRouter | no | no (unverified) |

OpenRouter tool definitions retain `strict: true` on the outgoing
OpenAI-compatible request. Live verification that OpenRouter forwards and
enforces strict mode remains pending, so `supports("constrainedJson")` stays
`false` there.

## What this is not

Version 0.1.0 is not an OpenAI Responses API wrapper. It deliberately uses Chat
Completions because OpenRouter implements the same protocol and the adapter
behavior is backed by the Block A–B recordings. Mid-stream failover is also not
silently transparent: by default a post-content failure is propagated, while
callers may explicitly opt into a signalled restart.

## Error taxonomy

Provider failures are normalized as `GatewayError` subclasses. Rate limits and
provider overloads are retryable and failoverable. Authentication and invalid
requests are terminal. `TimeoutError.clock` identifies `"attempt"`, `"ttft"`,
or `"deadline"`; an exhausted deadline is terminal because no retry budget
remains. `AllProvidersFailedError.errors` retains every attempted provider
failure in order.
