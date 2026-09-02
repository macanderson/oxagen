// retry.ts — minimal backoff-retry helper for durability-critical
// fire-and-forget writes (security audit events, tamper-evident
// audit chain hashes).
//
// This is deliberately small: fixed attempt count, exponential backoff, no
// jitter/circuit-breaker integration. It exists so a transient blip (a single
// dropped connection, a momentary ClickHouse/Postgres hiccup) doesn't silently
// drop a SOC2-relevant audit row on the first failure. It is NOT a substitute
// for the circuit breakers in circuit-breaker.ts — those guard against a
// store that is down for an extended period; this guards against the much
// more common single-shot transient failure. Callers that exhaust every
// attempt are expected to escalate via captureError (see error-reporting.ts)
// rather than swallow the final failure.

export interface RetryOptions {
  /** Total attempts, including the first. Defaults to 3. */
  attempts?: number;
  /** Base delay in ms before the first retry; doubles each subsequent retry (exponential). Defaults to 25ms. */
  baseDelayMs?: number;
}

/**
 * Retry an async operation with exponential backoff. Resolves with the first
 * successful result; rethrows the LAST error once every attempt is exhausted
 * so the caller can decide what "give up" means (alert, dead-letter, refuse
 * to persist a corrupt row, etc). Never swallows the terminal failure.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  // Floor at one attempt: a caller passing 0/negative would otherwise skip the
  // loop entirely and reject with `undefined` — a rejection carrying no error,
  // which every catch site here would log as "undefined".
  const attempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const baseDelayMs = options.baseDelayMs ?? 25;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === attempts - 1;
      if (!isLastAttempt) {
        const delayMs = baseDelayMs * 2 ** attempt;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastErr;
}
