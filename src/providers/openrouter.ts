import { createOpenAIProvider, type OpenAIProviderOptions } from "./openai.js";
import type { Provider } from "./provider.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type OpenRouterProviderOptions = Omit<
  OpenAIProviderOptions,
  "name" | "baseURL" | "constrainedJson" | "apiKey"
> & {
  readonly apiKey?: string;
};

export function createOpenRouterProvider(
  options: OpenRouterProviderOptions = {},
): Provider {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "OpenRouter API key is required; pass apiKey or set OPENROUTER_API_KEY",
    );
  }

  return createOpenAIProvider({
    ...options,
    name: "openrouter",
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    constrainedJson: false,
  });
}
