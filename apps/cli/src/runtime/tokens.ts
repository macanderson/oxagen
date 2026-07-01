/**
 * Cheap, no-network token estimation for cost projections.
 *
 * Providers must expose `estimateCost` without touching a model, so we use the
 * standard ~4-characters-per-token heuristic. It is deliberately approximate:
 * good enough to compare models and warn about a big run, never billed against.
 */
import type { CompletionRequest } from "./types.js";

/** Rough token count for a string (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated input tokens for a request (sum of all message content). */
export function estimateInputTokens(req: CompletionRequest): number {
  return req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
