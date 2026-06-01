import { requireEnv } from "@oxagen/config/env";

/**
 * Oxagen pricing model — the SINGLE SOURCE OF TRUTH for every Stripe product,
 * price, and the usage-meter markup. Edit this file, then run
 * `pnpm billing:stripe-sync --apply` to reconcile Stripe + the billing.plans
 * table to match. See docs/architecture/billing/pricing-and-metering.md and
 * docs/ops/stripe-product-sync-sop.md.
 *
 * Business invariants (locked):
 *   - 1 credit = 1 cent USD. Credits are the customer's currency; we never
 *     sell a credit for anything other than $0.01 of face value.
 *   - The gate (cost meter) is where gross margin is realised. Every metered
 *     LLM call debits credits = ceil(providerCostUsd * markup / CREDIT_VALUE).
 *   - `markup` is SOLVED so the volume-weighted blended margin across every
 *     product equals the target margin. Subscriptions grant credits below face
 *     value (the pre-discount incentive); credit packs sell at/near face value.
 *     Packs therefore run above target and subscriptions below — the blend is
 *     the target by construction.
 *
 * Why margin lives in the meter and not the sticker price: because 1 credit is
 * pinned at $0.01, you cannot move the per-credit sale price to chase a margin.
 * The only lever left is how fast a metered call burns credits relative to what
 * the provider charged us — that is the markup. Raising the target margin makes
 * credits burn faster; it does not change the $/credit a customer pays.
 */

/** USD value of one credit. Locked business rule — do not change. */
export const CREDIT_VALUE_USD = 0.01;

/** Default target *blended* gross margin across all products. */
export const DEFAULT_TARGET_MARGIN = 0.65;

// ── Cost meter: the provider rate card ──────────────────────────────────────
// These are the numbers a provider invoices us on: USD per 1,000,000 tokens,
// split by what they actually meter — input, output, and cached-input reads.
// This is the configurable input to the gate. Keep it in sync with your real
// provider invoices; everything downstream (cost, credits charged, margin)
// derives from these.

export type ProviderName = "anthropic" | "openai";

export interface ProviderModelRate {
  /** Provider that bills us for this model. */
  provider: ProviderName;
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
  /** USD per 1,000,000 cached-input (prompt-cache read) tokens. */
  cachedInputPer1M: number;
}

export type RateCard = Record<string, ProviderModelRate>;

/**
 * Public list prices as of 2026-05. Update to match your provider invoices —
 * the gate reads these directly. Keys match the AI SDK model ids used by
 * @oxagen/ai; a versioned/date-stamped id (e.g. `claude-sonnet-4-6-2026…`)
 * resolves to the longest matching prefix via {@link resolveRate}.
 */
export const PROVIDER_RATE_CARD: RateCard = {
  "claude-opus-4-8": { provider: "anthropic", inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  "claude-opus-4": { provider: "anthropic", inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 },
  "claude-sonnet-4-6": { provider: "anthropic", inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  "claude-sonnet-4": { provider: "anthropic", inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  "claude-haiku-4-5": { provider: "anthropic", inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
  "claude-haiku-4": { provider: "anthropic", inputPer1M: 1.0, outputPer1M: 5.0, cachedInputPer1M: 0.1 },
  "gpt-4o": { provider: "openai", inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 },
  "gpt-4o-mini": { provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
  // DALL·E 3 (OpenAI) is an IMAGE model billed PER IMAGE, not per token, so the
  // per-1M-token fields here cannot express its real cost. PLACEHOLDER — values
  // are 0 (charges $0) pending real pricing. For reference, OpenAI lists ~$0.04
  // per standard 1024×1024 image and ~$0.08 for HD/wide. TODO(billing): set the
  // real DALL·E 3 cost — ideally via a dedicated per-image rate path — before
  // metering image generation against this entry.
  "dall-e-3": { provider: "openai", inputPer1M: 0, outputPer1M: 0, cachedInputPer1M: 0 },
  "text-embedding-3-small": { provider: "openai", inputPer1M: 0.02, outputPer1M: 0.0, cachedInputPer1M: 0.02 },
  "text-embedding-3-large": { provider: "openai", inputPer1M: 0.13, outputPer1M: 0.0, cachedInputPer1M: 0.13 },
};

/**
 * Model whose rate prices any call whose id is absent from the rate card. We
 * bias to the platform default (Sonnet) so an unknown model never silently
 * under-charges — over-charging a missing model is safer than zero-charging it.
 */
export const FALLBACK_RATE_MODEL = "claude-sonnet-4-6";

/** Resolve a model id to its rate, matching the longest rate-card key prefix. */
export function resolveRate(modelId: string, rateCard: RateCard = PROVIDER_RATE_CARD): ProviderModelRate {
  if (rateCard[modelId]) return rateCard[modelId];
  let best: { key: string; rate: ProviderModelRate } | null = null;
  for (const [key, rate] of Object.entries(rateCard)) {
    if (modelId.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, rate };
    }
  }
  return best?.rate ?? rateCard[FALLBACK_RATE_MODEL]!;
}

// ── Provider cost ───────────────────────────────────────────────────────────

export interface TokenUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cached-input tokens, billed at the cheaper cached rate. Defaults to 0. */
  cachedTokens?: number;
}

/** USD the provider charges us for one metered call. */
export function providerCostUsd(usage: TokenUsageInput, rateCard: RateCard = PROVIDER_RATE_CARD): number {
  const rate = resolveRate(usage.model, rateCard);
  const cached = Math.max(0, usage.cachedTokens ?? 0);
  // input_tokens from the AI SDK is the full prompt; cached reads are a subset
  // billed cheaper, so split them out and never let billable input go negative.
  const billableInput = Math.max(0, usage.inputTokens - cached);
  return (
    (billableInput / 1_000_000) * rate.inputPer1M +
    (cached / 1_000_000) * rate.cachedInputPer1M +
    (Math.max(0, usage.outputTokens) / 1_000_000) * rate.outputPer1M
  );
}

/** Provider cost in micro-USD (millionths) for ClickHouse `cost_usd_micros`. */
export function providerCostUsdMicros(usage: TokenUsageInput, rateCard: RateCard = PROVIDER_RATE_CARD): number {
  return Math.round(providerCostUsd(usage, rateCard) * 1_000_000);
}

// ── Products: subscriptions + credit packs ──────────────────────────────────
// `creditsPerCent` (credits ÷ price-in-cents) is the lever the blended-margin
// solve reads. A product that hands out more credits per cent is more generous
// → lower margin. Face value (1 credit = 1 cent) is creditsPerCent === 1.0.

export interface SubscriptionPlanDef {
  /** Version-2 identifier (carries the `-v2` suffix). Maps to billing.plans.slug. */
  slug: string;
  /** Stripe product display name — NO version suffix. */
  displayName: string;
  /** Maps to the billing.plans.tier CHECK (free | build | scale | enterprise). */
  tier: "free" | "build" | "scale" | "enterprise";
  /** Credits granted per monthly period (1 credit = 1 cent). */
  includedCredits: number;
  /** Monthly price in cents. */
  monthlyCents: number;
  /** Annual price in cents (≈ 10× monthly = 2 months free). */
  annualCents: number;
  /** Included seats. */
  seats: number;
  /** Expected share of total credit revenue — used by the blended-margin solve. */
  weight: number;
  features: Record<string, unknown>;
}

export interface CreditPackDef {
  /** Version-2 identifier (carries the `-v2` suffix). */
  slug: string;
  /** Stripe product display name — NO version suffix. */
  displayName: string;
  /** One-time price in cents. */
  priceCents: number;
  /** Credits the buyer receives (≥ priceCents when a volume bonus applies). */
  credits: number;
  /** Expected share of total credit revenue — used by the blended-margin solve. */
  weight: number;
}

/**
 * Subscriptions. Each grants `includedCredits` per period below face value —
 * that discount is the incentive to subscribe over paying per pack. `tier`
 * stays inside the existing billing.plans CHECK; product identity is the slug.
 */
export const SUBSCRIPTION_PLANS: SubscriptionPlanDef[] = [
  {
    slug: "build-v2",
    displayName: "Build",
    tier: "build",
    includedCredits: 2_400, // $24 face value, sold for $20 → 16.7% discount
    monthlyCents: 2_000,
    annualCents: 20_000, // 2 months free
    seats: 5,
    weight: 0.35,
    features: { tools: "all", agents: 25, support: "email", seats: 5 },
  },
  {
    slug: "scale-v2",
    displayName: "Scale",
    tier: "scale",
    includedCredits: 13_200, // $132 face value, sold for $99 → 25% discount
    monthlyCents: 9_900,
    annualCents: 99_000, // 2 months free
    seats: 25,
    weight: 0.2,
    features: { tools: "all", agents: "unlimited", support: "priority", seats: 25 },
  },
  {
    // Priced self-serve plan (Enterprise customers may also engage at rate card
    // via credit packs). Home of the SOC2 access-control surface: ACLs, SSO,
    // SCIM, and the immutable audit log are Enterprise-only entitlements. The
    // credit allotment sits on the Build→Scale cr/¢ ladder (1.2 → 1.33 → 1.4)
    // and is solved into the 65% blended-margin target.
    slug: "enterprise-v2",
    displayName: "Enterprise",
    tier: "enterprise",
    includedCredits: 70_000, // $700 face value, sold for $500 → 28.6% discount (1.4 cr/¢)
    monthlyCents: 50_000,
    annualCents: 500_000, // 2 months free
    seats: 5,
    weight: 0.1,
    features: {
      tools: "all",
      agents: "unlimited",
      support: "dedicated",
      seats: 5,
      acls: true,
      sso: true,
      scim: true,
      audit: true,
    },
  },
];

/**
 * One-time credit packs. The first sells at exact face value (1 credit = 1¢);
 * larger packs carry a small volume bonus (more credits per cent) which trims
 * their margin slightly — the volume incentive.
 */
export const CREDIT_PACKS: CreditPackDef[] = [
  { slug: "credits-starter-v2", displayName: "Starter Credit Pack", priceCents: 1_000, credits: 1_000, weight: 0.1 },
  { slug: "credits-power-v2", displayName: "Power Credit Pack", priceCents: 5_000, credits: 5_250, weight: 0.2 },
  { slug: "credits-scale-v2", displayName: "Scale Credit Pack", priceCents: 20_000, credits: 22_000, weight: 0.15 },
];

// ── The margin solve ────────────────────────────────────────────────────────

export type ProductKind = "subscription" | "credit_pack";

export interface DerivedProduct {
  slug: string;
  displayName: string;
  kind: ProductKind;
  /** Monthly price for subscriptions, one-time price for packs. Cents. */
  priceCents: number;
  /** Annual price for subscriptions. Cents. */
  annualCents?: number;
  /** Monthly included credits (subs) or granted credits (packs). */
  credits: number;
  /** credits ÷ priceCents. */
  creditsPerCent: number;
  /** Realised gross margin on credits consumed from this product. */
  marginPct: number;
  /** Revenue-mix weight used in the blend. */
  weight: number;
}

export interface PricingDerivation {
  targetMargin: number;
  creditValueUsd: number;
  /** The solved meter markup applied by the gate. */
  meterMarkup: number;
  /** Volume-weighted blended margin — equals targetMargin by construction. */
  blendedMargin: number;
  products: DerivedProduct[];
}

interface RatioWeight {
  creditsPerCent: number;
  weight: number;
}

/**
 * Solve the meter markup `M` so the volume-weighted blended margin equals
 * `targetMargin`.
 *
 *   margin_i      = 1 − creditsPerCent_i / M
 *   blended       = Σ wᵢ·margin_i  (weights normalised)
 *   set blended   = m  ⟹  M = Σ (wᵢ · creditsPerCent_i) / (1 − m)
 *
 * Intuition: `creditsPerCent / M` is the provider cost as a fraction of the
 * face value of the credits consumed. Generous products (high creditsPerCent)
 * eat more of the markup, so the blend pins M above the naive 1/(1−m).
 */
export function solveMeterMarkup(products: RatioWeight[], targetMargin: number): number {
  if (targetMargin <= 0 || targetMargin >= 1) {
    throw new Error(`targetMargin must be in (0,1); got ${targetMargin}`);
  }
  const totalWeight = products.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) throw new Error("product weights must sum to a positive number");
  const weightedRatio = products.reduce((s, p) => s + (p.weight / totalWeight) * p.creditsPerCent, 0);
  return weightedRatio / (1 - targetMargin);
}

/**
 * Derive the full pricing table for a target margin: the solved meter markup,
 * every product's price/credits/realised margin, and the blended margin.
 * Pure — no I/O. This is what the sync script and the gate both read from.
 */
export function derivePricing(targetMargin: number = resolveTargetMargin()): PricingDerivation {
  const ratios: (RatioWeight & { def: SubscriptionPlanDef | CreditPackDef; kind: ProductKind })[] = [
    ...SUBSCRIPTION_PLANS.map((p) => ({
      creditsPerCent: p.includedCredits / p.monthlyCents,
      weight: p.weight,
      def: p,
      kind: "subscription" as const,
    })),
    ...CREDIT_PACKS.map((p) => ({
      creditsPerCent: p.credits / p.priceCents,
      weight: p.weight,
      def: p,
      kind: "credit_pack" as const,
    })),
  ];

  const meterMarkup = solveMeterMarkup(ratios, targetMargin);

  const products: DerivedProduct[] = ratios.map((r) => {
    const marginPct = 1 - r.creditsPerCent / meterMarkup;
    if (r.kind === "subscription") {
      const def = r.def as SubscriptionPlanDef;
      return {
        slug: def.slug,
        displayName: def.displayName,
        kind: "subscription",
        priceCents: def.monthlyCents,
        annualCents: def.annualCents,
        credits: def.includedCredits,
        creditsPerCent: r.creditsPerCent,
        marginPct,
        weight: def.weight,
      };
    }
    const def = r.def as CreditPackDef;
    return {
      slug: def.slug,
      displayName: def.displayName,
      kind: "credit_pack",
      priceCents: def.priceCents,
      credits: def.credits,
      creditsPerCent: r.creditsPerCent,
      marginPct,
      weight: def.weight,
    };
  });

  const totalWeight = products.reduce((s, p) => s + p.weight, 0);
  const blendedMargin = products.reduce((s, p) => s + (p.weight / totalWeight) * p.marginPct, 0);

  return { targetMargin, creditValueUsd: CREDIT_VALUE_USD, meterMarkup, blendedMargin, products };
}

// ── Runtime configuration ───────────────────────────────────────────────────

// Env is fixed for a process lifetime, and resolveMeterMarkup() is on the gate's
// hot path (every metered call). Memoise both reads so we parse process.env at
// most once rather than on every turn.
let _resolvedMargin: number | null = null;
let _resolvedMarkup: number | null = null;

/** Target margin: env override `OXAGEN_TARGET_MARGIN`, else the default. */
export function resolveTargetMargin(): number {
  if (_resolvedMargin !== null) return _resolvedMargin;
  const { OXAGEN_TARGET_MARGIN } = requireEnv(["OXAGEN_TARGET_MARGIN"]);
  _resolvedMargin = OXAGEN_TARGET_MARGIN ?? DEFAULT_TARGET_MARGIN;
  return _resolvedMargin;
}

/**
 * The meter markup the gate applies. Resolution order:
 *   1. `OXAGEN_METER_MARKUP` env — operators pin the exact solved value so
 *      runtime never recomputes the solve (and stays decoupled from a config
 *      edit until the next sync).
 *   2. Otherwise solve from the current target margin + product mix.
 */
export function resolveMeterMarkup(): number {
  if (_resolvedMarkup !== null) return _resolvedMarkup;
  const { OXAGEN_METER_MARKUP } = requireEnv(["OXAGEN_METER_MARKUP"]);
  _resolvedMarkup = OXAGEN_METER_MARKUP ?? derivePricing(resolveTargetMargin()).meterMarkup;
  return _resolvedMarkup;
}

/** Test-only: clear the memoised env-derived margin + markup. */
export function __resetPricingCacheForTests(): void {
  _resolvedMargin = null;
  _resolvedMarkup = null;
}
