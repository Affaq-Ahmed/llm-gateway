import type {
  GatewayRequest,
  GatewayResponse,
  StreamEvent,
} from "../types.js";

export type ProviderFeature = "cacheControl" | "constrainedJson";

export interface Provider {
  readonly name: string;
  complete(request: GatewayRequest): Promise<GatewayResponse>;
  stream(request: GatewayRequest): AsyncIterable<StreamEvent>;
  supports(feature: ProviderFeature): boolean;
}

export async function* streamNotImplemented(
  provider: string,
): AsyncIterable<StreamEvent> {
  throw new Error(`Streaming is not implemented for ${provider}`);
}
