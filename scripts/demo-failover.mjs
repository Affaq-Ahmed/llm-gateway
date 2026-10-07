import http from "node:http";
import { writeFileSync } from "node:fs";
import {
  ZERO_USAGE,
  createGateway,
  toGatewayError,
} from "../dist/index.js";

const server = await startDemoServer();
const lines = [];
const input = {
  messages: [{ role: "user", content: "Demonstrate failover." }],
  maxTokens: 32,
};

try {
  await runPreContent();
  await runPostContent(false);
  await runPostContent(true);
} finally {
  await server.close();
}

const transcriptFlag = process.argv.indexOf("--transcript");
if (transcriptFlag !== -1) {
  const path = process.argv[transcriptFlag + 1];
  if (!path) throw new Error("--transcript requires a path");
  writeFileSync(path, `${lines.join("\n")}\n`);
}

async function runPreContent() {
  output("PRE-CONTENT — transparent failover");
  const gateway = demoGateway("pre");
  for await (const event of gateway.stream(input, { tier: "demo" })) printEvent(event);
  output("");
}

async function runPostContent(restart) {
  output(restart
    ? "POST-CONTENT — explicit restart mode"
    : "POST-CONTENT — typed error by default");
  const gateway = demoGateway("post");
  try {
    for await (const event of gateway.stream(input, {
      tier: "demo",
      allowMidStreamRestart: restart,
    })) printEvent(event);
  } catch (error) {
    output(`error  ${error.name} provider=${error.provider} status=${error.status}`);
  }
  output("");
}

function demoGateway(scenario) {
  return createGateway({
    providers: [demoProvider("primary", scenario), demoProvider("fallback", scenario)],
    tiers: { demo: { primary: "mock", fallback: "mock" } },
    resilience: { retry: { maxAttempts: 1 } },
  });
}

function demoProvider(name, scenario) {
  return {
    name,
    supports: () => false,
    complete: async () => { throw new Error("The demo uses streaming only"); },
    async *stream() {
      const response = await fetch(`${server.baseUrl}/${scenario}/${name}`);
      const body = await response.json();
      for (const event of body.events) {
        if (event.type === "error") {
          // Upstream view: the consumer only sees what printEvent() prints.
          output(`  (upstream: ${name} failed with ${event.status})`);
          yield {
            type: "error",
            error: toGatewayError(name, event.status),
            usage: ZERO_USAGE,
          };
        } else if (event.type === "done") {
          yield {
            type: "done",
            stopReason: "end_turn",
            usage: { ...ZERO_USAGE, outputTokens: 2, totalTokens: 2 },
            ttftMs: 4,
            attempts: 1,
          };
        } else {
          yield event;
        }
      }
    },
  };
}

function printEvent(event) {
  if (event.type === "text") output(`text   ${event.delta}`);
  else if (event.type === "restart") output(`restart -> ${event.provider}`);
  else if (event.type === "done") output(`done   ${event.stopReason}`);
}

function output(line) {
  lines.push(line);
  console.log(line);
}

async function startDemoServer() {
  const instance = http.createServer((request, response) => {
    const [, scenario, provider] = request.url?.split("/") ?? [];
    let events;
    if (provider === "fallback") {
      events = [{ type: "text", delta: "complete response from fallback" }, { type: "done" }];
    } else if (scenario === "pre") {
      events = [{ type: "error", status: 500 }];
    } else {
      events = [{ type: "text", delta: "partial response from primary" }, { type: "error", status: 500 }];
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ events }));
  });
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  const address = instance.address();
  if (address === null || typeof address === "string") throw new Error("Missing mock address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) =>
      instance.close((error) => error ? reject(error) : resolve()),
    ),
  };
}
