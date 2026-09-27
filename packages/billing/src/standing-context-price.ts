/**
 * standing-context-price.ts — what the context every request re-sends costs
 * (spec detector 2). PURE: ./standing-context-price-store.ts reads the rows.
 *
 * Every request re-sends the same prefix: the system prompt, the tool
 * definitions, and the steering stable prefix. The prompt cache makes each
 * re-read cheap, and the re-read still happens on every request. So one token
 * in the prefix costs its read price once per request, and a week of it costs
 * the read price times the requests of the week.
 *
 * The findings pass prices a run's re-reads with `runReadPrice`, and the tool
 * and steering pages print a weekly price per 1,000 tokens from the
 * workspace's last 7 days, so the two agree on what one re-read token costs.
 */
import {
  divideHalfEven,
  type CostBasis,
  type InputPrice,
  type RunBreakdown,
} from "./cost-rollup";

/** The days the weekly price reads back from now. */
export const STANDING_CONTEXT_WEEK_DAYS = 7;

/** The tokens a weekly price is quoted for. */
export const WEEKLY_PRICE_TOKENS = 1_000;

/**
 * What a run paid for one prompt-cache read token, as a ratio; null when no
 * priced frame read the cache. A run whose cost is `estimated`, or has none,
 * has no price, as with `runInputPrice`.
 */
export function runReadPrice(run: {
  costBasis: CostBasis | null;
  breakdown: Pick<RunBreakdown, "models">;
}): InputPrice | null {
  if (run.costBasis === null || run.costBasis === "estimated") return null;
  let micros = 0n;
  let tokens = 0n;
  for (const m of run.breakdown.models) {
    micros += m.costByClass.cache_read;
    tokens += BigInt(m.tokens.cache_read);
  }
  if (tokens === 0n || micros === 0n) return null;
  return { micros, tokens };
}

/**
 * The weekly price of `tokens` sent on every request: tokens × read price ×
 * the requests of the week, in whole micros rounded half to even.
 */
export function weeklyPriceMicros(
  price: InputPrice,
  requests: number,
  tokens: number,
): bigint {
  return divideHalfEven(
    BigInt(tokens) * BigInt(requests) * price.micros,
    price.tokens,
  );
}

/** The workspace's weekly price per 1,000 tokens sent on every request. */
export interface WeeklyContextPrice {
  /** Micros a week for each 1,000 tokens of standing context. */
  perThousandMicros: bigint;
  currency: string;
  /** The model requests the workspace made in the week. */
  requests: number;
  /** The start of the week the price reads. */
  since: Date;
}

/** `perThousandMicros` for a read price and a week of requests. */
export function weeklyPricePerThousand(
  price: InputPrice,
  requests: number,
): bigint {
  return weeklyPriceMicros(price, requests, WEEKLY_PRICE_TOKENS);
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

/** A run's standing context by source; null where the recorder did not report it. */
export interface StandingContextSources {
  toolDefinitionTokens: number | null;
  contextFrameTokens: number | null;
  steeringTokens: number | null;
}

/**
 * The standing tokens a run re-sent: each source's sum over the run's
 * requests, less the first request's share. The run-totals columns hold the
 * sum over every request, so one request's share is the sum over the
 * requests. Null when no source reported, or the run made one request or
 * none.
 */
export function resentStandingTokens(
  sources: StandingContextSources,
  requests: number,
): number | null {
  const reported = [
    sources.toolDefinitionTokens,
    sources.contextFrameTokens,
    sources.steeringTokens,
  ].filter((n): n is number => n !== null);
  if (reported.length === 0 || requests <= 1) return null;
  const sum = reported.reduce((a, b) => a + b, 0);
  return Math.round((sum * (requests - 1)) / requests);
}
