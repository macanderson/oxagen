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
    expect(rateFor("anthropic/claude-opus-4.8")).toEqual({ inputPer1M: 15, outputPer1M: 75 });
    expect(rateFor("anthropic/claude-haiku-4.5")).toEqual({ inputPer1M: 1, outputPer1M: 5 });
  });

  it("prefers the more specific gpt-4o-mini over gpt-4o", () => {
    expect(rateFor("openai/gpt-4o-mini")).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6 });
    expect(rateFor("openai/gpt-4o")).toEqual({ inputPer1M: 2.5, outputPer1M: 10 });
  });

  it("falls back to the Sonnet-equivalent rate for unknown slugs (never zero)", () => {
    expect(rateFor("somevendor/mystery-model")).toEqual(FALLBACK_RATE);
    expect(entryFor("somevendor/mystery-model")).toBeUndefined();
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
    const p = projectCost("anthropic/claude-sonnet-4.6", { inputTokens: 1_000_000, outputTokens: 100_000 });
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
