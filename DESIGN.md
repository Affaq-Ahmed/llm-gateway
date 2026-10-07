# Gateway design decisions

## The streaming commit point

Failover is transparent only until the gateway emits its first content event. Before that point, abandoning provider A and starting provider B changes latency but not the conversation the caller has observed. After content has escaped, the gateway cannot replace A invisibly: B does not inherit A's hidden generation state, may start with different words, and may repeat or contradict tokens the caller already rendered or acted on. Treating the first `text` or completed `tool_call` event as a commit point makes that boundary explicit and testable.

There are three defensible reactions to a failure after the commit point, and each spends a different kind of budget. Dropping the stream preserves semantic integrity but sacrifices availability and leaves the caller with partial output. Silently concatenating B's output maximizes apparent availability but corrupts the meaning of one logical stream while giving the caller no way to repair duplicated text or tool calls. Signalling a restart costs API complexity and requires the consumer to discard or visually separate prior output, but it preserves both availability and honesty. This gateway defaults to the first option: it propagates the typed error and never duplicates tokens without permission. Callers that can handle discontinuity may opt into `allowMidStreamRestart`; the gateway then emits `restart` before any event from the replacement provider. Silent concatenation is deliberately unsupported.

## What counts against a provider

A circuit breaker measures provider health, not request validity. A 400 means the provider received and rejected the caller's input, so counting it would let one malformed workload remove a healthy provider for every other caller. The breaker therefore records only failures that the adapter has already classified as both retryable and failoverable. Authentication and invalid-request errors still propagate immediately, but they do not move the breaker toward open. In half-open state, a non-health response proves that the provider is reachable, so the probe closes the breaker before the caller-specific error is returned.
