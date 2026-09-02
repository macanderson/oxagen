/**
 * Model-family resolution — the single source of truth for mapping a model id
 * to its tokenizer/budget family.
 *
 * This was duplicated in `tokenizer.ts` and `compile.ts`, and both copies
 * missed the reasoning-model families (`o3`, `o3-mini`, `o4-mini`): a bare
 * `lower.includes("o1")` never matches `o3-mini`, so those models fell through
 * to the character estimator instead of tiktoken. Extracting one implementation
 * (and fixing the OpenAI reasoning-model match) keeps budget math consistent
 * across the packer and the budget computation.
 */

export type ModelFamily = "openai" | "anthropic" | "google" | "default";

/**
 * OpenAI reasoning models: `o1`, `o3`, `o4` (and their `-mini` / `-pro`
 * variants), matched as a token boundary so we don't accidentally catch an
 * unrelated substring. `o[134]` covers the shipped reasoning line; the trailing
 * `(?:-|$|\b)` requires the digit to end the family token or be followed by a
 * `-mini`/`-preview` style suffix, so `gpt-4o` (handled by the `gpt` branch)
 * and arbitrary ids containing `o1abc` don't false-match.
 */
const OPENAI_REASONING = /\bo[134](?:-|$)/;

/**
 * Resolve the tokenizer/budget family for a model id. Case-insensitive.
 */
export function resolveFamily(modelId: string): ModelFamily {
  const lower = modelId.toLowerCase();
  if (
    lower.includes("gpt") ||
    lower.includes("openai") ||
    OPENAI_REASONING.test(lower)
  ) {
    return "openai";
  }
  if (lower.includes("claude") || lower.includes("anthropic"))
    return "anthropic";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  return "default";
}
