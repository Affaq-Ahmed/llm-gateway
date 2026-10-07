import type {
  GatewayRequest,
  GatewayResponse,
  JsonSchema,
  StructuredMode,
  StreamEvent,
} from "../types.js";

export type ProviderFeature = "cacheControl" | "constrainedJson";

export type StreamActivityHooks = {
  readonly onBytes?: () => void;
  readonly onContent?: () => void;
};

export type StructuredExecution = {
  readonly mode: StructuredMode;
  readonly schema: JsonSchema;
  readonly repairPrompt?: string;
};

export type ProviderCompleteOptions = Pick<StreamActivityHooks, "onBytes"> & {
  readonly structured?: StructuredExecution;
};

export interface Provider {
  readonly name: string;
  complete(
    request: GatewayRequest,
    options?: ProviderCompleteOptions,
  ): Promise<GatewayResponse>;
  stream(
    request: GatewayRequest,
    activity?: StreamActivityHooks,
  ): AsyncIterable<StreamEvent>;
  supports(feature: ProviderFeature): boolean;
}
