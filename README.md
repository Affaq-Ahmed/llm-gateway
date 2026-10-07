# `@affaqahmed/llm-gateway`

A provider-neutral TypeScript gateway for normalized streaming, structured output, retries, deadlines, failover, circuit breaking, and cost telemetry across Anthropic, OpenAI, and OpenRouter.

## Quickstart

```bash
npm install @affaqahmed/llm-gateway
export ANTHROPIC_API_KEY="your-key"
```

```js
import { createAnthropicProvider, createGateway } from "@affaqahmed/llm-gateway";
const provider = createAnthropicProvider();
const gateway = createGateway({ providers: [provider] });
const stream = gateway.stream({ messages: [{ role: "user", content: "Why do circuit breakers ignore bad requests?" }], maxTokens: 80 });
for await (const event of stream) if (event.type === "text") process.stdout.write(event.delta);
process.stdout.write("\n");
```

## What this is not

The Vercel AI SDK covers much of the same provider-normalization space and is the better default when its abstractions fit. This package is a small study in explicit failure policy, stream commit points, and evidence-backed provider differences.

It uses OpenAI Chat Completions, not the Responses API. It has no embeddings or image APIs, and it is not an agent framework. It routes model calls; it does not plan tasks, run tools, or own conversation state.

## Failover demo

The demo uses a local mock server, so it is free and deterministic:

```bash
pnpm demo:failover
```

It shows a transparent pre-content failover, a typed post-content error, and an explicit restart. Grey `(upstream: …)` lines are the mock server's view; everything else is what the consumer receives. The GIF is rendered by `pnpm demo:gif` from the committed [terminal transcript](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/docs/assets/failover-demo.txt) of a real run.

![Failover demo showing transparent, error, and restart outcomes](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/docs/assets/failover-demo.gif)

## The commit point

Failover is transparent only until the first text or completed tool call reaches the consumer. Before that moment, changing providers affects latency but cannot invalidate anything the caller has observed.

After content escapes, another provider cannot continue the same hidden generation. It may repeat, contradict, or reinterpret earlier tokens. Silent concatenation would present two generations as one and leave the consumer unable to repair the boundary.

The default is therefore a typed error with no duplicated tokens. Consumers that can discard or separate partial output may enable `allowMidStreamRestart`; the gateway emits `restart` before replacement content. The full rationale is in [DESIGN.md](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/DESIGN.md).

## Structured outputs

Every tier ends at the original Zod schema. Provider acceptance is never treated as application-level validation.

| Mode | Wire strategy | When it is selected |
| --- | --- | --- |
| `constrained` | Provider JSON-schema decoding | Default when the adapter proves support |
| `tool` | One forced tool; parallel calls disabled | OpenRouter's default structured path or an explicit choice |
| `prompt` | JSON-only instruction, parse, validate, repair | Explicit fallback for any provider |

A length grammar can produce valid but damaged prose. Recorded OpenAI summaries ended with [`after尝`](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/structured/openai-truncated-endings.json) and [`misses 사람`](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/structured/openai-truncated-endings.json) at the schema boundary.

Anthropic accepted the same kind of bound but returned an [overlong summary](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/finding-4-anthropic-overlong.json). The gateway always validates the result and exposes repair attempts rather than equating “constrained” with “correct.”

Anthropic also rejects some integer bounds on the wire. In strict policy the gateway fails before an upstream call. Relaxed policy removes only the unsupported wire keywords, reports them in `strippedConstraints`, and still lets Zod enforce them.

## Capability matrix

Every entry below links to a replayable or live-captured artifact. Absence from the table is not a claim of incompatibility.

| Provider | Normalized call | Streaming | Structured evidence | Cache evidence |
| --- | --- | --- | --- | --- |
| Anthropic | [tool input arrives as an object](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/anthropic.json) | [recorded SSE](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/anthropic-stream.json) | [accepted schema missed a string bound](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/finding-4-anthropic-overlong.json) | [explicit write and read](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/cache-sequence.json) |
| OpenAI | [argument JSON is parsed](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/openai.json) | [recorded Chat Completions SSE](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/openai-stream.json) | [length grammar produced truncated endings](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/structured/openai-truncated-endings.json) | — |
| OpenRouter | [live Chat Completions capture](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/openrouter.json) | [recorded compatible SSE](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/providers/fixtures/openrouter-stream.json) | [live strict forced-tool result](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/openrouter-strict-tool.json) | — |

The OpenRouter capture records `strict: true` in the outgoing tool, a successful upstream tool call, schema-valid parsed data, and no repair. That closes the forwarding question for the captured model and API date without generalizing to every routed model.

## Cost

The estimate has four terms:

```text
cost = uncached input × input rate
     + output × output rate
     + cache writes × cache-write rate
     + cache reads × cache-read rate
```

Rates are per model and effective date in [`prices.json`](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/src/cost/prices.json). Cache reads are not a universal multiplier: each model row stores its own read price.

Reasoning is a breakdown of output, not another billable term. In the live failure, [all 1,024 output tokens were reasoning tokens](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/finding-3-openai-1024-2.json); charging both fields would double the actual completion cost.

One prompt was sent through every provider. This table uses the [2026-10-07 price snapshot and raw usage](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/cost-comparison.json):

| Provider | Model | Cost | Source |
| --- | --- | ---: | --- |
| Anthropic | `claude-haiku-4-5` | [$0.000260](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/cost-comparison.json) | computed |
| OpenAI | `gpt-5-mini` | [$0.00034925](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/cost-comparison.json) | computed |
| OpenRouter | `openai/gpt-5-mini` | [$0.00037525](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/cost-comparison.json) | provider |

The first live cap replay succeeded after [832 reasoning tokens](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/finding-3-openai-1024.json). The next ended at [`length` with no tool call](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/live/finding-3-openai-1024-2.json), preserving both sides of the stochastic failure.

## Caching

Caching is a prefix protocol. A stable marked prefix first wrote [2,980 tokens](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/cache-sequence.json), then read [2,980 tokens](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/cache-sequence.json). Changing the prefix forced a fresh [2,981-token write](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/cache-sequence.json).

Put volatile values after the breakpoint. With a timestamp inside the marked prefix, every call wrote [3,005 tokens and read zero](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/timestamp-trap.json), because every timestamp changed the prefix hash.

Count the prefix before promising savings. The original tool registry added only [733 tokens](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/tool-prefix.json), below the model's [1,024-token minimum](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/tool-prefix.json), so that registry could not be cached by itself.

The expanded registry proved the sequence: [write, read, then a new write after an early description changed](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/evidence/caching/tool-prefix.json). Cache invalidation follows prefix order, not semantic similarity.

## How it is tested

Adapter tests replay whole-request-keyed fixtures, including model, messages, tools, schema, and token budget. The suite runs with provider keys removed, so replay coverage cannot accidentally spend money or depend on network access.

Retry and timeout tests point the real Anthropic and OpenAI SDKs at a local `baseURL`. A mock HTTP failure therefore crosses the SDK, adapter taxonomy, retry loop, deadline logic, router, and breaker rather than bypassing the stack.

Live evidence uses an overwrite-safe [`record()`](https://github.com/Affaq-Ahmed/llm-gateway/blob/v0.1.1/scripts/record.mjs). Existing keys fail before the callback runs, request authorization headers are never serialized, and the committed [capture set](https://github.com/Affaq-Ahmed/llm-gateway/tree/v0.1.1/evidence/live) supplies provenance for README claims.
