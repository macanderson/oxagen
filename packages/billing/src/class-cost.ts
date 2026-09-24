/**
 * class-cost.ts — the one place a token count meets a price (ADR-060, #4069).
 *
 * Given the price entries already resolved for one model at one instant, and
 * that model's token counts by class, this answers what each class cost and
 * what the cache saved. The run rollup (./cost-rollup.ts `priceFrame`) calls
 * it once per frame, at the frame's instant. The usage breakdown's cache
 * saving (`get_usage_breakdown`) calls it once per price-boundary bucket, at
 * an instant inside that bucket. Neither caller multiplies a rate by a count
 * itself, so the two figures cannot be priced two different ways.
 *
 * Pure. Resolving the entries is the caller's job, because the caller knows
 * the instant and holds the book.
 *
 * Every figure is "scaled": units × micros per million, a million times the
 * micro-USD figure. A caller sums scaled figures and rounds once, half to
 * even, at the end ({@link import("./cost-rollup").divideHalfEven}).
 */
import type { PriceEntry } from "./price-book";

/** The token classes a model-call frame carries (spec §12.6). */
export const FRAME_TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
  "output",
  "reasoning",
] as const;
export type FrameTokenClass = (typeof FRAME_TOKEN_CLASSES)[number];

/** The cache-write classes, whose premium is measured against fresh input. */
const CACHE_WRITE_CLASSES = ["cache_write_5m", "cache_write_1h"] as const;

/** The two fields of a price entry the arithmetic reads. */
export type ClassPrice = Pick<PriceEntry, "id" | "microsPerMillion">;

/**
 * The entry that prices each class for one model at one instant. A class
 * that is absent or null has no entry: nothing in the book prices it then.
 */
export type ResolvedClassEntries = Partial<
  Record<FrameTokenClass, ClassPrice | null>
>;

/** Token counts by class. An absent class counts as zero. */
export type ClassTokens = Partial<Record<FrameTokenClass, number>>;

export interface ClassCost {
  /** Units × micros per million, by class. A class with no entry is 0n. */
  scaledByClass: Record<FrameTokenClass, bigint>;
  /** The sum of {@link scaledByClass}. */
  scaled: bigint;
  /** The entries that priced a class with units, deduplicated. */
  priceEntryIds: string[];
  /** Classes that had units and no entry, in {@link FRAME_TOKEN_CLASSES} order. */
  missedClasses: FrameTokenClass[];
  /**
   * What the cache reads saved: cache_read units × (input_uncached rate −
   * cache_read rate), the reads priced as fresh input less what they cost.
   * 0n with no cache reads. Null when there were cache reads and either rate
   * is missing, because a saving priced from one rate is not a saving.
   */
  cacheSavingScaled: bigint | null;
  /**
   * What the cache writes cost over fresh input: for each write class,
   * units × (write rate − input_uncached rate). 0n with no cache writes.
   * Null when a write class had units and either of its two rates is
   * missing.
   */
  cacheWritePremiumScaled: bigint | null;
}

const zeroByClass = (): Record<FrameTokenClass, bigint> => ({
  input_uncached: 0n,
  cache_read: 0n,
  cache_write_5m: 0n,
  cache_write_1h: 0n,
  output: 0n,
  reasoning: 0n,
});

const unitsOf = (tokens: ClassTokens, c: FrameTokenClass): number =>
  tokens[c] ?? 0;

/**
 * The classes a caller must resolve before calling {@link priceClasses}:
 * every class with units, and `input_uncached` whenever the cache was read
 * or written, since the saving and the write premium are both measured
 * against it even when the call sent no fresh input.
 */
export function classesToResolve(tokens: ClassTokens): FrameTokenClass[] {
  const out = FRAME_TOKEN_CLASSES.filter((c) => unitsOf(tokens, c) > 0);
  const cacheUsed =
    unitsOf(tokens, "cache_read") > 0 ||
    CACHE_WRITE_CLASSES.some((c) => unitsOf(tokens, c) > 0);
  if (cacheUsed && !out.includes("input_uncached"))
    out.unshift("input_uncached");
  return out;
}

/**
 * Price token counts against the entries resolved for one model at one
 * instant: the cost of each class, the cache saving and the cache-write
 * premium, all scaled.
 */
export function priceClasses(
  entries: ResolvedClassEntries,
  tokens: ClassTokens,
): ClassCost {
  const scaledByClass = zeroByClass();
  let scaled = 0n;
  const ids = new Set<string>();
  const missedClasses: FrameTokenClass[] = [];
  for (const c of FRAME_TOKEN_CLASSES) {
    const units = unitsOf(tokens, c);
    if (units <= 0) continue;
    const entry = entries[c];
    if (!entry) {
      missedClasses.push(c);
      continue;
    }
    ids.add(entry.id);
    const part = BigInt(units) * entry.microsPerMillion;
    scaledByClass[c] = part;
    scaled += part;
  }

  const input = entries.input_uncached ?? null;
  const reads = unitsOf(tokens, "cache_read");
  const readEntry = entries.cache_read ?? null;
  const cacheSavingScaled =
    reads <= 0
      ? 0n
      : input === null || readEntry === null
        ? null
        : BigInt(reads) * (input.microsPerMillion - readEntry.microsPerMillion);

  let cacheWritePremiumScaled: bigint | null = 0n;
  for (const c of CACHE_WRITE_CLASSES) {
    const units = unitsOf(tokens, c);
    if (units <= 0) continue;
    const write = entries[c] ?? null;
    if (input === null || write === null) {
      cacheWritePremiumScaled = null;
      break;
    }
    cacheWritePremiumScaled +=
      BigInt(units) * (write.microsPerMillion - input.microsPerMillion);
  }

  return {
    scaledByClass,
    scaled,
    priceEntryIds: [...ids],
    missedClasses,
    cacheSavingScaled,
    cacheWritePremiumScaled,
  };
}
