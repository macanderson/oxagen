/**
 * Pricing an observed model call on the host, for the session budget.
 *
 * The proxy refuses a call once a session's observed spend reaches
 * `budget.session_limit_usd`, and it has to price each call to know that. The
 * prices are the control plane's: `@oxagen/tacho` is a leaf package and cannot
 * read the price book, so the rows it needs arrive in the signed bundle as
 * `model_prices` and nothing here holds a number of its own.
 *
 * A model with no row is unpriced, and an unpriced call costs the budget
 * nothing. That is the fail-open half of the design, chosen on purpose: a
 * model the price book has not caught up with must not stop an agent from
 * working, and the frame says `observed_unpriced` so the gap is visible
 * instead of silent. The control plane still prices the same frame from the
 * full price book when it rolls up cost.
 *
 * For a subscription login the figure is the list price of the tokens, not
 * what the vendor charged. That is the only basis a budget can be compared on
 * across login kinds, and it is what the limit is written in.
 */
import type { PolicyBundle } from "../wire";
import type { ModelProvider, ObservedUsage } from "./model-usage";

export type ModelPrice = NonNullable<PolicyBundle["model_prices"]>[number];

/**
 * The row for a model: the longest `model` that prefixes the id, within the
 * provider. A dated id (`claude-sonnet-5-20260101`) matches its family row,
 * and a gateway-style id (`anthropic/claude-sonnet-5`) is tried bare as well.
 */
export function resolveModelPrice(
  prices: readonly ModelPrice[] | undefined,
  provider: ModelProvider,
  model: string | undefined,
): ModelPrice | undefined {
  if (prices === undefined || model === undefined || model.length === 0)
    return undefined;
  const slash = model.indexOf("/");
  const candidates = slash >= 0 ? [model, model.slice(slash + 1)] : [model];
  let best: ModelPrice | undefined;
  for (const id of candidates) {
    for (const price of prices) {
      if (price.provider !== provider) continue;
      if (!id.startsWith(price.model)) continue;
      if (best === undefined || price.model.length > best.model.length)
        best = price;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

const MILLION = 1_000_000;

/**
 * The cost of one call in micro-USD, or undefined when the model is unpriced
 * or the vendor reported no tokens. One-hour cache writes are priced at their
 * own rate when the row carries one and at the five-minute rate otherwise.
 */
export function priceObservedUsage(
  prices: readonly ModelPrice[] | undefined,
  provider: ModelProvider,
  usage: ObservedUsage,
): number | undefined {
  const price = resolveModelPrice(prices, provider, usage.model);
  if (price === undefined) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const oneHour = Math.min(cacheWrite, usage.cacheCreation1hTokens ?? 0);
  const fiveMinute = cacheWrite - oneHour;
  const micros =
    (input * price.input +
      output * price.output +
      cacheRead * price.cache_read +
      fiveMinute * price.cache_write +
      oneHour * (price.cache_write_1h ?? price.cache_write)) /
    MILLION;
  return Math.round(micros);
}

/** A USD limit as micro-USD, the unit spend is counted in. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MILLION);
}
