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

/** Characters that end one segment of a model id and start the next. */
const MODEL_ID_BOUNDARY = new Set(["-", "/", ":", ".", "_", "@"]);

/**
 * A suffix that stamps when a model was snapshot rather than naming another
 * model: a compact or ISO date (`20260101`, `2026-01-01`), an OpenAI-style
 * four-digit snapshot (`0613`), or `latest`. The same rule as the price
 * book's (`packages/billing/src/model-identity.ts`), which this leaf package
 * cannot import.
 */
const POINT_IN_TIME_STAMP = /^(?:latest|\d{4}(?:[-._/]?\d{2}[-._/]?\d{2})?)$/;

/**
 * A family row names no one model: it ends in `*`, or it carries no version
 * number at all (`claude-opus`). The card holds these on purpose, to price
 * the next release before a row of its own exists.
 */
function isFamilyRow(model: string): boolean {
  return model.endsWith("*") || !/\d/.test(model);
}

/** How a row reaches an id: as the same model, or only as its family. */
function matchOf(id: string, row: string): "model" | "family" | undefined {
  if (id === row) return "model";
  if (isFamilyRow(row)) {
    const star = row.endsWith("*");
    const stem = star ? row.slice(0, -1) : row;
    if (stem.length === 0 || !id.startsWith(stem)) return undefined;
    // A bare family claims the ids under it at a segment boundary only, so
    // `claude-opus` reaches `claude-opus-9` and never `claude-opusx`.
    return star || MODEL_ID_BOUNDARY.has(id.charAt(stem.length))
      ? "family"
      : undefined;
  }
  if (!id.startsWith(row) || !MODEL_ID_BOUNDARY.has(id.charAt(row.length)))
    return undefined;
  return POINT_IN_TIME_STAMP.test(id.slice(row.length + 1))
    ? "model"
    : undefined;
}

/** The row that prices a model, and whether it names that model or its family. */
export interface ModelPriceMatch {
  price: ModelPrice;
  /** Only a family row matched, so the figure it gives is an estimate. */
  family: boolean;
}

/**
 * The row for a model, within the provider. A row prices an id when it is
 * that id, or that id with a date stamp (`claude-sonnet-5-20260101`,
 * `claude-opus-4-5@20251101`). A version is never a stamp: `claude-opus-4`
 * does not price `claude-opus-4-5`, and `gpt-5` prices neither `gpt-5.2` nor
 * `gpt-5-codex`, because the vendor prices each as a product of its own and
 * a longest-prefix match billed them at another one's rate. Failing those, a
 * family row prices what it covers and says so. Among several rows that
 * match, the longest wins. A gateway-style id (`anthropic/claude-sonnet-5`)
 * is tried bare as well.
 */
export function resolveModelPriceMatch(
  prices: readonly ModelPrice[] | undefined,
  provider: ModelProvider,
  model: string | undefined,
): ModelPriceMatch | undefined {
  if (prices === undefined || model === undefined || model.length === 0)
    return undefined;
  const slash = model.indexOf("/");
  const candidates = slash >= 0 ? [model, model.slice(slash + 1)] : [model];
  for (const id of candidates) {
    let exact: ModelPrice | undefined;
    let family: ModelPrice | undefined;
    for (const price of prices) {
      if (price.provider !== provider) continue;
      const match = matchOf(id, price.model);
      if (match === "model") {
        if (exact === undefined || price.model.length > exact.model.length)
          exact = price;
      } else if (match === "family") {
        if (family === undefined || price.model.length > family.model.length)
          family = price;
      }
    }
    if (exact !== undefined) return { price: exact, family: false };
    if (family !== undefined) return { price: family, family: true };
  }
  return undefined;
}

/** The row for a model; {@link resolveModelPriceMatch} says how it matched. */
export function resolveModelPrice(
  prices: readonly ModelPrice[] | undefined,
  provider: ModelProvider,
  model: string | undefined,
): ModelPrice | undefined {
  return resolveModelPriceMatch(prices, provider, model)?.price;
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

/** Request bytes per token for a ceiling: dense, so the ceiling errs high. */
const CEILING_BYTES_PER_TOKEN = 3.5;
/** The output a call is taken to be able to spend when it states no cap. */
const DEFAULT_OUTPUT_CEILING_TOKENS = 4096;

/**
 * The most one call is taken to cost before it runs, in micro-USD: every
 * request byte as uncached input, and the output cap it asked for (4096
 * tokens when it asked for none) at the output rate. The proxy holds this
 * against the session budget while the call is in flight, so calls admitted
 * side by side see each other before any of them has settled. An unpriced
 * model is held at nothing, the same fail-open reading an unpriced call gets
 * when it settles.
 */
export function callCeilingMicros(
  prices: readonly ModelPrice[] | undefined,
  provider: ModelProvider,
  model: string | undefined,
  requestBytes: number,
  maxOutputTokens: number | undefined,
): number {
  const price = resolveModelPrice(prices, provider, model);
  if (price === undefined) return 0;
  const input = Math.ceil(requestBytes / CEILING_BYTES_PER_TOKEN);
  const output = maxOutputTokens ?? DEFAULT_OUTPUT_CEILING_TOKENS;
  return Math.round((input * price.input + output * price.output) / MILLION);
}

/** A USD limit as micro-USD, the unit spend is counted in. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MILLION);
}
