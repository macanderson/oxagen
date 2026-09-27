/**
 * The nonces the local gateway has run, held in memory so it runs each
 * envelope once.
 *
 * An envelope lives at most ENVELOPE_TTL_MAX_MS, and the gateway refuses one
 * past its expiry plus the clock skew it allows. A nonce therefore needs
 * holding only until that moment: after it, the envelope is refused as
 * expired whatever its nonce. Nothing is written to disk. A restart forgets
 * every nonce, and every envelope signed before the restart expires within
 * the TTL.
 */

export interface NonceLedger {
  /** Whether the ledger holds the nonce at `nowMs`. Prunes what has lapsed first. */
  seen(nonce: string, nowMs: number): boolean;
  /** Hold the nonce until `expiresAtMs` plus the ledger's skew. Prunes what has lapsed first. */
  remember(nonce: string, expiresAtMs: number, nowMs: number): void;
  /** How many nonces the ledger holds. */
  size(): number;
}

export function createNonceLedger(options: { skewMs: number }): NonceLedger {
  const heldUntil = new Map<string, number>();

  function prune(nowMs: number): void {
    for (const [nonce, until] of heldUntil) {
      if (until <= nowMs) heldUntil.delete(nonce);
    }
  }

  return {
    seen(nonce, nowMs) {
      prune(nowMs);
      return heldUntil.has(nonce);
    },
    remember(nonce, expiresAtMs, nowMs) {
      prune(nowMs);
      heldUntil.set(nonce, expiresAtMs + options.skewMs);
    },
    size() {
      return heldUntil.size;
    },
  };
}
