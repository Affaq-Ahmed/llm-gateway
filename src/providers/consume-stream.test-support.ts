import type { GatewayRequest, StreamEvent } from "../types.js";
import type { Provider } from "./provider.js";

export async function consumeStream(
  provider: Provider,
  request: GatewayRequest,
): Promise<readonly StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}
