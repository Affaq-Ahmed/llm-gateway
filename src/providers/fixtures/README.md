# Provider fixtures

The Anthropic and OpenAI response bodies are reduced from the recorded Block B
tool-call responses in `week2-scratch`; request envelopes are retained alongside
them so replay matching covers the URL, HTTP method, model, messages, token
budget, tools, schemas, and cache controls rather than a prompt-only key.

The OpenRouter fixture exercises its OpenAI-compatible wire shape. A later
[live capture](../../../evidence/live/openrouter-strict-tool.json) records
`strict: true` on the outbound forced tool and a schema-valid tool result from
the routed model. OpenRouter still defaults to tool mode rather than advertising
native constrained JSON support.
