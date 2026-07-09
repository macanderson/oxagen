/**
 * Rate card — proves pricing is correct, vendor-agnostic, and projectable: the
 * longest-prefix family match, dollar math per 1M tokens, the fallback for
 * unknown slugs, and the compare-every-model projection that backs `oxagen cost`.
 */
import { describe, it, expect } from "vitest";
import {
  rateFor,
  entryFor,
  estimateCostUsd,
  formatUsd,
  projectCost,
  compareModels,
  listRateCard,
  FALLBACK_RATE,
} from "../rate-card.js";

describe("rateFor", () => {
  it("matches a family across the vendor/ prefix and version suffix", () => {
    expect(rateFor("anthropic/claude-opus-4.8")).toEqual({ inputPer1M: 15, outputPer1M: 75, cachedInputPer1M: 1.5 });
    expect(rateFor("anthropic/claude-haiku-4.5")).toEqual({ inputPer1M: 1, outputPer1M: 5, cachedInputPer1M: 0.1 });
  });

  it("prefers the more specific gpt-4o-mini over gpt-4o", () => {
    expect(rateFor("openai/gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 });
    expect(rateFor("openai/gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 });
  });

  it("falls back to the Sonnet-equivalent rate for unknown slugs (never zero)", () => {
    expect(rateFor("somevendor/mystery-model")).toEqual(FALLBACK_RATE);
    expect(entryFor("somevendor/mystery-model")).toBeUndefined();
  });

  it("every card entry's cached rate is strictly cheaper than its fresh input rate", () => {
    for (const entry of listRateCard()) {
      expect(entry.rate.cachedInputPer1M).toBeGreaterThan(0);
      expect(entry.rate.cachedInputPer1M).toBeLessThan(entry.rate.inputPer1M);
    }
    expect(FALLBACK_RATE.cachedInputPer1M).toBeLessThan(FALLBACK_RATE.inputPer1M);
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output independently per 1M tokens", () => {
    // 1M in @ $15 + 1M out @ $75 = $90 on opus.
    expect(estimateCostUsd("anthropic/claude-opus-4.8", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(90);
    // Half a million haiku output @ $5/1M = $2.50.
    expect(estimateCostUsd("anthropic/claude-haiku-4.5", { outputTokens: 500_000 })).toBeCloseTo(2.5);
  });

  it("treats missing token directions as zero", () => {
    expect(estimateCostUsd("openai/gpt-4o", {})).toBe(0);
  });

  it("prices cached-read tokens at the discounted rate, not the fresh-input rate", () => {
    // Sonnet: $3/1M fresh, $0.3/1M cached. 1M input, all served from cache.
    const allCached = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
    });
    expect(allCached).toBeCloseTo(0.3);

    // Same 1M input with NONE cached prices at the full fresh rate — proves
    // the discount is actually being applied, not just always-zero-cost.
    const noneCached = estimateCostUsd("anthropic/claude-sonnet-4.6", { inputTokens: 1_000_000 });
    expect(noneCached).toBeCloseTo(3.0);
    expect(allCached).toBeLessThan(noneCached);
  });

  it("splits a mixed fresh+cached input correctly (cachedTokens is a SUBSET of inputTokens)", () => {
    // 600k fresh @ $3/1M + 400k cached @ $0.3/1M = $1.80 + $0.12 = $1.92.
    const cost = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 1_000_000,
      cachedTokens: 400_000,
    });
    expect(cost).toBeCloseTo(1.92);
  });

  it("never lets billable-fresh input go negative when cachedTokens exceeds inputTokens", () => {
    // Malformed usage (cache count larger than the reported input total) must
    // still price sanely rather than produce a negative fresh-token cost —
    // mirrors packages/billing/src/pricing.ts's providerCostUsd, which clamps
    // the same way.
    const cost = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 100,
      cachedTokens: 1_000,
    });
    // billableInput clamps to 0 (100 - 1000 would be negative); the full
    // reported cached count still prices at the cached rate: 1000/1e6 * 0.3.
    expect(cost).toBeCloseTo((1_000 / 1_000_000) * 0.3);
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe("formatUsd", () => {
  it("renders small, sub-cent, and dollar amounts distinctly", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.2)).toBe("$1.20");
  });
});

describe("projectCost", () => {
  it("breaks cost into input/output/total with vendor metadata", () => {
    const p = projectCost("anthropic/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(p.vendor).toBe("anthropic");
    expect(p.label).toBe("Claude Sonnet");
    expect(p.inputCostUsd).toBeCloseTo(3);
    expect(p.outputCostUsd).toBeCloseTo(1.5);
    expect(p.totalUsd).toBeCloseTo(4.5);
    expect(p.fallback).toBe(false);
  });

  it("flags the fallback for an unpriced model", () => {
    const p = projectCost("acme/unknown", { inputTokens: 1000 });
    expect(p.fallback).toBe(true);
  });
});

describe("compareModels", () => {
  it("prices the same usage across every family, cheapest first", () => {
    const rows = compareModels({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(rows.length).toBe(listRateCard().length);
    // Sorted ascending by total.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.totalUsd).toBeGreaterThanOrEqual(rows[i - 1]!.totalUsd);
    }
    // gpt-4o-mini is the cheapest family in the card; opus the dearest.
    expect(rows[0]!.label).toBe("GPT-4o mini");
    expect(rows[rows.length - 1]!.label).toBe("Claude Opus");
  });
});
