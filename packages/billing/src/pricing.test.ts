/**
 * Unit tests for the pricing model (packages/billing/src/pricing.ts).
 *
 * Pure math — no DB, no Stripe. Verifies the cost meter (provider rate card),
 * the blended-margin solve, and the invariant the whole system rests on:
 * derivePricing(m).blendedMargin === m.
 */
import { describe, it, expect } from "vitest";
import { CREDIT_TOPUP_PRESETS_USD } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import {
  PUBLISHED_TERMS,
  UPGRADE_PLANS,
} from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import {
  CREDIT_VALUE_USD,
  DEFAULT_TARGET_MARGIN,
  PROVIDER_RATE_CARD,
  SUBSCRIPTION_PLANS,
  CREDIT_PACKS,
  resolveRate,
  resolveRateEntry,
  isRateCardMiss,
  providerCostUsd,
  providerCostUsdMicros,
  solveMeterMarkup,
  derivePricing,
} from "./pricing";
import {
  ACTION_RATE_BANDS,
  TIER_ACTION_ALLOWANCES,
  ENTERPRISE_FALLBACK_ALLOWANCE,
} from "./action-metering";
import { FREE_SIGNUP_CREDITS } from "./grants";

describe("resolveRate", () => {
  it("returns the exact rate for a known model id", () => {
    expect(resolveRate("claude-sonnet-4-6")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-4-6"],
    );
  });

  it("matches the longest prefix for a versioned/date-stamped id", () => {
    // A dated Sonnet id must resolve to claude-sonnet-4-6, not the shorter
    // claude-sonnet-4 fallback.
    expect(resolveRate("claude-sonnet-4-6-20260101")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-4-6"],
    );
  });

  it("falls back to the configured fallback model for an unknown id", () => {
    expect(resolveRate("mistral-large-2")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-5"],
    );
  });

  it("prices Claude Fable 5 on its own row, not the Sonnet fallback", () => {
    // Without an explicit row Fable would resolve to the Sonnet fallback and
    // under-charge. The bare and gateway (creator/model) forms both land on
    // the Fable row.
    expect(resolveRate("claude-fable-5")).toBe(
      PROVIDER_RATE_CARD["claude-fable-5"],
    );
    expect(resolveRate("anthropic/claude-fable-5")).toBe(
      PROVIDER_RATE_CARD["claude-fable-5"],
    );
    expect(resolveRate("claude-fable-5").outputPer1M).toBe(50.0);
  });

  it("prices Claude Sonnet 5 explicitly at its own rate", () => {
    expect(resolveRate("claude-sonnet-5")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-5"],
    );
    expect(resolveRate("anthropic/claude-sonnet-5")).toBe(
      PROVIDER_RATE_CARD["anthropic/claude-sonnet-5"],
    );
    expect(resolveRate("claude-sonnet-5").outputPer1M).toBe(10.0);
  });

  it("prices Codex's current model by its own row", () => {
    expect(resolveRate("gpt-5.3-codex")).toBe(
      PROVIDER_RATE_CARD["gpt-5.3-codex"],
    );
    expect(resolveRate("openai/gpt-5.3-codex").outputPer1M).toBe(14.0);
  });

  it("leaves the dotted names of other vendors' models alone", () => {
    // gpt-5.5 and gpt-5 are separately priced products, keyed dotted.
    expect(resolveRate("gpt-5.5")).toBe(PROVIDER_RATE_CARD["gpt-5.5"]);
  });

  it("matches the longest prefix for a versioned/date-stamped Sonnet 5 id", () => {
    // A dated Sonnet 5 id must resolve to claude-sonnet-5, not fall through to
    // the shorter claude-sonnet-4 / claude-sonnet-4-6 rows.
    expect(resolveRate("claude-sonnet-5-20260101")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-5"],
    );
  });
});

describe("Claude list prices (#3944)", () => {
  // What 1M input and 1M output tokens cost at Anthropic's list price. Before
  // #3944 the `claude-opus-4` prefix row and the `claude-opus` family row both
  // held the legacy Opus 4 price of $15/$75, so every Opus release from 4.5 on
  // billed at $90 here, three times the $30 invoice. The gateway row
  // `anthropic/claude-opus-4` caught the dotted and hyphenated gateway ids
  // before the bare-family pass could see them.
  const ONE_MILLION_EACH: ReadonlyArray<readonly [string, number]> = [
    ["claude-opus-4-5", 30],
    ["claude-opus-4-5-20251101", 30],
    ["claude-opus-4-6", 30],
    ["claude-opus-4-7", 30],
    ["claude-opus-4-8", 30],
    ["anthropic/claude-opus-4.5", 30],
    ["anthropic/claude-opus-4.6", 30],
    ["anthropic/claude-opus-4.7", 30],
    ["anthropic/claude-opus-4.8", 30],
    ["anthropic/claude-opus-4-8", 30],
    ["claude-opus-5", 30],
    ["claude-opus-5-20260901", 30],
    ["anthropic/claude-opus-5", 30],
    ["claude-opus-5-5", 24],
    ["anthropic/claude-opus-5.5", 24],
    ["anthropic/claude-opus-5-5", 24],
    ["claude-fable-5", 60],
    ["anthropic/claude-fable-5", 60],
    ["claude-fable-5-1", 60],
    ["anthropic/claude-fable-5.1", 60],
    ["anthropic/claude-fable-5-1", 60],
    ["claude-sonnet-5", 12],
    ["anthropic/claude-sonnet-5", 12],
    // Controls: Opus 4 and 4.1 still list at $15/$75.
    ["claude-opus-4-0", 90],
    ["claude-opus-4-1", 90],
    ["claude-opus-4-20250514", 90],
    ["anthropic/claude-opus-4", 90],
    ["anthropic/claude-opus-4.1", 90],
    ["anthropic/claude-opus-4-1", 90],
  ];

  for (const [model, usd] of ONE_MILLION_EACH) {
    it(`${model} costs $${usd} for 1M in and 1M out`, () => {
      expect(
        providerCostUsd({
          model,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      ).toBeCloseTo(usd, 9);
      expect(isRateCardMiss(model)).toBe(false);
    });
  }

  it("never prices a gateway Opus 4.8 id through the legacy Opus 4 row", () => {
    for (const model of [
      "anthropic/claude-opus-4.8",
      "anthropic/claude-opus-4-8",
    ]) {
      expect(resolveRateEntry(model).rate.inputPer1M).toBe(5);
    }
  });

  it("prices cache reads at the rates Anthropic lists for each release", () => {
    // Fable 5.1 reads at $0.25, a quarter of Fable 5's $1.00. Opus 5.5 reads
    // at $0.20. Neither follows the usual 0.1x-of-input rule.
    expect(resolveRate("claude-fable-5").cachedInputPer1M).toBe(1.0);
    expect(resolveRate("claude-fable-5-1").cachedInputPer1M).toBe(0.25);
    expect(resolveRate("anthropic/claude-fable-5.1").cachedInputPer1M).toBe(
      0.25,
    );
    expect(resolveRate("anthropic/claude-fable-5-1").cachedInputPer1M).toBe(
      0.25,
    );
    expect(resolveRate("claude-opus-5-5").cachedInputPer1M).toBe(0.2);
    expect(resolveRate("anthropic/claude-opus-5.5").cachedInputPer1M).toBe(0.2);
  });

  it("keeps the 1.25x cache-write premium on every Anthropic row", () => {
    for (const [key, rate] of Object.entries(PROVIDER_RATE_CARD)) {
      if (rate.provider !== "anthropic") continue;
      expect(rate.cacheWritePer1M, key).toBeCloseTo(rate.inputPer1M * 1.25, 9);
    }
  });
});

describe("providerCostUsd", () => {
  it("prices input + output at the Sonnet rate", () => {
    // 10k input @ $3/1M + 2k output @ $15/1M = 0.03 + 0.03 = $0.06
    expect(
      providerCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 2_000,
      }),
    ).toBeCloseTo(0.06, 10);
  });

  it("prices input + output at the $2/$10 list rate for claude-sonnet-5", () => {
    // 10k input @ $2/1M + 2k output @ $10/1M = 0.02 + 0.02 = $0.04
    expect(
      providerCostUsd({
        model: "claude-sonnet-5",
        inputTokens: 10_000,
        outputTokens: 2_000,
      }),
    ).toBeCloseTo(0.04, 10);
  });

  it("bills cached-input tokens at the cheaper cached rate", () => {
    // 6k billable input + 4k cached + 2k output:
    // 6000*3/1e6 + 4000*0.3/1e6 + 2000*15/1e6 = 0.018 + 0.0012 + 0.03 = 0.0492
    expect(
      providerCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 2_000,
        cachedTokens: 4_000,
      }),
    ).toBeCloseTo(0.0492, 10);
  });

  it("never lets billable input go negative when cached exceeds input", () => {
    const cost = providerCostUsd({
      model: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 0,
      cachedTokens: 9999,
    });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("bills cache-write tokens at the 1.25x premium, not fresh input", () => {
    // 6k fresh input + 4k cache writes + 2k output (inputTokens is the inclusive total):
    // 6000*3/1e6 + 4000*3.75/1e6 + 2000*15/1e6 = 0.018 + 0.015 + 0.03 = 0.063
    expect(
      providerCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheWriteTokens: 4_000,
      }),
    ).toBeCloseTo(0.063, 10);
  });

  it("charges a 25% premium on a cache-write token vs the same token as fresh input", () => {
    // Folding cache writes into inputPer1M would under-charge the Anthropic
    // premium. The 4k write tokens must cost exactly 1.25x fresh input.
    const asFresh = providerCostUsd({
      model: "claude-sonnet-4-6",
      inputTokens: 10_000,
      outputTokens: 0,
    });
    const withWrites = providerCostUsd({
      model: "claude-sonnet-4-6",
      inputTokens: 10_000,
      outputTokens: 0,
      cacheWriteTokens: 4_000,
    });
    expect(withWrites).toBeGreaterThan(asFresh);
    // 4000 tokens at (3.75 - 3.0)/1M = +0.003 USD premium.
    expect(withWrites - asFresh).toBeCloseTo(0.003, 10);
  });

  it("prices the full four-way split (fresh + read + write + output)", () => {
    // 10k inclusive input = 5k fresh + 3k read + 2k write; + 2k output:
    // 5000*3/1e6 + 3000*0.3/1e6 + 2000*3.75/1e6 + 2000*15/1e6
    //   = 0.015 + 0.0009 + 0.0075 + 0.03 = 0.0534
    expect(
      providerCostUsd({
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 2_000,
        cachedTokens: 3_000,
        cacheWriteTokens: 2_000,
      }),
    ).toBeCloseTo(0.0534, 10);
  });

  it("prices OpenAI cache writes at the fresh rate (no write premium)", () => {
    // OpenAI caching has no write premium — cacheWritePer1M == inputPer1M, so
    // marking tokens as writes doesn't change the bill vs treating them as fresh.
    const asFresh = providerCostUsd({
      model: "gpt-4o",
      inputTokens: 10_000,
      outputTokens: 0,
    });
    const withWrites = providerCostUsd({
      model: "gpt-4o",
      inputTokens: 10_000,
      outputTokens: 0,
      cacheWriteTokens: 4_000,
    });
    expect(withWrites).toBeCloseTo(asFresh, 10);
  });

  it("reports cost in micro-USD", () => {
    expect(
      providerCostUsdMicros({
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 2_000,
      }),
    ).toBe(60_000);
  });
});

describe("solveMeterMarkup", () => {
  it("reduces to 1/(1-m) when every product sells at face value", () => {
    // All creditsPerCent === 1.0 → markup === 1/(1-m).
    const m = 0.65;
    const markup = solveMeterMarkup([{ creditsPerCent: 1, weight: 1 }], m);
    expect(markup).toBeCloseTo(1 / (1 - m), 10);
  });

  it("rejects a target margin outside (0,1)", () => {
    expect(() =>
      solveMeterMarkup([{ creditsPerCent: 1, weight: 1 }], 0),
    ).toThrow();
    expect(() =>
      solveMeterMarkup([{ creditsPerCent: 1, weight: 1 }], 1),
    ).toThrow();
  });
});

describe("derivePricing", () => {
  it("blended margin equals the target by construction", () => {
    for (const m of [0.5, 0.6, 0.65, 0.7, 0.8]) {
      expect(derivePricing(m).blendedMargin).toBeCloseTo(m, 9);
    }
  });

  it("default target margin is 65% and solves a markup of ~3.38", () => {
    const d = derivePricing(DEFAULT_TARGET_MARGIN);
    expect(d.targetMargin).toBe(0.65);
    // Mix: Build (1.2¢), Scale (1.33¢), Enterprise (1.4¢) + three packs,
    // weighted and solved to a 65% blended margin.
    expect(d.meterMarkup).toBeCloseTo(3.381, 2);
    expect(d.creditValueUsd).toBe(CREDIT_VALUE_USD);
  });

  it("packs run above target margin and subscriptions below (the incentive)", () => {
    const d = derivePricing(0.65);
    const byKind = (k: "subscription" | "credit_pack") =>
      d.products.filter((p) => p.kind === k);
    for (const sub of byKind("subscription"))
      expect(sub.marginPct).toBeLessThan(0.65);
    for (const pack of byKind("credit_pack"))
      expect(pack.marginPct).toBeGreaterThan(0.65);
  });

  it("a higher target margin produces a higher meter markup", () => {
    expect(derivePricing(0.7).meterMarkup).toBeGreaterThan(
      derivePricing(0.6).meterMarkup,
    );
  });

  it("emits one derived product per configured plan and pack", () => {
    const d = derivePricing(0.65);
    expect(d.products).toHaveLength(
      SUBSCRIPTION_PLANS.length + CREDIT_PACKS.length,
    );
  });
});

describe("credit top-up presets (WL-67)", () => {
  // CREDIT_PACKS is the one price schedule for usage credits. The Billing
  // page's presets live on the purchase contract, because apps/app may import
  // a contract module and nothing else from the platform and packages/oxagen
  // cannot import this package (it depends on oxagen). This test is what keeps
  // the copy from becoming a second schedule.
  it("are the CREDIT_PACKS prices, in whole dollars", () => {
    expect([...CREDIT_TOPUP_PRESETS_USD]).toEqual(
      CREDIT_PACKS.map((pack) => pack.priceCents / 100),
    );
  });

  it("every pack price is a whole number of dollars, so a preset can carry it", () => {
    for (const pack of CREDIT_PACKS) {
      expect(pack.priceCents % 100).toBe(0);
    }
  });
});

describe("published GAU terms (ADR-055 §2)", () => {
  // The mirror of plans_gau_terms_check: stripe-sync writes these figures to
  // billing.plans, and a row that fails the CHECK would fail the whole sync.
  it("every paid plan prices a block to whole cents", () => {
    for (const plan of SUBSCRIPTION_PLANS) {
      const { ratePerGauMicros, blockSizeGau, includedGauPerMonth, currency } =
        plan.gauTerms;
      expect(ratePerGauMicros).toBeGreaterThanOrEqual(0n);
      expect(blockSizeGau).toBeGreaterThan(0);
      expect(includedGauPerMonth).toBeGreaterThanOrEqual(0);
      expect(currency).toBe("usd");
      expect((ratePerGauMicros * BigInt(blockSizeGau)) % 10_000n).toBe(0n);
    }
  });

  it("the monthly allowance grows with the tier", () => {
    const byTier = Object.fromEntries(
      SUBSCRIPTION_PLANS.map((p) => [p.tier, p.gauTerms.includedGauPerMonth]),
    );
    expect(byTier["build"]).toBeLessThan(byTier["scale"]!);
    expect(byTier["enterprise"]).toBeGreaterThanOrEqual(byTier["scale"]!);
  });
});

/**
 * The governed action is the PRIMARY meter under ADR-052, and
 * `billing.plans.included_actions_annual` is `NOT NULL DEFAULT 25000` — the
 * FREE allowance. `billing:stripe-sync` builds its plan rows from
 * SUBSCRIPTION_PLANS, so a plan definition that omits the figure does not fail
 * anything: it silently creates a paid plan priced at one fifteenth of Scale's
 * allowance, billing overage from action 25,001. These tests exist so that
 * omission cannot happen twice.
 */
describe("SUBSCRIPTION_PLANS — governed-action allowances", () => {
  it("states an allowance for every plan", () => {
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(
        Number.isSafeInteger(plan.includedActionsAnnual),
        `${plan.slug} must state includedActionsAnnual`,
      ).toBe(true);
      expect(plan.includedActionsAnnual).toBeGreaterThan(0);
    }
  });

  it("never leaves a paid plan on the free-tier default", () => {
    const FREE_DEFAULT = 25_000;
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(
        plan.includedActionsAnnual,
        `${plan.slug} is on the column's free-tier default`,
      ).not.toBe(FREE_DEFAULT);
    }
  });

  it("matches the published tier allowances, and seeds enterprise at Scale's", () => {
    const bySlug = new Map(
      SUBSCRIPTION_PLANS.map((p) => [p.slug, p.includedActionsAnnual]),
    );
    expect(bySlug.get("build-v2")).toBe(TIER_ACTION_ALLOWANCES.build);
    expect(bySlug.get("scale-v2")).toBe(TIER_ACTION_ALLOWANCES.scale);
    // Enterprise is negotiated per contract (spec §7.3), so the tier table
    // carries null. The plan row seeds at Scale's figure — an unset commitment
    // must read as neither unlimited nor free — until a signed one overwrites it.
    expect(TIER_ACTION_ALLOWANCES.enterprise).toBeNull();
    expect(bySlug.get("enterprise-v2")).toBe(ENTERPRISE_FALLBACK_ALLOWANCE);
  });

  it("does not shrink as the tier climbs", () => {
    const order = ["build-v2", "scale-v2", "enterprise-v2"];
    const figures = order.map(
      (slug) =>
        SUBSCRIPTION_PLANS.find((p) => p.slug === slug)
          ?.includedActionsAnnual ?? 0,
    );
    for (let i = 1; i < figures.length; i += 1) {
      expect(figures[i]).toBeGreaterThanOrEqual(figures[i - 1] as number);
    }
  });
});

describe("the Billing page's published price list (contract copy)", () => {
  // apps/app reads these from the start_subscription_upgrade contract, since it
  // cannot import this package (INV-03) and the contract package cannot either
  // (billing depends on oxagen). This test keeps the copy from becoming a
  // second price schedule.
  it("offers Build and Scale at the SUBSCRIPTION_PLANS prices and allowances", () => {
    for (const offered of UPGRADE_PLANS) {
      const plan = SUBSCRIPTION_PLANS.find((p) => p.slug === offered.slug);
      expect(plan, offered.slug).toBeDefined();
      expect(plan?.tier).toBe(offered.tier);
      expect(plan?.monthlyCents).toBe(offered.monthlyCents);
      expect(plan?.annualCents).toBe(offered.annualCents);
      expect(plan?.gauTerms.includedGauPerMonth).toBe(
        offered.includedGauPerMonth,
      );
    }
  });

  it("does not offer Enterprise, which is negotiated per contract", () => {
    expect(UPGRADE_PLANS.map((p) => p.tier)).not.toContain("enterprise");
  });

  it("prints the published list rate and block size every plan carries", () => {
    for (const plan of SUBSCRIPTION_PLANS) {
      expect(plan.gauTerms.ratePerGauMicros).toBe(
        BigInt(PUBLISHED_TERMS.ratePerGauMicros),
      );
      expect(plan.gauTerms.blockSizeGau).toBe(PUBLISHED_TERMS.blockSizeGau);
    }
  });

  it("prints the ACTION_RATE_BANDS prices, in order", () => {
    expect([...PUBLISHED_TERMS.volumeBandsUsdPer1000]).toEqual(
      ACTION_RATE_BANDS.map((band) => band.usdPer1000),
    );
  });

  it("prints the signup grant create_org writes", () => {
    expect(BigInt(PUBLISHED_TERMS.signupGrantCredits)).toBe(
      FREE_SIGNUP_CREDITS,
    );
  });
});
