# Provider fixtures

The Anthropic and OpenAI response bodies are reduced from the recorded Block B
tool-call responses in `week2-scratch`; request envelopes are retained alongside
them so replay matching covers the URL, HTTP method, model, messages, token
budget, tools, schemas, and cache controls rather than a prompt-only key.

The OpenRouter fixture exercises its documented OpenAI-compatible wire shape and
proves this package forwards `strict: true`. It is not evidence that OpenRouter
enforces strict mode: a live recording requires `OPENROUTER_API_KEY`, which was
not available for this step. Until that experiment is recorded,
`constrainedJson` remains unsupported for OpenRouter.
