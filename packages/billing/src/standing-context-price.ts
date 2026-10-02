/**
 * standing-context-price.ts — what the context every request re-sends costs
 * (spec detector 2). PURE: ./standing-context-price-store.ts reads the rows.
 *
 * Every request re-sends the same prefix: the system prompt, the tool
 * definitions, and the steering stable prefix. The prompt cache makes each
 * re-read cheap, and the re-read still happens on every request. So one token
 * in the prefix costs its read price once per request, and a week of it costs
 * that price summed over the requests of the week.
 *
 * The findings pass and the run page price a run's re-reads with
 * `standingContextBySource`, from the costs and the re-sent split the rollup
 * recorded on the run. The tool and steering pages print a weekly price per
 * 1,000 tokens with `weeklyPriceOfTally`, from the book rates in force at each
 * of the workspace's requests of the last 7 days, and `weeklyCostOf` prices a
 * provider's or a record's tokens at it. Both price a re-read at the cache
 * read rate, or at the input rate when the request read nothing from the
 * cache.
 */
import {
  divideHalfEven,
  priceInputTokens,
  pricedTokensOf,
  runInputPrice,
  type CostBasis,
  type InputPrice,
  type ResentSourceTokens,
  type RunBreakdown,
} from "./cost-rollup";
import {
  indexPriceBookByClass,
  resolvePriceEntryFromClassBook,
  type PriceBook,
  type PriceEntry,
  type PriceTokenClass,
} from "./price-book";

/** The days the weekly price reads back from now. */
export const STANDING_CONTEXT_WEEK_DAYS = 7;

/** The tokens a weekly price is quoted for. */
export const WEEKLY_PRICE_TOKENS = 1_000;

type PricedRun = {
  costBasis: CostBasis | null;
  breakdown: Pick<RunBreakdown, "models">;
};

/** Whether a run's models read anything from the prompt cache. */
function readTheCache(run: PricedRun): boolean {
  return run.breakdown.models.some((m) => m.tokens.cache_read > 0);
}

/**
 * What a run paid for one prompt-cache read token, as a ratio; null when no
 * frame read the cache. A run whose cost is `estimated`, or has none, has no
 * price, as with `runInputPrice`.
 *
 * A zero price is a price: a model whose book rate for a cache read is 0, or
 * whose reads round to 0 micros, read the cache for free. The ratio divides
 * the reads' cost by the tokens of the calls the book priced
 * (`pricedTokensOf`), since the cost counts only those calls. A row rolled
 * up before those tokens were kept, with an unpriced call among a model's
 * cache reads, has no read price, because the ratio would read low.
 */
export function runReadPrice(run: PricedRun): InputPrice | null {
  if (run.costBasis === null || run.costBasis === "estimated") return null;
  let micros = 0n;
  let tokens = 0n;
  for (const m of run.breakdown.models) {
    if (m.tokens.cache_read === 0) continue;
    const priced = pricedTokensOf(m, "cache_read");
    if (priced === null) return null;
    micros += m.costByClass.cache_read;
    tokens += BigInt(priced);
  }
  if (tokens === 0n) return null;
  return { micros, tokens };
}

/** The workspace's weekly price per 1,000 tokens sent on every request. */
export interface WeeklyContextPrice {
  /** Micros a week for each 1,000 tokens of standing context. */
  perThousandMicros: bigint;
  currency: string;
  /** The workspace's requests of the week. The book priced every one. */
  requests: number;
  /** The start of the week the price reads. */
  since: Date;
}

/** The classes the weekly price reads rates for; the boundaries its read needs. */
export const WEEKLY_PRICE_TOKEN_CLASSES = [
  "input_uncached",
  "cache_read",
] as const satisfies readonly PriceTokenClass[];

/**
 * One model's week as the call-bucket read reports it (`readObservedModels`
 * with `callBuckets` in @oxagen/telemetry): its calls, and its calls in each
 * price-boundary bucket with how many of them read the cache.
 */
export interface WeekOfModel {
  model: string;
  /** Model calls in the week. */
  calls: number;
  buckets: readonly {
    /** Calls in the bucket. */
    calls: number;
    /** Of those calls, the ones that read the cache. */
    cacheReadCalls: number;
    /** Any instant inside the bucket. */
    firstSeen: Date | string;
  }[];
}

/**
 * A week's requests priced so far, summed over the pages of the read. Each
 * page adds its models with `tallyWeek`, and `weeklyPriceOfTally` rounds
 * the sum once at the end.
 */
export interface WeekTally {
  /**
   * Each priced request's rate in micros per million tokens, summed: a
   * million times the micros the week paid for one token of the prefix.
   */
  scaled: bigint;
  requests: number;
  unpricedRequests: number;
  currencies: Set<string>;
}

/** A tally with no request in it yet. */
export function emptyWeekTally(): WeekTally {
  return {
    scaled: 0n,
    requests: 0,
    unpricedRequests: 0,
    currencies: new Set(),
  };
}

/**
 * Adds one page of models to a week's tally, pricing each request's re-read
 * of the prefix at the rate in force in its own bucket. A request that read
 * the cache pays the cache read rate. A request that read nothing from the
 * cache sent the prefix uncached and pays the input rate. A request the book
 * has no rate for, or a call no bucket holds, counts as unpriced.
 */
export function tallyWeek(
  tally: WeekTally,
  args: { observed: readonly WeekOfModel[]; book: PriceBook; orgId: string },
): WeekTally {
  const byClass = indexPriceBookByClass(args.book);
  const rate = (
    tokenClass: (typeof WEEKLY_PRICE_TOKEN_CLASSES)[number],
    modelId: string,
    at: Date | string,
  ): PriceEntry | null =>
    resolvePriceEntryFromClassBook(byClass.get(tokenClass) ?? [], {
      orgId: args.orgId,
      modelId,
      at: new Date(at),
    });
  const add = (entry: PriceEntry | null, calls: number): void => {
    if (calls <= 0) return;
    if (entry === null) {
      tally.unpricedRequests += calls;
      return;
    }
    tally.scaled += BigInt(calls) * entry.microsPerMillion;
    tally.requests += calls;
    tally.currencies.add(entry.currency);
  };
  for (const model of args.observed) {
    let placed = 0;
    for (const bucket of model.buckets) {
      const reads = Math.min(bucket.cacheReadCalls, bucket.calls);
      add(rate("cache_read", model.model, bucket.firstSeen), reads);
      add(
        rate("input_uncached", model.model, bucket.firstSeen),
        bucket.calls - reads,
      );
      placed += bucket.calls;
    }
    // A call the buckets do not hold has no instant to price it at.
    if (model.calls > placed) tally.unpricedRequests += model.calls - placed;
  }
  return tally;
}

/**
 * The weekly price per 1,000 tokens a tally adds up to. Each request re-reads
 * the prefix once, so the week costs, per 1,000 tokens:
 *
 *   Σ over buckets: cache reads × 1,000 × the bucket's cache_read rate
 *     + other calls × 1,000 × the bucket's input_uncached rate
 *
 * A request that wrote the prefix to the cache paid the higher write rate, so
 * the quote is a floor for such a week. Each model's requests carry its own
 * rates, so a week split across models is weighted by each model's requests.
 *
 * Null when any request has no rate in the book. The quote would leave that
 * request out and read low, and the tool and steering pages would print the
 * floor as the price. Null as well when no request ran, or when the rates
 * name more than one currency.
 */
export function weeklyPriceOfTally(
  tally: WeekTally,
): Omit<WeeklyContextPrice, "since"> | null {
  const [currency, ...others] = tally.currencies;
  if (
    tally.unpricedRequests > 0 ||
    tally.requests === 0 ||
    currency === undefined ||
    others.length > 0
  )
    return null;
  return {
    perThousandMicros: divideHalfEven(
      tally.scaled * BigInt(WEEKLY_PRICE_TOKENS),
      1_000_000n,
    ),
    currency,
    requests: tally.requests,
  };
}

/** The weekly price of one page of models; see `weeklyPriceOfTally`. */
export function weeklyPriceFromBook(args: {
  observed: readonly WeekOfModel[];
  book: PriceBook;
  orgId: string;
}): Omit<WeeklyContextPrice, "since"> | null {
  return weeklyPriceOfTally(tallyWeek(emptyWeekTally(), args));
}

/**
 * The weekly price of `tokens` at a quoted per-1,000 price, in whole micros
 * rounded half to even. The tool and steering pages price a provider's or a
 * record's tokens with this.
 */
export function priceAtPerThousand(
  perThousandMicros: bigint,
  tokens: number,
): bigint {
  return divideHalfEven(
    BigInt(tokens) * perThousandMicros,
    BigInt(WEEKLY_PRICE_TOKENS),
  );
}

/**
 * What `tokens` sent on every request cost the workspace over the week, as
 * the wire carries a cost: the tokens at the week's price per 1,000, an
 * estimate. Null without either figure. The providers table and the steering
 * record cards both print this, so a provider and a record of the same size
 * show the same price.
 */
export function weeklyCostOf(
  tokens: number | null,
  price: Pick<WeeklyContextPrice, "perThousandMicros" | "currency"> | null,
): { micros: string; currency: string; basis: "estimated" } | null {
  if (tokens === null || price === null) return null;
  return {
    micros: priceAtPerThousand(price.perThousandMicros, tokens).toString(),
    currency: price.currency,
    basis: "estimated",
  };
}

/** A run's standing context by source; null where the recorder did not report it. */
export interface StandingContextSources {
  toolDefinitionTokens: number | null;
  contextFrameTokens: number | null;
  steeringTokens: number | null;
}

/**
 * The sources a run row carries. The stores read `StoredRunTotals`, and the
 * findings input and the handlers type the row as the record alone, so a
 * source a row does not carry reads as unreported.
 */
export function standingSourcesOf(run: object): StandingContextSources {
  const row = run as Partial<StandingContextSources>;
  return {
    toolDefinitionTokens: row.toolDefinitionTokens ?? null,
    contextFrameTokens: row.contextFrameTokens ?? null,
    steeringTokens: row.steeringTokens ?? null,
  };
}

/** The sources in the order the run page lists them. */
export const STANDING_SOURCES = [
  "toolDefinitionTokens",
  "steeringTokens",
  "contextFrameTokens",
] as const satisfies readonly (keyof StandingContextSources)[];

export type StandingSource = (typeof STANDING_SOURCES)[number];

/**
 * The tokens of one source that a run re-sent, estimated from its sum over
 * the run's model calls: the sum less one call's average share. A row rolled
 * up before the rollup kept the re-sent split holds only the sum, so this is
 * the best it can say. A run of one call re-sent nothing.
 */
export function resentTokens(tokens: number, requests: number): number {
  if (requests <= 1) return 0;
  return Math.round((tokens * (requests - 1)) / requests);
}

/** A run as the standing context price reads it. */
type StandingRun = {
  costBasis: CostBasis | null;
  breakdown: Pick<RunBreakdown, "models" | "standing">;
  modelCalls: number;
};

/**
 * Each source's tokens on the run's model calls after its first, split by
 * whether the call read the cache; null for a source no call reported.
 *
 * The rollup measures the split on the frames (#4572): the first call's own
 * count, whatever it was, is left out, and each later call's tokens fall on
 * the side of its own cache use. A row rolled up before that holds only each
 * source's sum, so the split is estimated from it with `resentTokens`, and
 * every token falls on one side: read from the cache when the run read the
 * cache at all, else sent uncached.
 */
export function resentSplitOf(
  run: StandingRun,
  sources: StandingContextSources,
): Record<StandingSource, ResentSourceTokens | null> {
  const stored = run.breakdown.standing;
  if (stored !== undefined)
    return {
      toolDefinitionTokens: stored.toolDefinitionTokens,
      steeringTokens: stored.steeringTokens,
      contextFrameTokens: stored.contextFrameTokens,
    };
  const cached = readTheCache(run);
  const estimate = (tokens: number | null): ResentSourceTokens | null => {
    if (tokens === null) return null;
    const resent = resentTokens(tokens, run.modelCalls);
    return cached
      ? { cached: resent, uncached: 0 }
      : { cached: 0, uncached: resent };
  };
  return {
    toolDefinitionTokens: estimate(sources.toolDefinitionTokens),
    steeringTokens: estimate(sources.steeringTokens),
    contextFrameTokens: estimate(sources.contextFrameTokens),
  };
}

/** One source's re-sent tokens and their price; null micros when the run has no price. */
export interface StandingSourcePrice {
  resentTokens: number;
  micros: bigint | null;
}

/**
 * What one source's re-sent tokens cost the run: the tokens of the calls that
 * read the cache at the run's cache read price, and the tokens of the calls
 * that read nothing at its input price, since those sent the prefix
 * uncached. Null when a side has tokens and the run has no price for it. A
 * cache read never falls back to the input price, which would price it at
 * the uncached rate.
 */
function priceResent(
  run: StandingRun,
  part: ResentSourceTokens,
): bigint | null {
  let micros = 0n;
  if (part.cached > 0) {
    const read = runReadPrice(run);
    if (read === null) return null;
    micros += priceInputTokens(read, part.cached);
  }
  if (part.uncached > 0) {
    const input = runInputPrice(run);
    if (input === null) return null;
    micros += priceInputTokens(input, part.uncached);
  }
  return micros;
}

/**
 * A run's standing context by source, as `standing_tokens × read_price ×
 * (requests − 1)` (spec detector 2), with each call after the first priced
 * at the rate its own cache use paid. A source the recorder did not report is
 * null, never a zero. Null when no source reported.
 */
export function standingContextBySource(
  run: StandingRun,
  sources: StandingContextSources,
): Record<StandingSource, StandingSourcePrice | null> | null {
  const split = resentSplitOf(run, sources);
  if (STANDING_SOURCES.every((source) => split[source] === null)) return null;
  const priced = (
    part: ResentSourceTokens | null,
  ): StandingSourcePrice | null =>
    part === null
      ? null
      : {
          resentTokens: part.cached + part.uncached,
          micros: priceResent(run, part),
        };
  return {
    toolDefinitionTokens: priced(split.toolDefinitionTokens),
    steeringTokens: priced(split.steeringTokens),
    contextFrameTokens: priced(split.contextFrameTokens),
  };
}
