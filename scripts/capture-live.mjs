import OpenAI from "openai";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAnthropicProvider,
  createGateway,
  createOpenAIProvider,
  createOpenRouterProvider,
  estimateCost,
} from "../dist/index.js";
import { record } from "./record.mjs";

const capturedAt = new Date();
const models = {
  anthropic: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  openai: process.env.OPENAI_MODEL ?? "gpt-5-mini",
  openrouter: process.env.OPENROUTER_MODEL ?? "openai/gpt-5-mini",
};
const costPrompt =
  "In one sentence, explain why a circuit breaker should ignore malformed-request errors.";

requireKeys();

async function captureProvider(provider, model, factory) {
  return captureOrRead(`live/${provider}`, async () => {
    const wire = captureOneFetch();
    const adapter = factory(wire.fetch);
    const response = await adapter.complete({
      model: `${provider}:${model}`,
      messages: [{ role: "user", content: costPrompt }],
      maxTokens: 128,
      traceId: "readme-cost-comparison",
    });
    return {
      capturedAt: new Date().toISOString(),
      provider,
      model,
      request: wire.request(),
      response: wire.response(),
      normalized: response,
    };
  });
}

async function captureOrRead(key, capture) {
  const path = resolve("evidence", `${key}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  return record(key, capture);
}

async function captureFinding3() {
  const wire = captureOneFetch();
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 0,
    fetch: wire.fetch,
  });
  const response = await client.chat.completions.create({
    model: models.openai,
    max_completion_tokens: 1_024,
    messages: [{ role: "user", content: ticketInput }],
    tools: [{
      type: "function",
      function: {
        name: "record_ticket",
        description: "Extract the customer support ticket into the required structured fields.",
        parameters: ticketSchema,
        strict: true,
      },
    }],
    tool_choice: { type: "function", function: { name: "record_ticket" } },
    parallel_tool_calls: false,
  });
  const choice = response.choices[0];
  return {
    capturedAt: new Date().toISOString(),
    provider: "openai",
    model: models.openai,
    request: wire.request(),
    response: wire.response(),
    observation: {
      finishReason: choice?.finish_reason ?? null,
      refusal: choice?.message.refusal ?? null,
      observedCalls: choice?.message.tool_calls?.length ?? 0,
      usage: response.usage ?? null,
    },
  };
}

async function captureOpenRouterStrict() {
  const wire = captureOneFetch();
  const provider = createOpenRouterProvider({ fetch: wire.fetch });
  const schema = z.object({ count: z.number().int(), label: z.string() }).strict();
  const gateway = createGateway({
    providers: [provider],
    tiers: { live: { openrouter: models.openrouter } },
    resilience: { retry: { maxAttempts: 1 } },
  });
  const response = await gateway.complete({
    messages: [{
      role: "user",
      content: "Return count 7 and label strict-forwarding. Use the required tool.",
    }],
    maxTokens: 256,
    responseSchema: schema,
  }, "live");
  const requestBody = wire.request().body;
  const strictForwarded = requestBody.tools?.[0]?.function?.strict === true;
  if (!strictForwarded || response.structured === undefined) {
    throw new Error("OpenRouter strict tool capture did not satisfy its gate");
  }
  return {
    capturedAt: new Date().toISOString(),
    provider: "openrouter",
    model: models.openrouter,
    strictForwarded,
    request: wire.request(),
    response: wire.response(),
    normalized: response,
  };
}

function captureOneFetch() {
  let recordedRequest;
  let recordedResponse;
  return {
    fetch: async (input, init) => {
      if (recordedRequest !== undefined) throw new Error("Expected exactly one provider request");
      const request = new Request(input, init);
      const rawRequestBody = await request.clone().text();
      recordedRequest = {
        url: request.url,
        method: request.method,
        body: rawRequestBody === "" ? null : JSON.parse(rawRequestBody),
      };
      const response = await fetch(request);
      const rawResponseBody = await response.clone().text();
      recordedResponse = {
        status: response.status,
        requestId: response.headers.get("request-id") ?? response.headers.get("x-request-id"),
        body: rawResponseBody === "" ? null : JSON.parse(rawResponseBody),
      };
      return response;
    },
    request: () => required(recordedRequest, "request"),
    response: () => required(recordedResponse, "response"),
  };
}

function computedCostRow(provider, capture) {
  const usage = capture.normalized.usage;
  const estimate = estimateCost(usage, capture.model, capturedAt, {
    cacheTtl: "5m",
  });
  return { provider, model: capture.model, usage, cost: estimate.cost, costSource: "computed" };
}

function providerCostRow(capture) {
  const cost = capture.response.body?.usage?.cost;
  if (typeof cost !== "number") throw new Error("OpenRouter response did not report cost");
  return {
    provider: "openrouter",
    model: capture.model,
    usage: capture.normalized.usage,
    cost,
    costSource: "provider",
  };
}

function required(value, label) {
  if (value === undefined) throw new Error(`Missing captured ${label}`);
  return value;
}

function requireKeys() {
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    if (!process.env[name]) throw new Error(`${name} is required for live capture`);
  }
}

const ticketInput =
  "Hi there—or whoever is reading this, I suppose you'll tell me everything is working as intended, but please start by saying hello and explaining what you can do. I ordered the OrbitMesh Mini router and the NightOwl indoor camera because the product page made the setup sound painless; I nearly bought the OrbitMesh Pro instead and now rather wish I had. The router drops the connection every twenty minutes unless I reboot it, while the camera sometimes records a perfectly empty room but misses people walking through it, although yesterday both behaved for nearly an hour so maybe I'm somehow doing this wrong. I've already swapped cables, reset everything twice, moved the router, reinstalled the app, and read three support articles that mostly repeat each other. I also paid £4.99 for next-day delivery that arrived on a Tuesday. I paid £89.99 for the pair and want it back, unless there is an actual fix that does not involve spending another evening rebuilding my network. This has been a fantastic use of my weekend—thanks, honestly.";

const ticketSchema = {
  type: "object",
  properties: {
    summary: { type: "string", maxLength: 120 },
    sentiment: { type: "string", enum: ["angry", "neutral", "pleased"] },
    urgency: { type: "integer", enum: [1, 2, 3, 4, 5] },
    products: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, issue: { type: "string" } },
        required: ["name", "issue"],
        additionalProperties: false,
      },
    },
    refundAsk: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["summary", "sentiment", "urgency", "products", "refundAsk"],
  additionalProperties: false,
};

const anthropic = await captureProvider("anthropic", models.anthropic, (fetch) =>
  createAnthropicProvider({ fetch }),
);
const openai = await captureProvider("openai", models.openai, (fetch) =>
  createOpenAIProvider({ fetch }),
);
const openrouter = await captureProvider("openrouter", models.openrouter, (fetch) =>
  createOpenRouterProvider({ fetch }),
);

const finding3Captures = [
  await captureOrRead("live/finding-3-openai-1024", captureFinding3),
];
for (let attempt = 2; attempt <= 4 && !reproducedFinding3(finding3Captures); attempt += 1) {
  finding3Captures.push(
    await captureOrRead(`live/finding-3-openai-1024-${attempt}`, captureFinding3),
  );
}
await captureOrRead("live/openrouter-strict-tool", captureOpenRouterStrict);
await captureOrRead("live/cost-comparison", async () => ({
  capturedAt: capturedAt.toISOString(),
  priceSnapshot: capturedAt.toISOString().slice(0, 10),
  prompt: costPrompt,
  rows: [
    computedCostRow("anthropic", anthropic),
    computedCostRow("openai", openai),
    providerCostRow(openrouter),
  ],
}));

console.log("Live captures written under evidence/live/ (existing files are never overwritten).");

function reproducedFinding3(captures) {
  return captures.some((capture) =>
    capture.observation?.finishReason === "length" &&
    capture.observation?.observedCalls === 0
  );
}
