/**
 * Classifying a model-provider failure.
 *
 * One question survives the step loop that used to ask several: is this error
 * fatal for every subsequent call, rather than worth another attempt? The
 * retry, overflow and stall classifiers that sat beside it went with the loop
 * that retried on them — Stella does its own retrying, on its own side.
 */

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
}

/**
 * Is this a fatal auth/billing error (no credits, bad key, unauthorized)? These
 * NEVER succeed on retry, and every other model call in the turn is doomed to
 * fail identically — so callers that would otherwise swallow an LLM error into
 * a "keep going" heuristic fallback (the evaluator, the completeness judge, the
 * best-of-N selector) must re-throw instead, failing the turn fast with the
 * real message rather than burning time on doomed calls before it resurfaces.
 */
export function isFatalAuthOrBillingError(err: unknown): boolean {
  const msg = errorText(err);
  return /insufficient_funds|positive credit balance|invalid.*api.?key|unauthorized|\b401\b|\b403\b/.test(
    msg,
  );
}
