import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { ImageModel, LanguageModel } from "ai";
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

// ── Image model selection ─────────────────────────────────────────────────────
//
// Single chokepoint for all image model construction. Mirrors selectModel() so
// packages outside @oxagen/ai never import @ai-sdk/openai directly.
// Currently wraps DALL-E 3 only (the only AI SDK-supported image model). If
// additional image providers are added (Stability AI, Replicate, etc.) they
// extend here — callers remain unchanged.

export interface ImageModelSelector {
  /** Provider name. Currently only "openai" is supported. */
  provider?: "openai";
  /** Model id to use. Defaults to "dall-e-3". */
  model?: string;
}

const IMAGE_DEFAULTS = {
  openai: "dall-e-3",
} as const satisfies Record<NonNullable<ImageModelSelector["provider"]>, string>;

/**
 * Build and return the AI SDK `ImageModel` for the requested provider/model.
 *
 * Callers pass an optional {@link ImageModelSelector}; omitting it returns the
 * platform default (OpenAI DALL-E 3).  The function reads `OPENAI_API_KEY`
 * from the environment — if it is absent the caller is expected to handle the
 * no-key case (return a placeholder) before calling this function, exactly as
 * `image.generate.ts` does.
 */
export function selectImageModel(selector: ImageModelSelector = {}): ImageModel {
  const env = requireEnv(["OPENAI_API_KEY"] as const);
  const modelId = selector.model ?? IMAGE_DEFAULTS.openai;

  if (!env.OPENAI_API_KEY) {
    // Fall back to the default openai() client (uses OPENAI_API_KEY from env).
    return openai.image(modelId);
  }
  const client = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return client.image(modelId);
}
