import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { requireEnv } from "@oxagen/config/env";

export type ProviderName = "anthropic" | "openai";

export interface ModelSelector {
  provider?: ProviderName;
  model?: string;
}

// Anthropic Claude Sonnet 4.6 is the platform default; spec §15 names the
// Vercel AI SDK as the agent runner. We resolve API keys eagerly so a missing
// key fails the request rather than the stream mid-flight.
const DEFAULTS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
} as const satisfies Record<ProviderName, string>;

export function selectModel(selector: ModelSelector = {}): LanguageModel {
  const env = requireEnv(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const);
  const provider = selector.provider ?? "anthropic";
  const modelId = selector.model ?? DEFAULTS[provider];

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      return anthropic(modelId);
    }
    const client = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return client(modelId);
  }

  if (!env.OPENAI_API_KEY) {
    return openai(modelId);
  }
  const client = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return client(modelId);
}

export const defaultModel = () => selectModel();
