// nonces.ts: the envelope nonces the relay has already accepted.
//
// A nonce stays until its envelope could no longer pass the expiry check,
// so a copy of an envelope is refused for as long as it would otherwise be
// valid. The cache has a fixed size. When it is full of live nonces, the
// relay refuses new envelopes as busy instead of forgetting a nonce early.

export const DEFAULT_NONCE_CAPACITY = 100_000;

export type NonceResult = "accepted" | "replayed" | "full";

export class NonceCache {
  // Map keeps insertion order, and envelopes arrive in about the order they
  // expire, so the oldest entries sit at the front.
  private readonly seen = new Map<string, number>();

  constructor(private readonly capacity: number = DEFAULT_NONCE_CAPACITY) {}

  get size(): number {
    return this.seen.size;
  }

  /** Record a nonce until forgetAt (epoch ms), unless it is already recorded or the cache is full. */
  claim(nonce: string, forgetAt: number, now: number): NonceResult {
    const known = this.seen.get(nonce);
    if (known !== undefined) {
      if (known > now) return "replayed";
      this.seen.delete(nonce);
    }
    this.purge(now);
    if (this.seen.size >= this.capacity) this.sweep(now);
    if (this.seen.size >= this.capacity) return "full";
    this.seen.set(nonce, forgetAt);
    return "accepted";
  }

  /** Drop expired entries from the front, stopping at the first live one. */
  private purge(now: number): void {
    for (const [nonce, forgetAt] of this.seen) {
      if (forgetAt > now) return;
      this.seen.delete(nonce);
    }
  }

  /**
   * Drop every expired entry. An envelope with a longer life can sit in
   * front of ones that expire sooner, so before answering full the cache
   * looks past the first live entry.
   */
  private sweep(now: number): void {
    for (const [nonce, forgetAt] of this.seen) {
      if (forgetAt <= now) this.seen.delete(nonce);
    }
  }
}
