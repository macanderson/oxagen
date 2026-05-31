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

// Cache env parse and constructed LanguageModel instances so repeated calls
// (e.g. stream.ts and generate-object.ts calling defaultModel() per request)
// do not re-parse process.env or re-instantiate provider clients.
const _env = requireEnv(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const);
const _modelCache = new Map<string, LanguageModel>();

export function selectModel(selector: ModelSelector = {}): LanguageModel {
  const provider = selector.provider ?? "anthropic";
  const modelId = selector.model ?? DEFAULTS[provider];
  const cacheKey = `${provider}:${modelId}`;

  const cached = _modelCache.get(cacheKey);
  if (cached) return cached;

  let model: LanguageModel;
  if (provider === "anthropic") {
    if (!_env.ANTHROPIC_API_KEY) {
      model = anthropic(modelId);
    } else {
      const client = createAnthropic({ apiKey: _env.ANTHROPIC_API_KEY });
      model = client(modelId);
    }
  } else {
    if (!_env.OPENAI_API_KEY) {
      model = openai(modelId);
    } else {
      const client = createOpenAI({ apiKey: _env.OPENAI_API_KEY });
      model = client(modelId);
    }
  }

  _modelCache.set(cacheKey, model);
  return model;
}

export const defaultModel = () => selectModel();
