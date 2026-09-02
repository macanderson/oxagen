/**
 * The model rate card — baked into the engine so projecting cost is trivial.
 *
 * `oxagen` is deliberately *not* pinned to one model vendor: the cost router
 * picks the cheapest sufficient model, and this card is how the engine prices
 * any model's token usage in dollars — for live per-turn reporting, for
 * `oxagen cost` projections, and for proving one model/run is cheaper than
 * another.
 *
 * The numbers (USD per 1,000,000 tokens) mirror `packages/billing/src/pricing.ts`
 * (the platform's single source of truth); they are vendored here only so the
 * standalone `oxagen` bin stays lean and does not pull in @oxagen/billing
 * (Stripe et al.). Keep them in sync. This module is the ONE place rates live in
 * the engine — `model-router.ts` re-exports from here, so there is no second copy.
 */

/** USD price per 1,000,000 tokens, split by direction. */
export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * USD per 1,000,000 CACHED-read input tokens (a provider prompt-cache hit).
   * Always cheaper than `inputPer1M` — a turn that re-sends the same system
   * prompt/code-graph context across many steps bills the repeat reads at
   * this rate, not the fresh-input rate. Mirrors
   * `packages/billing/src/pricing.ts`'s `cachedInputPer1M`; kept in sync by
   * hand since this card is intentionally vendored, not imported.
   * (apps/cli/src/agent/rate-card.ts is a pure re-export of this module, so
   * the CLI never carries a second copy of these numbers.)
   */
  cachedInputPer1M: number;
}

/** One priced model family. Matched by longest `family` prefix on the slug. */
export interface RateCardEntry {
  /** Bare family prefix matched against the slug (e.g. "claude-opus"). */
  family: string;
  /** Human label for tables and reports. */
  label: string;
  /** Provider, so cost projections can group/compare by vendor. */
  vendor: string;
  rate: ModelRate;
}

/**
 * The rate card. Order matters: longest/most-specific prefixes first so
 * "gpt-4o-mini" wins over "gpt-4o". Add a row to price a new family.
 *
 * `cachedInputPer1M` follows each vendor's published cache-read discount:
 * Anthropic prices a cache read at 10% of fresh input (matches
 * `packages/billing/src/pricing.ts`'s anthropic rows exactly); gpt-4o/
 * gpt-4o-mini match pricing.ts exactly at 50%. Every other row (gpt-5.x,
 * o-series, xAI, DeepSeek, zai) has no pricing.ts row and does NOT follow a
 * flat ratio — cache-read rates vary model to model (roughly 8-25% of fresh
 * input across the gpt-5/o-series generation), so each is sourced directly
 * from the AI Gateway's per-model pricing page rather than assumed. Gemini
 * isn't in pricing.ts at all yet; its cache reads are estimated at 25% of
 * fresh input per Google's published context-caching discount — least
 * authoritative row in this card, update when it lands in pricing.ts.
 */
export const RATE_CARD: RateCardEntry[] = [
  {
    family: "claude-fable",
    label: "Claude Fable",
    vendor: "anthropic",
    rate: { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  },
  {
    family: "claude-opus",
    label: "Claude Opus",
    vendor: "anthropic",
    rate: { inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  },
  {
    family: "claude-sonnet",
    label: "Claude Sonnet",
    vendor: "anthropic",
    rate: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  },
  {
    family: "claude-haiku",
    label: "Claude Haiku",
    vendor: "anthropic",
    rate: { inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
  },
  // gpt-5.5-pro/gpt-5.5 rows are from the AI Gateway's /v1/models pricing
  // (2026-07-07, base tier ≤272k context). They MUST sort before the generic
  // "gpt-5" prefix row: "gpt-5.5-pro" starts with "gpt-5", so a generic row
  // placed first would win the prefix match and price these ~18–24× too
  // cheaply. gpt-5.5-pro publishes no cache-read rate; 50% of fresh input
  // follows the same OpenAI ratio as the other rows.
  {
    family: "gpt-5.5-pro",
    label: "GPT-5.5 Pro",
    vendor: "openai",
    rate: { inputPer1M: 30.0, outputPer1M: 180.0, cachedInputPer1M: 15.0 },
  },
  {
    family: "gpt-5.5",
    label: "GPT-5.5",
    vendor: "openai",
    rate: { inputPer1M: 5.0, outputPer1M: 30.0, cachedInputPer1M: 0.5 },
  },
  // gpt-5.2/gpt-5-mini/gpt-5-nano rows are from the AI Gateway's per-model
  // pricing pages (2026-07-11). They MUST sort before the generic "gpt-5"
  // prefix row for the same reason as the gpt-5.5 rows above — "gpt-5.2" and
  // "gpt-5-mini"/"gpt-5-nano" all start with "gpt-5".
  {
    family: "gpt-5.2",
    label: "GPT-5.2",
    vendor: "openai",
    rate: { inputPer1M: 1.75, outputPer1M: 14.0, cachedInputPer1M: 0.17 },
  },
  {
    family: "gpt-5-mini",
    label: "GPT-5 mini",
    vendor: "openai",
    rate: { inputPer1M: 0.25, outputPer1M: 2.0, cachedInputPer1M: 0.03 },
  },
  {
    family: "gpt-5-nano",
    label: "GPT-5 nano",
    vendor: "openai",
    rate: { inputPer1M: 0.05, outputPer1M: 0.4, cachedInputPer1M: 0.01 },
  },
  {
    family: "gpt-5",
    label: "GPT-5",
    // Cache-read rate is $0.13/M, matching the AI Gateway's per-model pricing
    // page — not the general 50% cached-vs-fresh ratio OpenAI uses elsewhere.
    vendor: "openai",
    rate: { inputPer1M: 1.25, outputPer1M: 10.0, cachedInputPer1M: 0.13 },
  },
  // o3/o4-mini rows match the AI Gateway's per-model pricing pages. There is
  // no bare "o4" model published on the Gateway (only "o3" and "o4-mini") — a
  // slug of exactly "openai/o4" (as referenced in packages/ai/src/catalog.ts)
  // falls through to FALLBACK_RATE until OpenAI ships a standalone o4
  // flagship.
  {
    family: "o3",
    label: "o3",
    vendor: "openai",
    rate: { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
  },
  {
    family: "o4-mini",
    label: "o4-mini",
    vendor: "openai",
    rate: { inputPer1M: 1.1, outputPer1M: 4.4, cachedInputPer1M: 0.28 },
  },
  {
    family: "gpt-4o-mini",
    label: "GPT-4o mini",
    vendor: "openai",
    rate: { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  },
  {
    family: "gpt-4o",
    label: "GPT-4o",
    vendor: "openai",
    rate: { inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
  },
  // Zhipu GLM rows from the AI Gateway's /v1/models pricing (2026-07-10).
  // Specific families MUST sort before the generic "glm" prefix row (same
  // first-match rule as the gpt-5.5 rows above).
  {
    family: "glm-5.2-fast",
    label: "GLM 5.2 Fast",
    vendor: "zai",
    rate: { inputPer1M: 3.0, outputPer1M: 10.25, cachedInputPer1M: 0.5 },
  },
  {
    family: "glm-5.2",
    label: "GLM 5.2",
    vendor: "zai",
    rate: { inputPer1M: 1.4, outputPer1M: 4.4, cachedInputPer1M: 0.26 },
  },
  {
    family: "glm-5-turbo",
    label: "GLM 5 Turbo",
    vendor: "zai",
    rate: { inputPer1M: 1.2, outputPer1M: 4.0, cachedInputPer1M: 0.24 },
  },
  {
    family: "glm",
    label: "GLM",
    vendor: "zai",
    rate: { inputPer1M: 0.95, outputPer1M: 3.15, cachedInputPer1M: 0.2 },
  },
  // xAI Grok rows from the AI Gateway's per-model pricing pages (2026-07-11).
  // grok-4.5/grok-4.3/grok-build-0.1 MUST sort before the generic "grok-4"
  // row — "grok-4.5" and "grok-4.3" both start with "grok-4" (same
  // longest-prefix-first rule as the gpt-5.5/glm rows above).
  {
    family: "grok-4.5",
    label: "Grok 4.5",
    vendor: "xai",
    rate: { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.5 },
  },
  {
    family: "grok-4.3",
    label: "Grok 4.3",
    vendor: "xai",
    rate: { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 },
  },
  {
    family: "grok-build-0.1",
    label: "Grok Build 0.1",
    vendor: "xai",
    rate: { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 },
  },
  {
    family: "grok-4",
    label: "Grok 4",
    vendor: "xai",
    rate: { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.75 },
  },
  // DeepSeek rows from the AI Gateway's per-model pricing pages (2026-07-11),
  // DeepSeek-direct provider column (cheapest of the multi-provider listing).
  // deepseek-v4-pro/deepseek-v4-flash MUST sort before a future generic
  // "deepseek-v4" row, same rule as above; there is no bare "deepseek-v4"
  // SKU published today so no catch-all row is added — an unqualified
  // "deepseek-v4*" slug falls through to FALLBACK_RATE until one ships.
  {
    family: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    vendor: "deepseek",
    rate: { inputPer1M: 1.74, outputPer1M: 3.48, cachedInputPer1M: 0.0 },
  },
  {
    family: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    vendor: "deepseek",
    rate: { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0 },
  },
  {
    family: "deepseek-v3.2",
    label: "DeepSeek V3.2",
    vendor: "deepseek",
    rate: { inputPer1M: 0.28, outputPer1M: 0.42, cachedInputPer1M: 0.03 },
  },
  // Gateway /v1/models 2026-07-07 (base tier ≤200k): gemini-3-pro* $2/$12.
  {
    family: "gemini-3-pro",
    label: "Gemini 3 Pro",
    vendor: "google",
    rate: { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 },
  },
  {
    family: "gemini",
    label: "Gemini",
    vendor: "google",
    rate: { inputPer1M: 1.25, outputPer1M: 5.0, cachedInputPer1M: 0.3125 },
  },
];

/** Sonnet — used when a slug matches no family, so a run is never zero-charged. */
export const FALLBACK_RATE: ModelRate = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
  cachedInputPer1M: 0.3,
};

/** Strip "vendor/" and match the bare family. Exported for display/grouping. */
export function familyOf(model: string): string {
  return model.split("/").pop() ?? model;
}

/** Resolve a gateway slug (e.g. "anthropic/claude-opus-4.8") to its token rate. */
export function rateFor(model: string): ModelRate {
  const family = familyOf(model);
  for (const entry of RATE_CARD) {
    if (family.startsWith(entry.family)) return entry.rate;
  }
  return FALLBACK_RATE;
}

/** The card entry that prices a slug, or undefined when it falls back. */
export function entryFor(model: string): RateCardEntry | undefined {
  const family = familyOf(model);
  return RATE_CARD.find((e) => family.startsWith(e.family));
}

/** Token usage for pricing. Either direction may be absent (treated as 0). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt tokens served from the provider's cache — a SUBSET of
   * `inputTokens`, not additional to it. Billed at `cachedInputPer1M`
   * instead of the fresh `inputPer1M` rate; omitted/0 prices every input
   * token as fresh.
   */
  cachedTokens?: number;
}

/**
 * Estimated provider cost in USD for a token usage on a given model. Splits
 * `inputTokens` into billable-fresh and cached-read so a turn that hammers
 * the same cached system prompt/code-graph context across many steps isn't
 * priced as if every one of those tokens were billed fresh — see
 * `packages/billing/src/pricing.ts`'s `providerCostUsd`, which this mirrors.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rate = rateFor(model);
  const cached = Math.max(0, usage.cachedTokens ?? 0);
  // cachedTokens is a subset of inputTokens, not additional to it — split
  // them apart and never let the billable-fresh remainder go negative.
  const billableInput = Math.max(0, (usage.inputTokens ?? 0) - cached);
  const inCost = (billableInput / 1_000_000) * rate.inputPer1M;
  const cachedCost = (cached / 1_000_000) * rate.cachedInputPer1M;
  const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * rate.outputPer1M;
  return inCost + cachedCost + outCost;
}

/** Format a USD amount compactly ("$0.0042", "$1.20", "<$0.0001", "$0"). */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** A fully broken-out cost projection for one model + token usage. */
export interface CostProjection {
  model: string;
  family: string;
  label: string;
  vendor: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Prompt tokens served from the provider cache — a SUBSET of `inputTokens`,
   * priced at the cache-read rate inside `inputCostUsd`. Echoed for display.
   */
  cachedTokens: number;
  /**
   * Total input-side cost: the fresh remainder at `inputPer1M` PLUS the cached
   * subset at `cachedInputPer1M`. Honoring the cache split here is what keeps
   * `projectCost(...).totalUsd` equal to `estimateCostUsd(model, usage)` — see
   * ADR-021 §6, projections must match metered actuals.
   */
  inputCostUsd: number;
  outputCostUsd: number;
  totalUsd: number;
  /** True when no card entry matched and the fallback rate was used. */
  fallback: boolean;
}

/**
 * Project the dollar cost of a token usage on a specific model. Splits
 * `inputTokens` into billable-fresh and cached-read exactly as
 * {@link estimateCostUsd} does, so a cache-heavy turn is not overstated — the
 * two functions are guaranteed to agree on `totalUsd`. `cachedTokens` defaults
 * to 0 (every input token priced fresh), so a caller that omits it still gets a
 * correct — if conservative — projection.
 */
export function projectCost(model: string, usage: TokenUsage): CostProjection {
  const entry = entryFor(model);
  const rate = entry?.rate ?? FALLBACK_RATE;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = Math.max(0, usage.cachedTokens ?? 0);
  // cachedTokens is a subset of inputTokens, never additional to it — split
  // them apart and never let the billable-fresh remainder go negative.
  const billableInput = Math.max(0, input - cached);
  const inputCostUsd =
    (billableInput / 1_000_000) * rate.inputPer1M +
    (cached / 1_000_000) * rate.cachedInputPer1M;
  const outputCostUsd = (output / 1_000_000) * rate.outputPer1M;
  return {
    model,
    family: entry?.family ?? familyOf(model),
    label: entry?.label ?? familyOf(model),
    vendor: entry?.vendor ?? "unknown",
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    inputCostUsd,
    outputCostUsd,
    totalUsd: inputCostUsd + outputCostUsd,
    fallback: !entry,
  };
}

/**
 * Price the same token usage across EVERY family in the card, cheapest first.
 * This is the "prove it's the cheapest" primitive: hold the work constant, vary
 * the model, and see the dollar spread — the whole point of not being pinned to
 * one vendor.
 */
export function compareModels(usage: TokenUsage): CostProjection[] {
  return RATE_CARD.map((e) =>
    projectCost(`${e.vendor}/${e.family}`, usage),
  ).sort((a, b) => a.totalUsd - b.totalUsd);
}

/** The full rate card (for `oxagen cost --rates`). */
export function listRateCard(): RateCardEntry[] {
  return RATE_CARD;
}
