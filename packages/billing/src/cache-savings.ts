/**
 * cache-savings.ts — a window's net cache saving, priced from the price book
 * (#4069). `get_usage_breakdown` answers it as `cacheSavingsMicros`.
 *
 * The input is the class-bucket read (`readObservedModels` in
 * @oxagen/telemetry): each model's usage by token class, split at the
 * instants the book's answer could change ({@link priceBookBoundaries}). One
 * probe per bucket prices the whole bucket, the same argument
 * ./unpriced-models.ts makes. The arithmetic is ./class-cost.ts
 * `priceClasses`, the helper the run rollup prices every frame with, so a
 * saving shown here and one recorded on a run are priced the same way.
 *
 * Net of the write premium, as the figure has always been:
 *   saving  = cache_read × (input_uncached rate − cache_read rate)
 *   premium = cache_write_5m × (5m write rate − input_uncached rate)
 *           + cache_write_1h × (1h write rate − input_uncached rate)
 *   net     = Σ saving − Σ premium, over every bucket, rounded once.
 *
 * A bucket the book cannot price (a rate missing at its instant) adds
 * nothing and is counted in `unpricedBuckets`. The contract's figure is a
 * plain integer with no null, so a gap is reported beside it, never priced
 * from a guessed rate.
 */
import { priceClasses, type ResolvedClassEntries } from "./class-cost";
import { divideHalfEven } from "./cost-rollup";
import {
  indexPriceBookByClass,
  resolvePriceEntryFromClassBook,
  type PriceBook,
  type PriceTokenClass,
} from "./price-book";

/** The classes a cache saving is priced from; the boundaries the read needs. */
export const CACHE_SAVING_TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
] as const satisfies readonly PriceTokenClass[];

type CacheClass = Exclude<
  (typeof CACHE_SAVING_TOKEN_CLASSES)[number],
  "input_uncached"
>;
const CACHE_CLASSES: ReadonlySet<string> = new Set<CacheClass>([
  "cache_read",
  "cache_write_5m",
  "cache_write_1h",
]);

/** One class of one model within one price-boundary bucket. */
export interface CacheSavingBucket {
  tokenClass: string;
  tokens: number;
  /** Any instant inside the bucket; the read reports the first call's. */
  firstSeen: Date | string;
}

export interface NetCacheSavings {
  /** Σ saving − Σ write premium, in micro-USD, rounded once half to even. */
  micros: bigint;
  /** Cache buckets left out because a rate they need was missing. */
  unpricedBuckets: number;
}

/**
 * The net cache saving over a window's class buckets, each priced from the
 * book at an instant inside its own bucket.
 */
export function netCacheSavingsFromBook(args: {
  observed: readonly {
    model: string;
    classes: readonly CacheSavingBucket[];
  }[];
  book: PriceBook;
  orgId: string;
}): NetCacheSavings {
  const byClass = indexPriceBookByClass(args.book);
  const resolve = (tokenClass: PriceTokenClass, modelId: string, at: Date) =>
    resolvePriceEntryFromClassBook(byClass.get(tokenClass) ?? [], {
      orgId: args.orgId,
      modelId,
      at,
    });

  let scaled = 0n;
  let unpricedBuckets = 0;
  for (const model of args.observed) {
    for (const bucket of model.classes) {
      if (!CACHE_CLASSES.has(bucket.tokenClass) || bucket.tokens <= 0) continue;
      const tokenClass = bucket.tokenClass as CacheClass;
      const at = new Date(bucket.firstSeen);
      const entries: ResolvedClassEntries = {
        input_uncached: resolve("input_uncached", model.model, at),
        [tokenClass]: resolve(tokenClass, model.model, at),
      };
      const priced = priceClasses(entries, { [tokenClass]: bucket.tokens });
      const part =
        tokenClass === "cache_read"
          ? priced.cacheSavingScaled
          : priced.cacheWritePremiumScaled === null
            ? null
            : -priced.cacheWritePremiumScaled;
      if (part === null) {
        unpricedBuckets += 1;
        continue;
      }
      scaled += part;
    }
  }
  return { micros: divideHalfEven(scaled, 1_000_000n), unpricedBuckets };
}
