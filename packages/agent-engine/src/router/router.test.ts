/**
 * Tests for the engine's model router and rate card.
 *
 * These mirror the CLI's rate-card.test.ts and model-router.test.ts but run
 * against the engine's port (no readConfig() dependency).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyTier,
  tierForSlug,
  modelForTier,
  tierLabel,
  accumulateUsage,
  routeModel,
  TIERS,
} from "./model-router";
import {
  rateFor,
  estimateCostUsd,
  formatUsd,
  familyOf,
  entryFor,
  RATE_CARD,
  FALLBACK_RATE,
} from "./rate-card";
import { emptyUsage } from "../types";

// ── rate card ────────────────────────────────────────────────────────────────

describe("rate card", () => {
  it("rateFor returns known anthropic rates", () => {
    const opus = rateFor("anthropic/claude-opus-4.8");
    expect(opus.inputPer1M).toBe(15.0);
    expect(opus.outputPer1M).toBe(75.0);
  });

  it("rateFor prices Claude Fable at the Opus tier (not the Sonnet fallback)", () => {
    const fable = rateFor("anthropic/claude-fable-5");
    expect(fable.inputPer1M).toBe(15.0);
    expect(fable.outputPer1M).toBe(75.0);
  });

  it("rateFor prices Claude Sonnet 5 at the Sonnet tier via family prefix", () => {
    const sonnet5 = rateFor("anthropic/claude-sonnet-5");
    expect(sonnet5.inputPer1M).toBe(3.0);
    expect(sonnet5.outputPer1M).toBe(15.0);
  });

  it("rateFor uses fallback for unknown model", () => {
    const unknown = rateFor("some/unknown-model-xyz");
    expect(unknown).toEqual(FALLBACK_RATE);
  });

  it("estimateCostUsd computes correct value", () => {
    const cost = estimateCostUsd("anthropic/claude-haiku-4.5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.0 + 5.0, 5);
  });

  it("estimateCostUsd returns 0 for empty usage", () => {
    expect(estimateCostUsd("anthropic/claude-opus-4.8", {})).toBe(0);
  });

  it("familyOf strips vendor prefix", () => {
    expect(familyOf("anthropic/claude-opus-4.8")).toBe("claude-opus-4.8");
    expect(familyOf("bare-model")).toBe("bare-model");
  });

  it("entryFor returns undefined for unknown model", () => {
    expect(entryFor("some/no-match")).toBeUndefined();
  });

  it("entryFor matches gpt-4o-mini before gpt-4o", () => {
    const entry = entryFor("openai/gpt-4o-mini");
    expect(entry?.family).toBe("gpt-4o-mini");
  });

  it("formatUsd formats zero", () => {
    expect(formatUsd(0)).toBe("$0");
  });

  it("formatUsd formats sub-cent", () => {
    expect(formatUsd(0.0042)).toMatch(/^\$0\.\d+/);
  });

  it("formatUsd formats amounts over $1", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
  });

  it("RATE_CARD is non-empty and entries have required fields", () => {
    expect(RATE_CARD.length).toBeGreaterThan(0);
    for (const entry of RATE_CARD) {
      expect(entry.family).toBeTruthy();
      expect(entry.rate.inputPer1M).toBeGreaterThanOrEqual(0);
      expect(entry.rate.outputPer1M).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── model router ─────────────────────────────────────────────────────────────

describe("classifyTier", () => {
  it("returns fast for trivial rename", () => {
    const r = classifyTier({ text: "rename the button variable" });
    expect(r.tier).toBe("fast");
  });

  it("returns precise for auth work", () => {
    const r = classifyTier({ text: "fix the OAuth login flow" });
    expect(r.tier).toBe("precise");
  });

  it("returns precise for billing work", () => {
    const r = classifyTier({ text: "update the stripe billing webhook" });
    expect(r.tier).toBe("precise");
  });

  it("returns balanced for multi-file work", () => {
    const r = classifyTier({ text: "add a feature", fileCount: 5 });
    expect(r.tier).toBe("balanced");
  });

  it("returns precise for wide blast radius", () => {
    const r = classifyTier({ text: "refactor the module", fileCount: 10 });
    expect(r.tier).toBe("precise");
  });

  it("returns balanced for design/debug signals", () => {
    const r = classifyTier({ text: "debug why the query is slow" });
    expect(r.tier).toBe("balanced");
  });

  it("returns fast for very short well-scoped asks", () => {
    const r = classifyTier({ text: "add a log line", fileCount: 1 });
    expect(r.tier).toBe("fast");
  });

  it("includes a rationale string", () => {
    const r = classifyTier({ text: "fix the auth session expiry" });
    expect(r.rationale).toBeTruthy();
  });
});

describe("tierForSlug", () => {
  it("haiku → fast", () => {
    expect(tierForSlug("anthropic/claude-haiku-4.5")).toBe("fast");
  });

  it("opus → precise", () => {
    expect(tierForSlug("anthropic/claude-opus-4.8")).toBe("precise");
  });

  it("fable / mythos → precise", () => {
    expect(tierForSlug("anthropic/claude-fable-5")).toBe("precise");
    expect(tierForSlug("anthropic/claude-mythos-5")).toBe("precise");
  });

  it("sonnet → balanced", () => {
    expect(tierForSlug("anthropic/claude-sonnet-5")).toBe("balanced");
  });

  it("gpt-5 → precise", () => {
    expect(tierForSlug("openai/gpt-5")).toBe("precise");
  });

  it("gpt-4o-mini → fast", () => {
    expect(tierForSlug("openai/gpt-4o-mini")).toBe("fast");
  });
});

describe("modelForTier", () => {
  it("returns a string for each tier", () => {
    for (const t of TIERS) {
      expect(typeof modelForTier(t)).toBe("string");
    }
  });
});

describe("tierLabel", () => {
  it("maps tiers to human labels", () => {
    expect(tierLabel("fast")).toBe("Haiku");
    expect(tierLabel("balanced")).toBe("Sonnet");
    expect(tierLabel("precise")).toBe("Fable");
  });
});

describe("accumulateUsage", () => {
  it("sums token counts", () => {
    const result = accumulateUsage(
      { inputTokens: 100, outputTokens: 50, costUsd: 0 },
      "anthropic/claude-haiku-4.5",
      { inputTokens: 200, outputTokens: 100 },
    );
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(150);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("handles missing token fields gracefully", () => {
    const result = accumulateUsage(
      emptyUsage(),
      "anthropic/claude-opus-4.8",
      {},
    );
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("prices a cache hit at the discounted rate — the SAME usage costs less with cachedInputTokens set", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    };
    const withCache = accumulateUsage(
      emptyUsage(),
      "anthropic/claude-sonnet-4.6",
      usage,
    );
    const withoutCache = accumulateUsage(
      emptyUsage(),
      "anthropic/claude-sonnet-4.6",
      { inputTokens: 1_000_000, outputTokens: 0 },
    );
    expect(withCache.costUsd).toBeLessThan(withoutCache.costUsd);
    expect(withCache.costUsd).toBeCloseTo(0.3); // 1M cached @ $0.3/1M
    expect(withoutCache.costUsd).toBeCloseTo(3.0); // 1M fresh @ $3/1M
    // Token totals are unaffected by the cache split — only cost is.
    expect(withCache.inputTokens).toBe(withoutCache.inputTokens);
  });
});

describe("routeModel", () => {
  afterEach(() => {
    delete process.env["OXAGEN_MODEL"];
  });

  it("respects explicit override", () => {
    const r = routeModel({ text: "do something" }, "openai/gpt-4o");
    expect(r.model).toBe("openai/gpt-4o");
    expect(r.rationale).toBe("pinned model");
  });

  it("respects OXAGEN_MODEL env var", () => {
    process.env["OXAGEN_MODEL"] = "anthropic/claude-haiku-4.5";
    const r = routeModel({ text: "do something" });
    expect(r.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("auto-routes when no override", () => {
    const r = routeModel({ text: "rename the variable typo" });
    expect(r.tier).toBe("fast");
    expect(r.model).toBeTruthy();
  });
});
