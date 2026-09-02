/**
 * PN-Counter (Positive-Negative Counter) — a CRDT counter that supports
 * both increment and decrement from multiple nodes.
 *
 * Each node maintains its own positive and negative counts.
 * The global value = sum(all positives) - sum(all negatives).
 * Merge = point-wise max on each node's P and N vectors.
 *
 * The per-node P and N registers are **grow-only** — that invariant is what
 * makes point-wise max a valid join (convergent, commutative, associative,
 * idempotent). Feeding a negative amount into either register would break the
 * monotonicity the merge relies on, so `increment`/`decrement` reject negative
 * and non-finite amounts.
 *
 * Used for: unbounded additive tallies (e.g. success/failure counts).
 */

/**
 * Guard the grow-only invariant of the P and N registers. A finite amount of
 * zero is allowed (a no-op); anything negative or non-finite is a programming
 * error that would silently break convergence, so it throws.
 */
function assertGrowOnlyAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new RangeError(
      `PNCounter increment/decrement amount must be a finite, non-negative number; got ${amount}`,
    );
  }
}

export class PNCounter {
  private positive: Map<string, number>;
  private negative: Map<string, number>;

  constructor() {
    this.positive = new Map();
    this.negative = new Map();
  }

  /**
   * Increment the counter from a specific node.
   * @throws RangeError if `amount` is negative or non-finite.
   */
  increment(nodeId: string, amount = 1): void {
    assertGrowOnlyAmount(amount);
    this.positive.set(nodeId, (this.positive.get(nodeId) ?? 0) + amount);
  }

  /**
   * Decrement the counter from a specific node.
   * @throws RangeError if `amount` is negative or non-finite.
   */
  decrement(nodeId: string, amount = 1): void {
    assertGrowOnlyAmount(amount);
    this.negative.set(nodeId, (this.negative.get(nodeId) ?? 0) + amount);
  }

  /**
   * Get the current value (sum of all increments - sum of all decrements).
   */
  value(): number {
    let pos = 0;
    let neg = 0;
    for (const v of this.positive.values()) pos += v;
    for (const v of this.negative.values()) neg += v;
    return pos - neg;
  }

  /**
   * Merge two PN-Counters (point-wise max on both P and N vectors).
   * Commutative, associative, idempotent.
   */
  merge(other: PNCounter): PNCounter {
    const result = new PNCounter();

    // Merge positive vectors
    const allPosNodes = new Set([
      ...this.positive.keys(),
      ...other.positive.keys(),
    ]);
    for (const node of allPosNodes) {
      result.positive.set(
        node,
        Math.max(this.positive.get(node) ?? 0, other.positive.get(node) ?? 0),
      );
    }

    // Merge negative vectors
    const allNegNodes = new Set([
      ...this.negative.keys(),
      ...other.negative.keys(),
    ]);
    for (const node of allNegNodes) {
      result.negative.set(
        node,
        Math.max(this.negative.get(node) ?? 0, other.negative.get(node) ?? 0),
      );
    }

    return result;
  }

  /** Export state for serialization. */
  toJSON(): {
    positive: Record<string, number>;
    negative: Record<string, number>;
  } {
    return {
      positive: Object.fromEntries(this.positive),
      negative: Object.fromEntries(this.negative),
    };
  }

  /** Create from serialized state. */
  static fromJSON(data: {
    positive: Record<string, number>;
    negative: Record<string, number>;
  }): PNCounter {
    const counter = new PNCounter();
    for (const [k, v] of Object.entries(data.positive))
      counter.positive.set(k, v);
    for (const [k, v] of Object.entries(data.negative))
      counter.negative.set(k, v);
    return counter;
  }
}
