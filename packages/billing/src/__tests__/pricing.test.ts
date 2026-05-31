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
} from "../pricing.js";

describe("resolveRate", () => {
  it("returns the exact rate for a known model id", () => {
    expect(resolveRate("claude-sonnet-4-6")).toBe(PROVIDER_RATE_CARD["claude-sonnet-4-6"]);
  });

  it("matches the longest prefix for a versioned/date-stamped id", () => {
    // A dated Sonnet id must resolve to claude-sonnet-4-6, not the shorter
    // claude-sonnet-4 fallback.
    expect(resolveRate("claude-sonnet-4-6-20260101")).toBe(PROVIDER_RATE_CARD["claude-sonnet-4-6"]);
  });

  it("falls back to the configured fallback model for an unknown id", () => {
    expect(resolveRate("mistral-large-2")).toBe(PROVIDER_RATE_CARD["claude-sonnet-4-6"]);
  });
});

describe("providerCostUsd", () => {
  it("prices input + output at the Sonnet rate", () => {
    // 10k input @ $3/1M + 2k output @ $15/1M = 0.03 + 0.03 = $0.06
    expect(providerCostUsd({ model: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 2_000 })).toBeCloseTo(
      0.06,
      10,
    );
  });

  it("bills cached-input tokens at the cheaper cached rate", () => {
    // 6k billable input + 4k cached + 2k output:
    // 6000*3/1e6 + 4000*0.3/1e6 + 2000*15/1e6 = 0.018 + 0.0012 + 0.03 = 0.0492
    expect(
      providerCostUsd({ model: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 2_000, cachedTokens: 4_000 }),
    ).toBeCloseTo(0.0492, 10);
  });

  it("never lets billable input go negative when cached exceeds input", () => {
    const cost = providerCostUsd({ model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 0, cachedTokens: 9999 });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it("reports cost in micro-USD", () => {
    expect(providerCostUsdMicros({ model: "claude-sonnet-4-6", inputTokens: 10_000, outputTokens: 2_000 })).toBe(60_000);
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
    expect(() => solveMeterMarkup([{ creditsPerCent: 1, weight: 1 }], 0)).toThrow();
    expect(() => solveMeterMarkup([{ creditsPerCent: 1, weight: 1 }], 1)).toThrow();
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
    const byKind = (k: "subscription" | "credit_pack") => d.products.filter((p) => p.kind === k);
    for (const sub of byKind("subscription")) expect(sub.marginPct).toBeLessThan(0.65);
    for (const pack of byKind("credit_pack")) expect(pack.marginPct).toBeGreaterThan(0.65);
  });

  it("a higher target margin produces a higher meter markup", () => {
    expect(derivePricing(0.7).meterMarkup).toBeGreaterThan(derivePricing(0.6).meterMarkup);
  });

  it("emits one derived product per configured plan and pack", () => {
    const d = derivePricing(0.65);
    expect(d.products).toHaveLength(SUBSCRIPTION_PLANS.length + CREDIT_PACKS.length);
  });
});
