// Which fields each provider needs. The same two rules the contract enforces
// (`requiresCustomerBaseUrl`, `requiresModelMap` in
// org.model_credential.shared), spelled here so the client form can show and
// hide fields without importing a server contract. `model-funding.test.ts`
// pins the two copies to each other.
import type { ModelProvider } from "@/data/contracts/org";

/** Only an OpenAI-compatible endpoint takes a URL; the other four are spelled by Oxagen. */
export function needsBaseUrl(provider: ModelProvider): boolean {
  return provider === "openai_compatible";
}

/**
 * A direct-vendor key names its own models. OpenRouter and the Vercel AI
 * Gateway understand Oxagen's model names already, so they need none.
 */
export function needsModelMap(provider: ModelProvider): boolean {
  return provider !== "openrouter" && provider !== "gateway";
}

/** Display order: the two one-key-reaches-everything vendors first. */
export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  "openrouter",
  "gateway",
  "openai",
  "anthropic",
  "openai_compatible",
];
