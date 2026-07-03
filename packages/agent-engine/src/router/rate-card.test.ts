/**
 * Rate card — the engine's vendored model pricing.
 *
 * Covers family matching (longest-prefix order, vendor stripping), rate lookup
 * with the Sonnet fallback, cost estimation, USD formatting across all four
 * magnitude bands, single- and cross-model cost projection, and the card listing.
 */
import { describe, it, expect } from "vitest";
import {
  RATE_CARD,
  FALLBACK_RATE,
  familyOf,
  rateFor,
  entryFor,
  estimateCostUsd,
  formatUsd,
  projectCost,
  compareModels,
  listRateCard,
} from "./rate-card";

describe("familyOf", () => {
  it("strips a vendor prefix", () => {
    expect(familyOf("anthropic/claude-opus-4.8")).toBe("claude-opus-4.8");
  });

  it("returns the slug unchanged when there is no vendor prefix", () => {
    expect(familyOf("claude-haiku-4.5")).toBe("claude-haiku-4.5");
  });
});

describe("rateFor", () => {
  it("prices Opus at the frontier rate", () => {
    expect(rateFor("anthropic/claude-opus-4.8")).toEqual({ inputPer1M: 15.0, outputPer1M: 75.0, cachedInputPer1M: 1.5 });
  });

  it("prices Sonnet distinctly from Opus", () => {
    expect(rateFor("anthropic/claude-sonnet-4.6")).toEqual({ inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 });
  });

  it("matches the most-specific family first (gpt-4o-mini before gpt-4o)", () => {
    expect(rateFor("openai/gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 });
    expect(rateFor("openai/gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10.0, cachedInputPer1M: 1.25 });
  });

  it("falls back to the Sonnet-equivalent rate for an unknown family", () => {
    expect(rateFor("mistral/mistral-large-2")).toEqual(FALLBACK_RATE);
  });

  it("every card entry's cached rate is strictly cheaper than its fresh input rate", () => {
    for (const entry of listRateCard()) {
      expect(entry.rate.cachedInputPer1M).toBeGreaterThan(0);
      expect(entry.rate.cachedInputPer1M).toBeLessThan(entry.rate.inputPer1M);
    }
  });
});

describe("entryFor", () => {
  it("returns the matched card entry", () => {
    const entry = entryFor("anthropic/claude-haiku-4.5");
    expect(entry?.family).toBe("claude-haiku");
    expect(entry?.vendor).toBe("anthropic");
    expect(entry?.label).toBe("Claude Haiku");
  });

  it("returns undefined when no family matches", () => {
    expect(entryFor("cohere/command-r")).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output tokens at the family rate", () => {
    // 1M in @ $15 + 1M out @ $75 = $90 on Opus.
    expect(estimateCostUsd("anthropic/claude-opus-4.8", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(90);
  });

  it("treats a missing direction as zero tokens", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", { inputTokens: 1_000_000 })).toBe(3);
    expect(estimateCostUsd("anthropic/claude-sonnet-5", {})).toBe(0);
  });

  it("prices cached-read tokens at the discounted rate, not the fresh-input rate", () => {
    const allCached = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
    });
    expect(allCached).toBeCloseTo(0.3);
    const noneCached = estimateCostUsd("anthropic/claude-sonnet-4.6", { inputTokens: 1_000_000 });
    expect(noneCached).toBeCloseTo(3.0);
    expect(allCached).toBeLessThan(noneCached);
  });
});

describe("formatUsd", () => {
  it("renders exactly zero", () => {
    expect(formatUsd(0)).toBe("$0");
  });

  it("renders a sub-hundredth-of-a-cent amount with the floor marker", () => {
    expect(formatUsd(0.00005)).toBe("<$0.0001");
  });

  it("renders sub-dollar amounts to four decimals", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("renders dollar-and-up amounts to two decimals", () => {
    expect(formatUsd(1.2)).toBe("$1.20");
  });
});

describe("projectCost", () => {
  it("breaks out a matched model's projection", () => {
    const p = projectCost("openai/gpt-5", { inputTokens: 1_000_000, outputTokens: 2_000_000 });
    expect(p.vendor).toBe("openai");
    expect(p.label).toBe("GPT-5");
    expect(p.family).toBe("gpt-5");
    expect(p.inputCostUsd).toBeCloseTo(1.25, 5);
    expect(p.outputCostUsd).toBeCloseTo(20, 5);
    expect(p.totalUsd).toBeCloseTo(21.25, 5);
    expect(p.fallback).toBe(false);
  });

  it("marks a fallback projection and derives display fields from the slug", () => {
    const p = projectCost("mistral/mistral-large", { inputTokens: 1_000_000 });
    expect(p.fallback).toBe(true);
    expect(p.vendor).toBe("unknown");
    expect(p.family).toBe("mistral-large");
    expect(p.label).toBe("mistral-large");
    expect(p.inputCostUsd).toBeCloseTo(3, 5);
    expect(p.outputTokens).toBe(0);
  });
});

describe("compareModels", () => {
  it("prices the same usage across every family, cheapest first", () => {
    const rows = compareModels({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(rows).toHaveLength(RATE_CARD.length);
    // Sorted ascending by total cost.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.totalUsd).toBeGreaterThanOrEqual(rows[i - 1]!.totalUsd);
    }
    // gpt-4o-mini is the cheapest family in the card.
    expect(rows[0]!.family).toBe("gpt-4o-mini");
  });
});

describe("listRateCard", () => {
  it("returns the full card", () => {
    expect(listRateCard()).toBe(RATE_CARD);
    expect(listRateCard().length).toBeGreaterThan(0);
  });
});
