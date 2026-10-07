import type {
  GatewayRequest,
  GatewayResponse,
  StreamEvent,
} from "../types.js";

export type ProviderFeature = "cacheControl" | "constrainedJson";

export type StreamActivityHooks = {
  readonly onBytes?: () => void;
  readonly onContent?: () => void;
};

export interface Provider {
  readonly name: string;
  complete(request: GatewayRequest): Promise<GatewayResponse>;
  stream(
    request: GatewayRequest,
    activity?: StreamActivityHooks,
  ): AsyncIterable<StreamEvent>;
  supports(feature: ProviderFeature): boolean;
}
