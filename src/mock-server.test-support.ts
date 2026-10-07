import http from "node:http";

export type MockFault =
  | { readonly kind: "status"; readonly status: 400 | 429 | 500; readonly failTimes?: number; readonly retryAfter?: string }
  | { readonly kind: "hang" }
  | { readonly kind: "stream-stall"; readonly failTimes?: number }
  | { readonly kind: "ping-stall"; readonly failTimes?: number };

export type MockServer = {
  readonly baseUrl: string;
  readonly calls: () => number;
  close(): Promise<void>;
};

export async function startMockServer(fault: MockFault): Promise<MockServer> {
  let calls = 0;
  const pending = new Set<http.ServerResponse>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = http.createServer((request, response) => {
    calls += 1;
    const provider = request.url?.includes("anthropic") ? "anthropic" : "openai";
    const failTimes = "failTimes" in fault ? fault.failTimes : undefined;
    const shouldFail = calls <= (failTimes ?? Number.POSITIVE_INFINITY);
    if (!shouldFail) {
      if (fault.kind === "stream-stall" || fault.kind === "ping-stall") {
        writeAnthropicSuccessStream(response);
      } else {
        writeSuccess(response, provider);
      }
      return;
    }

    if (fault.kind === "status") {
      const headers: http.OutgoingHttpHeaders = { "content-type": "application/json" };
      if (fault.retryAfter !== undefined) headers["retry-after"] = fault.retryAfter;
      response.writeHead(fault.status, headers);
      response.end(JSON.stringify(provider === "anthropic"
        ? { type: "error", error: { type: errorType(fault.status), message: "mock failure" } }
        : { error: { type: errorType(fault.status), message: "mock failure" } }));
      return;
    }

    pending.add(response);
    response.on("close", () => pending.delete(response));
    if (fault.kind === "hang") return;

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeAnthropicEvent(response, "message_start", {
      type: "message_start",
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-haiku-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    if (fault.kind === "stream-stall") {
      writeAnthropicEvent(response, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      });
      writeAnthropicEvent(response, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      });
      return;
    }

    writeAnthropicEvent(response, "ping", { type: "ping" });
    const timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        clearInterval(timer);
        timers.delete(timer);
      } else {
        writeAnthropicEvent(response, "ping", { type: "ping" });
      }
    }, 10);
    timers.add(timer);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const response of pending) response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function writeSuccess(response: http.ServerResponse, provider: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(provider === "anthropic"
    ? {
        id: "msg_ok",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok", citations: null }],
        model: "claude-haiku-4-5",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 1 },
      }
    : {
        id: "chat_ok",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok", refusal: null } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
}

function writeAnthropicEvent(response: http.ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicSuccessStream(response: http.ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  writeAnthropicEvent(response, "message_start", {
    type: "message_start",
    message: {
      id: "msg_ok",
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-haiku-4-5",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  writeAnthropicEvent(response, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  });
  writeAnthropicEvent(response, "content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  });
  writeAnthropicEvent(response, "content_block_stop", {
    type: "content_block_stop",
    index: 0,
  });
  writeAnthropicEvent(response, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: 2, output_tokens: 1 },
  });
  writeAnthropicEvent(response, "message_stop", { type: "message_stop" });
  response.end();
}

function errorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  return "api_error";
}
