/**
 * The model rate card — baked into the CLI so projecting cost is trivial.
 *
 * `oxagen` is deliberately *not* pinned to one model vendor: the cost router
 * picks the cheapest sufficient model, and this card is how the CLI prices any
 * model's token usage in dollars — for live per-turn reporting, for `oxagen
 * cost` projections, and for proving one model/run is cheaper than another.
 *
 * The numbers (USD per 1,000,000 tokens) mirror `packages/billing/src/pricing.ts`
 * (the platform's single source of truth); they are vendored here only so the
 * standalone `oxagen` bin stays lean and does not pull in @oxagen/billing
 * (Stripe et al.). Keep them in sync. This module is the ONE place rates live in
 * the CLI — `model-router.ts` re-exports from here, so there is no second copy.
 */

/** USD price per 1,000,000 tokens, split by direction. */
export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
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
 */
export const RATE_CARD: RateCardEntry[] = [
  { family: "claude-opus", label: "Claude Opus", vendor: "anthropic", rate: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { family: "claude-sonnet", label: "Claude Sonnet", vendor: "anthropic", rate: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { family: "claude-haiku", label: "Claude Haiku", vendor: "anthropic", rate: { inputPer1M: 1.0, outputPer1M: 5.0 } },
  { family: "gpt-5", label: "GPT-5", vendor: "openai", rate: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { family: "gpt-4o-mini", label: "GPT-4o mini", vendor: "openai", rate: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { family: "gpt-4o", label: "GPT-4o", vendor: "openai", rate: { inputPer1M: 2.5, outputPer1M: 10.0 } },
  { family: "gemini", label: "Gemini", vendor: "google", rate: { inputPer1M: 1.25, outputPer1M: 5.0 } },
];

/** Sonnet — used when a slug matches no family, so a run is never zero-charged. */
export const FALLBACK_RATE: ModelRate = { inputPer1M: 3.0, outputPer1M: 15.0 };

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
}

/** Estimated provider cost in USD for a token usage on a given model. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const rate = rateFor(model);
  const inCost = ((usage.inputTokens ?? 0) / 1_000_000) * rate.inputPer1M;
  const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * rate.outputPer1M;
  return inCost + outCost;
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
  inputCostUsd: number;
  outputCostUsd: number;
  totalUsd: number;
  /** True when no card entry matched and the fallback rate was used. */
  fallback: boolean;
}

/** Project the dollar cost of a token usage on a specific model. */
export function projectCost(model: string, usage: TokenUsage): CostProjection {
  const entry = entryFor(model);
  const rate = entry?.rate ?? FALLBACK_RATE;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const inputCostUsd = (input / 1_000_000) * rate.inputPer1M;
  const outputCostUsd = (output / 1_000_000) * rate.outputPer1M;
  return {
    model,
    family: entry?.family ?? familyOf(model),
    label: entry?.label ?? familyOf(model),
    vendor: entry?.vendor ?? "unknown",
    inputTokens: input,
    outputTokens: output,
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
  return RATE_CARD.map((e) => projectCost(`${e.vendor}/${e.family}`, usage)).sort(
    (a, b) => a.totalUsd - b.totalUsd,
  );
}

/** The full rate card (for `oxagen cost --rates`). */
export function listRateCard(): RateCardEntry[] {
  return RATE_CARD;
}
