/**
 * Direct-Anthropic model routing for BYOK mode without a gateway key.
 *
 * The CLI normally passes plain gateway slugs (`vendor/model`) to the AI SDK,
 * which resolves them through the Vercel AI Gateway using `AI_GATEWAY_API_KEY`
 * (the SDK's default global provider). When the user has only an
 * `ANTHROPIC_API_KEY`, we install a replacement global provider
 * (`globalThis.AI_SDK_DEFAULT_PROVIDER`) that routes `anthropic/*` slugs
 * straight to the Anthropic API via `@ai-sdk/anthropic` — every existing call
 * site that passes a string model id keeps working unchanged.
 *
 * Scope of this mode is deliberately narrow:
 *   - Only `anthropic/*` models resolve; other vendors throw a clear error
 *     telling the user to set `AI_GATEWAY_API_KEY` or pick an Anthropic model.
 *   - No embeddings (Anthropic has no embeddings API) — the semantic index
 *     already degrades gracefully when `ensureGatewayKey` returns null.
 *   - `providerOptions.anthropic` (adaptive thinking, prompt caching) is the
 *     same namespace the direct provider reads, so reasoning effort and cache
 *     breakpoints behave identically to the gateway path.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderV3 } from "@ai-sdk/provider";

const ANTHROPIC_PREFIX = "anthropic/";

/** Thrown when a non-Anthropic model is requested with only ANTHROPIC_API_KEY. */
export class AnthropicOnlyModelError extends Error {
  constructor(modelId: string) {
    super(
      `Model "${modelId}" requires the Vercel AI Gateway, but only ANTHROPIC_API_KEY ` +
        `is configured (Anthropic models only). Set AI_GATEWAY_API_KEY to use other ` +
        `vendors, or pick an Anthropic model (e.g. \`oxagen config model anthropic/claude-sonnet-5\`).`,
    );
    this.name = "AnthropicOnlyModelError";
  }
}

/**
 * Map a gateway slug to a direct Anthropic model id: `anthropic/claude-sonnet-5`
 * → `claude-sonnet-5`. A bare id with no vendor prefix is assumed Anthropic
 * (matches how the user would write it against the Anthropic API directly).
 * Throws {@link AnthropicOnlyModelError} for any other vendor prefix.
 */
export function toDirectAnthropicModelId(modelId: string): string {
  if (modelId.startsWith(ANTHROPIC_PREFIX)) {
    return modelId.slice(ANTHROPIC_PREFIX.length);
  }
  if (!modelId.includes("/")) return modelId;
  throw new AnthropicOnlyModelError(modelId);
}

/**
 * Install a global AI SDK default provider that resolves string model ids
 * against the Anthropic API with the given key. Idempotent — the first key
 * wins for the process lifetime (matches how the gateway key is pinned into
 * `process.env` once resolved).
 */
export function installDirectAnthropicProvider(apiKey: string): void {
  const g = globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV3 };
  if (g.AI_SDK_DEFAULT_PROVIDER) return;

  const anthropic = createAnthropic({ apiKey });
  const provider: ProviderV3 = {
    specificationVersion: "v3",
    languageModel: (modelId) =>
      anthropic.languageModel(toDirectAnthropicModelId(modelId)),
    embeddingModel: (modelId) => {
      throw new Error(
        `Cannot resolve embedding model "${modelId}": the Anthropic API has no ` +
          `embeddings endpoint. Set AI_GATEWAY_API_KEY to enable embeddings.`,
      );
    },
    imageModel: (modelId) => {
      throw new Error(
        `Cannot resolve image model "${modelId}": the Anthropic API has no ` +
          `image-generation endpoint. Set AI_GATEWAY_API_KEY to enable image models.`,
      );
    },
  };
  g.AI_SDK_DEFAULT_PROVIDER = provider;
}

/** Test-only: remove an installed direct provider so cases stay independent. */
export function uninstallDirectAnthropicProviderForTests(): void {
  delete (globalThis as { AI_SDK_DEFAULT_PROVIDER?: ProviderV3 })
    .AI_SDK_DEFAULT_PROVIDER;
}
