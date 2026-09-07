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
    expect(rateFor("anthropic/claude-opus-4.8")).toEqual({
      inputPer1M: 15.0,
      outputPer1M: 75.0,
      cachedInputPer1M: 1.5,
    });
  });

  it("prices Sonnet distinctly from Opus", () => {
    expect(rateFor("anthropic/claude-sonnet-4.6")).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedInputPer1M: 0.3,
    });
  });

  it("prices GLM 5.2 from the gateway card (judge-role slug)", () => {
    expect(rateFor("zai/glm-5.2")).toEqual({
      inputPer1M: 1.4,
      outputPer1M: 4.4,
      cachedInputPer1M: 0.26,
    });
  });

  it("matches glm-5.2-fast before glm-5.2, and unknown GLMs hit the generic glm row", () => {
    expect(rateFor("zai/glm-5.2-fast")).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 10.25,
      cachedInputPer1M: 0.5,
    });
    expect(rateFor("zai/glm-5-turbo")).toEqual({
      inputPer1M: 1.2,
      outputPer1M: 4.0,
      cachedInputPer1M: 0.24,
    });
    expect(rateFor("zai/glm-4.7-flash")).toEqual({
      inputPer1M: 0.95,
      outputPer1M: 3.15,
      cachedInputPer1M: 0.2,
    });
  });

  it("matches the most-specific family first (gpt-4o-mini before gpt-4o)", () => {
    expect(rateFor("openai/gpt-4o-mini")).toEqual({
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      cachedInputPer1M: 0.075,
    });
    expect(rateFor("openai/gpt-4o")).toEqual({
      inputPer1M: 2.5,
      outputPer1M: 10.0,
      cachedInputPer1M: 1.25,
    });
  });

  it("falls back to the Sonnet-equivalent rate for an unknown family", () => {
    expect(rateFor("mistral/mistral-large-2")).toEqual(FALLBACK_RATE);
  });

  it("every card entry's cached rate is cheaper than (or, if genuinely free, equal to) its fresh input rate", () => {
    // >= 0 rather than > 0: DeepSeek V4 Pro/Flash publish a genuinely free
    // ($0.0/M) cached-read rate on the Gateway — not a missing/unpriced row.
    for (const entry of listRateCard()) {
      expect(entry.rate.cachedInputPer1M).toBeGreaterThanOrEqual(0);
      expect(entry.rate.cachedInputPer1M).toBeLessThan(entry.rate.inputPer1M);
    }
  });

  it("prices xAI Grok families, most-specific first", () => {
    expect(rateFor("xai/grok-4")).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedInputPer1M: 0.75,
    });
    expect(rateFor("xai/grok-4.5")).toEqual({
      inputPer1M: 2.0,
      outputPer1M: 6.0,
      cachedInputPer1M: 0.5,
    });
    expect(rateFor("xai/grok-4.3")).toEqual({
      inputPer1M: 1.25,
      outputPer1M: 2.5,
      cachedInputPer1M: 0.2,
    });
    expect(rateFor("xai/grok-build-0.1")).toEqual({
      inputPer1M: 1.0,
      outputPer1M: 2.0,
      cachedInputPer1M: 0.2,
    });
  });

  it("prices DeepSeek families, and an unqualified deepseek-v4 slug falls back", () => {
    expect(rateFor("deepseek/deepseek-v3.2")).toEqual({
      inputPer1M: 0.28,
      outputPer1M: 0.42,
      cachedInputPer1M: 0.03,
    });
    expect(rateFor("deepseek/deepseek-v4-pro")).toEqual({
      inputPer1M: 1.74,
      outputPer1M: 3.48,
      cachedInputPer1M: 0.0,
    });
    expect(rateFor("deepseek/deepseek-v4-flash")).toEqual({
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      cachedInputPer1M: 0.0,
    });
    expect(rateFor("deepseek/deepseek-v4")).toEqual(FALLBACK_RATE);
  });

  it("prices the gpt-5.x and o-series OpenAI families, most-specific first", () => {
    expect(rateFor("openai/gpt-5.2")).toEqual({
      inputPer1M: 1.75,
      outputPer1M: 14.0,
      cachedInputPer1M: 0.17,
    });
    expect(rateFor("openai/gpt-5-mini")).toEqual({
      inputPer1M: 0.25,
      outputPer1M: 2.0,
      cachedInputPer1M: 0.03,
    });
    expect(rateFor("openai/gpt-5-nano")).toEqual({
      inputPer1M: 0.05,
      outputPer1M: 0.4,
      cachedInputPer1M: 0.01,
    });
    expect(rateFor("openai/gpt-5")).toEqual({
      inputPer1M: 1.25,
      outputPer1M: 10.0,
      cachedInputPer1M: 0.13,
    });
    expect(rateFor("openai/o3")).toEqual({
      inputPer1M: 2.0,
      outputPer1M: 8.0,
      cachedInputPer1M: 0.5,
    });
    expect(rateFor("openai/o4-mini")).toEqual({
      inputPer1M: 1.1,
      outputPer1M: 4.4,
      cachedInputPer1M: 0.28,
    });
    // "openai/o4" (bare) is not a published Gateway SKU — falls back.
    expect(rateFor("openai/o4")).toEqual(FALLBACK_RATE);
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
    expect(
      estimateCostUsd("anthropic/claude-opus-4.8", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(90);
  });

  it("treats a missing direction as zero tokens", () => {
    expect(
      estimateCostUsd("anthropic/claude-sonnet-5", { inputTokens: 1_000_000 }),
    ).toBe(3);
    expect(estimateCostUsd("anthropic/claude-sonnet-5", {})).toBe(0);
  });

  it("prices cached-read tokens at the discounted rate, not the fresh-input rate", () => {
    const allCached = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000,
    });
    expect(allCached).toBeCloseTo(0.3);
    const noneCached = estimateCostUsd("anthropic/claude-sonnet-4.6", {
      inputTokens: 1_000_000,
    });
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
    const p = projectCost("openai/gpt-5", {
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
    });
    expect(p.vendor).toBe("openai");
    expect(p.label).toBe("GPT-5");
    expect(p.family).toBe("gpt-5");
    expect(p.inputCostUsd).toBeCloseTo(1.25, 5);
    expect(p.outputCostUsd).toBeCloseTo(20, 5);
    expect(p.totalUsd).toBeCloseTo(21.25, 5);
    expect(p.fallback).toBe(false);
  });

  it("prices gpt-5.5-pro at its own pro rate, not the generic gpt-5 prefix", () => {
    const p = projectCost("openai/gpt-5.5-pro", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(p.family).toBe("gpt-5.5-pro");
    expect(p.inputCostUsd).toBeCloseTo(30, 5);
    expect(p.outputCostUsd).toBeCloseTo(180, 5);
  });

  it("prices gpt-5.5 (non-pro) at its own rate", () => {
    const p = projectCost("openai/gpt-5.5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(p.family).toBe("gpt-5.5");
    expect(p.inputCostUsd).toBeCloseTo(5, 5);
    expect(p.outputCostUsd).toBeCloseTo(30, 5);
  });

  it("prices gemini-3-pro above the generic gemini row", () => {
    const p = projectCost("google/gemini-3-pro-preview", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(p.family).toBe("gemini-3-pro");
    expect(p.inputCostUsd).toBeCloseTo(2, 5);
    expect(p.outputCostUsd).toBeCloseTo(12, 5);
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

  it("prices the cached subset at the cache-read rate (does not overstate)", () => {
    // Anthropic Sonnet: fresh input 3/1M, cache-read 0.3/1M. Half the input
    // tokens are cache reads → 0.5M×3 + 0.5M×0.3 = 1.5 + 0.15 = 1.65.
    const p = projectCost("anthropic/claude-sonnet-5", {
      inputTokens: 1_000_000,
      cachedTokens: 500_000,
    });
    expect(p.cachedTokens).toBe(500_000);
    expect(p.inputCostUsd).toBeCloseTo(1.65, 5);
    expect(p.totalUsd).toBeCloseTo(1.65, 5);
  });

  it("omitting cachedTokens reproduces the full-price (pre-cache) number", () => {
    const p = projectCost("anthropic/claude-sonnet-5", {
      inputTokens: 1_000_000,
    });
    expect(p.cachedTokens).toBe(0);
    expect(p.inputCostUsd).toBeCloseTo(3, 5);
  });

  it("agrees with estimateCostUsd on totalUsd for a cache-heavy usage", () => {
    const usage = {
      inputTokens: 800_000,
      outputTokens: 120_000,
      cachedTokens: 600_000,
    };
    const model = "anthropic/claude-sonnet-5";
    expect(projectCost(model, usage).totalUsd).toBeCloseTo(
      estimateCostUsd(model, usage),
      8,
    );
  });
});

describe("compareModels", () => {
  it("prices the same usage across every family, cheapest first", () => {
    const rows = compareModels({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(rows).toHaveLength(RATE_CARD.length);
    // Sorted ascending by total cost.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.totalUsd).toBeGreaterThanOrEqual(rows[i - 1]!.totalUsd);
    }
    // deepseek-v4-flash ($0.14/$0.28) is the cheapest family in the card —
    // narrowly undercuts gpt-5-nano ($0.05/$0.40) and gpt-4o-mini ($0.15/$0.60)
    // on this equal-weight (1M in + 1M out) usage.
    expect(rows[0]!.family).toBe("deepseek-v4-flash");
  });
});

describe("listRateCard", () => {
  it("returns the full card", () => {
    expect(listRateCard()).toBe(RATE_CARD);
    expect(listRateCard().length).toBeGreaterThan(0);
  });
});
