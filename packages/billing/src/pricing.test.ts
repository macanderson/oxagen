/**
 * Unit tests for the pricing model (packages/billing/src/pricing.ts).
 *
 * Pure math — no DB, no Stripe. Verifies the cost meter (provider rate card),
 * the blended-margin solve, and the invariant the whole system rests on:
 * derivePricing(m).blendedMargin === m.
 */
import { describe, it, expect } from "vitest";
import {
  CREDIT_VALUE_USD,
  DEFAULT_TARGET_MARGIN,
  PROVIDER_RATE_CARD,
  SUBSCRIPTION_PLANS,
  CREDIT_PACKS,
  resolveRate,
  providerCostUsd,
  providerCostUsdMicros,
  solveMeterMarkup,
  derivePricing,
} from "./pricing";

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

  it("prices Claude Fable 5 at the Opus tier, not the Sonnet fallback", () => {
    // Fable is Anthropic's most capable model; without an explicit row it would
    // resolve to the Sonnet fallback and under-charge. Both the bare and gateway
    // (creator/model) forms must land on the Opus-tier $15/$75 rate.
    expect(resolveRate("claude-fable-5")).toBe(
      PROVIDER_RATE_CARD["claude-fable-5"],
    );
    expect(resolveRate("anthropic/claude-fable-5")).toBe(
      PROVIDER_RATE_CARD["anthropic/claude-fable-5"],
    );
    expect(resolveRate("claude-fable-5").outputPer1M).toBe(75.0);
  });

  it("prices Claude Sonnet 5 explicitly at the Sonnet tier", () => {
    expect(resolveRate("claude-sonnet-5")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-5"],
    );
    expect(resolveRate("anthropic/claude-sonnet-5")).toBe(
      PROVIDER_RATE_CARD["anthropic/claude-sonnet-5"],
    );
    expect(resolveRate("claude-sonnet-5").outputPer1M).toBe(15.0);
  });

  it("matches the longest prefix for a versioned/date-stamped Sonnet 5 id", () => {
    // A dated Sonnet 5 id must resolve to claude-sonnet-5, not fall through to
    // the shorter claude-sonnet-4 / claude-sonnet-4-6 rows.
    expect(resolveRate("claude-sonnet-5-20260101")).toBe(
      PROVIDER_RATE_CARD["claude-sonnet-5"],
    );
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

  it("prices input + output at the Sonnet rate for claude-sonnet-5", () => {
    // Same $3/$15 Sonnet-tier rate as claude-sonnet-4-6:
    // 10k input @ $3/1M + 2k output @ $15/1M = 0.03 + 0.03 = $0.06
    expect(
      providerCostUsd({
        model: "claude-sonnet-5",
        inputTokens: 10_000,
        outputTokens: 2_000,
      }),
    ).toBeCloseTo(0.06, 10);
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
