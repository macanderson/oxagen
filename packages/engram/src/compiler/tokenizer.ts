/**
 * Model-aware token counting.
 *
 * Provides a fast, cached token counter that selects the right encoding
 * based on the model family. Used by the packer to enforce budget constraints.
 */

export interface Tokenizer {
  /** Count tokens in text. */
  count(text: string): number;
  /** Which model family this tokenizer handles. */
  modelFamily: string;
}

/**
 * Simple character-based token estimator.
 * Accurate to ~10% for English text. Used as the default when no
 * model-specific tokenizer is available.
 *
 * Rule of thumb: 1 token ≈ 4 characters for English,
 * 1 token ≈ 3.5 characters for code.
 */
class CharBasedTokenizer implements Tokenizer {
  readonly modelFamily = "estimate";
  private readonly charsPerToken: number;

  constructor(charsPerToken = 3.8) {
    this.charsPerToken = charsPerToken;
  }

  count(text: string): number {
    return Math.max(1, Math.ceil(text.length / this.charsPerToken));
  }
}

/** Singleton tokenizer instances, cached by model family. */
const cache = new Map<string, Tokenizer>();

/**
 * Get a tokenizer for the given model ID.
 *
 * Currently uses character-based estimation. When tiktoken or
 * @anthropic-ai/tokenizer are added as deps, this function will
 * route to the correct tokenizer based on model prefix.
 */
export function getTokenizer(modelId: string): Tokenizer {
  // Determine model family from ID prefix
  const family = resolveFamily(modelId);

  let tokenizer = cache.get(family);
  if (tokenizer) return tokenizer;

  // For now, all families use the character-based estimator.
  // TODO: Add tiktoken for "openai" family, @anthropic-ai/tokenizer for "anthropic"
  switch (family) {
    case "openai":
      tokenizer = new CharBasedTokenizer(4.0); // cl100k_base: ~4 chars/token
      break;
    case "anthropic":
      tokenizer = new CharBasedTokenizer(3.5); // Claude: slightly more efficient
      break;
    default:
      tokenizer = new CharBasedTokenizer(3.8);
  }

  cache.set(family, tokenizer);
  return tokenizer;
}

/**
 * Count tokens in text for a given model. Convenience wrapper.
 */
export function countTokens(text: string, modelId: string): number {
  return getTokenizer(modelId).count(text);
}

function resolveFamily(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("openai")) return "openai";
  if (lower.includes("claude") || lower.includes("anthropic")) return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  return "default";
}
