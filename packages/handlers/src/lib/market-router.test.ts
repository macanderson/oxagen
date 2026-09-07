/**
 * Unit tests for the pure Verified-Outcome Market Router core.
 *
 * Everything here is I/O-free, so nothing is mocked: the tier → gateway-slug
 * resolution goes through @oxagen/ai's `tierModelId`, which reads the
 * OXAGEN_LLM_* env registry (defaulted in packages/config), so the deterministic
 * fallback resolves a real slug without any environment setup.
 *
 * The DB-backed policy loader and the two handlers that compose this module are
 * covered in ../router.handlers.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { RoutingStatRow } from "@oxagen/telemetry";
import {
  DEFAULT_MIN_SAMPLES,
  DEFAULT_SUCCESS_THRESHOLD,
  DEFAULT_WINDOW_DAYS,
  ROUTING_POLICY_OFF,
  classifyTier,
  decideMarketRoute,
  deriveTaskClass,
  normalizeRoutingPolicy,
  resolveEffectiveRoutingPolicy,
  summarizeRoutingStats,
  tierForSlug,
  type MarketRoutingPolicy,
} from "./market-router";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function stat(over: Partial<RoutingStatRow> = {}): RoutingStatRow {
  return {
    taskClass: "auth/single",
    model: "anthropic/claude-haiku-4.5",
    tier: "fast",
    samples: 100,
    verifiedCount: 98,
    verifiedRate: 0.98,
    avgCostUsdMicros: 500,
    avgLatencyMs: 1000,
    lastSeen: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const ENFORCING: MarketRoutingPolicy = normalizeRoutingPolicy({
  mode: "enforce",
});

// ── Policy normalization ─────────────────────────────────────────────────────

describe("normalizeRoutingPolicy", () => {
  it("fills every field from the OFF defaults when given nothing", () => {
    expect(normalizeRoutingPolicy(undefined)).toEqual(ROUTING_POLICY_OFF);
    expect(normalizeRoutingPolicy(null)).toEqual(ROUTING_POLICY_OFF);
    expect(normalizeRoutingPolicy({})).toEqual(ROUTING_POLICY_OFF);
  });

  it("keeps a partial override and defaults the rest", () => {
    const p = normalizeRoutingPolicy({ mode: "shadow", minSamples: 5 });
    expect(p.mode).toBe("shadow");
    expect(p.minSamples).toBe(5);
    expect(p.successThreshold).toBe(DEFAULT_SUCCESS_THRESHOLD);
    expect(p.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(p.escalateOnRejection).toBe(true);
  });

  it("preserves a falsy-but-meaningful override (threshold 0, escalate false)", () => {
    const p = normalizeRoutingPolicy({
      successThreshold: 0,
      escalateOnRejection: false,
      minSamples: 0,
    });
    expect(p.successThreshold).toBe(0);
    expect(p.escalateOnRejection).toBe(false);
    expect(p.minSamples).toBe(0);
  });

  it("defaults minSamples to the documented constant", () => {
    expect(ROUTING_POLICY_OFF.minSamples).toBe(DEFAULT_MIN_SAMPLES);
  });
});

// ── Governance resolution ────────────────────────────────────────────────────

describe("resolveEffectiveRoutingPolicy", () => {
  const org = normalizeRoutingPolicy({ mode: "shadow" });
  const ws = normalizeRoutingPolicy({ mode: "enforce" });

  it("falls back to OFF with source=default when neither scope has a row", () => {
    expect(resolveEffectiveRoutingPolicy(null, null)).toEqual({
      policy: ROUTING_POLICY_OFF,
      source: "default",
    });
  });

  it("uses the org row when the workspace has none", () => {
    expect(resolveEffectiveRoutingPolicy(org, null)).toEqual({
      policy: org,
      source: "org",
    });
  });

  it("lets the workspace row override the org row (most specific wins)", () => {
    expect(resolveEffectiveRoutingPolicy(org, ws)).toEqual({
      policy: ws,
      source: "workspace",
    });
  });
});

// ── Task-class derivation ────────────────────────────────────────────────────

describe("deriveTaskClass", () => {
  it("labels a high-stakes domain and buckets breadth", () => {
    expect(deriveTaskClass({ text: "fix the oauth login session bug" })).toBe(
      "auth/single",
    );
    expect(
      deriveTaskClass({ text: "reconcile the stripe invoice", fileCount: 2 }),
    ).toBe("billing/small");
    expect(
      deriveTaskClass({ text: "backfill the migration", fileCount: 5 }),
    ).toBe("migration/multi");
    expect(
      deriveTaskClass({ text: "rotate the encryption secret", fileCount: 9 }),
    ).toBe("security/wide");
  });

  it("prefers the first matching domain, in declaration order", () => {
    // "auth" is declared before "billing", so a prompt naming both is auth.
    expect(deriveTaskClass({ text: "oauth for the billing portal" })).toBe(
      "auth/single",
    );
  });

  it("falls back to design / trivial / general when no domain matches", () => {
    expect(deriveTaskClass({ text: "debug the sort" })).toBe("design/single");
    expect(deriveTaskClass({ text: "rename the helper" })).toBe(
      "trivial/single",
    );
    expect(deriveTaskClass({ text: "look at this" })).toBe("general/single");
  });

  it("treats design language as design even when trivial words appear too", () => {
    expect(deriveTaskClass({ text: "rename and refactor the helper" })).toBe(
      "design/single",
    );
  });

  it("buckets cross-package work ahead of the file-count buckets", () => {
    expect(
      deriveTaskClass({ text: "look at this", crossPackage: true }),
    ).toBe("general/cross-package");
    // …but a truly wide change still wins over cross-package.
    expect(
      deriveTaskClass({
        text: "look at this",
        crossPackage: true,
        fileCount: 12,
      }),
    ).toBe("general/wide");
  });

  it("is deterministic — the same signals always yield the same class", () => {
    const signals = { text: "investigate the deadlock", fileCount: 3 };
    expect(deriveTaskClass(signals)).toBe(deriveTaskClass(signals));
  });
});

// ── Deterministic tier classification ────────────────────────────────────────

describe("classifyTier", () => {
  it("pins a high-stakes domain to precise regardless of size", () => {
    const d = classifyTier({ text: "rotate the oauth credential" });
    expect(d.tier).toBe("precise");
    expect(d.rationale).toMatch(/high-stakes/);
    expect(d.model.length).toBeGreaterThan(0);
  });

  it("escalates on breadth before it looks at language", () => {
    expect(classifyTier({ text: "look at this", fileCount: 9 }).tier).toBe(
      "precise",
    );
    expect(
      classifyTier({ text: "look at this", fileCount: 5, crossPackage: true })
        .tier,
    ).toBe("precise");
    expect(classifyTier({ text: "look at this", fileCount: 4 }).tier).toBe(
      "balanced",
    );
    expect(
      classifyTier({ text: "look at this", crossPackage: true }).rationale,
    ).toMatch(/package/);
  });

  it("pins mechanical work to fast and design work to balanced", () => {
    expect(classifyTier({ text: "fix a typo in the readme" }).tier).toBe(
      "fast",
    );
    expect(classifyTier({ text: "redesign the ingest pipeline" }).tier).toBe(
      "balanced",
    );
  });

  it("treats a very short unqualified ask as fast, and a long one as balanced", () => {
    expect(classifyTier({ text: "list the rows" }).tier).toBe("fast");
    expect(
      classifyTier({
        text: "please take a careful look at the thing we talked about earlier and tell me what you make of it",
      }).tier,
    ).toBe("balanced");
  });
});

describe("tierForSlug", () => {
  it("classifies small variants as fast even inside a frontier family", () => {
    expect(tierForSlug("anthropic/claude-haiku-4.5")).toBe("fast");
    expect(tierForSlug("openai/gpt-5-mini")).toBe("fast");
    expect(tierForSlug("google/gemini-3.5-flash")).toBe("fast");
    expect(tierForSlug("mistral/mistral-7b")).toBe("fast");
  });

  it("classifies frontier families as precise across vendors", () => {
    expect(tierForSlug("anthropic/claude-opus-4.8")).toBe("precise");
    expect(tierForSlug("anthropic/claude-fable-5")).toBe("precise");
    expect(tierForSlug("anthropic/claude-mythos-1")).toBe("precise");
    expect(tierForSlug("openai/gpt-5.2")).toBe("precise");
    expect(tierForSlug("deepseek/deepseek-r1")).toBe("precise");
  });

  it("falls back to balanced for anything unrecognised, slug or bare name", () => {
    expect(tierForSlug("anthropic/claude-sonnet-5")).toBe("balanced");
    expect(tierForSlug("some-unknown-model")).toBe("balanced");
  });
});

// ── Market decision ──────────────────────────────────────────────────────────

describe("decideMarketRoute", () => {
  const signals = { text: "fix the oauth login session bug" };

  it("clears the cheapest model that beats the bar", () => {
    const d = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [
        stat({ model: "cheap-but-bad", verifiedRate: 0.6, avgCostUsdMicros: 100 }),
        stat({ model: "mid", verifiedRate: 0.97, avgCostUsdMicros: 3000 }),
        stat({ model: "cheap-and-good", verifiedRate: 0.96, avgCostUsdMicros: 800 }),
      ],
    });
    expect(d.source).toBe("market");
    expect(d.model).toBe("cheap-and-good");
    expect(d.rationale).toMatch(/95% verified/);
    // Candidates are always the full audit trail, cheapest-first.
    expect(d.candidates.map((c) => c.model)).toEqual([
      "cheap-but-bad",
      "cheap-and-good",
      "mid",
    ]);
    expect(d.candidates.find((c) => c.model === "cheap-but-bad")?.eligible).toBe(
      false,
    );
    expect(d.policySnapshot).toEqual(ENFORCING);
  });

  it("breaks a cost tie on verified rate, then on latency", () => {
    const byRate = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [
        stat({ model: "a", verifiedRate: 0.96, avgCostUsdMicros: 500 }),
        stat({ model: "b", verifiedRate: 0.99, avgCostUsdMicros: 500 }),
      ],
    });
    expect(byRate.model).toBe("b");

    const byLatency = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [
        stat({ model: "slow", avgCostUsdMicros: 500, avgLatencyMs: 9000 }),
        stat({ model: "quick", avgCostUsdMicros: 500, avgLatencyMs: 100 }),
      ],
    });
    expect(byLatency.model).toBe("quick");
  });

  it("explains ineligibility distinctly for too-few samples vs a missed bar", () => {
    const d = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [
        stat({ model: "unproven", samples: 3, avgCostUsdMicros: 100 }),
        stat({ model: "unreliable", verifiedRate: 0.5, avgCostUsdMicros: 200 }),
      ],
    });
    expect(d.candidates[0]?.reason).toMatch(/insufficient samples \(3 < 20/);
    expect(d.candidates[1]?.reason).toMatch(/verified 50\.0% < 95% bar/);
  });

  it("falls back to the deterministic classifier when nothing clears the bar", () => {
    const d = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [stat({ model: "unreliable", verifiedRate: 0.4 })],
    });
    expect(d.source).toBe("deterministic-fallback");
    // auth is a precise-only domain.
    expect(d.tier).toBe("precise");
    expect(d.rationale).toMatch(/no model cleared the verified-success bar/);
    // The audit trail survives the fallback.
    expect(d.candidates).toHaveLength(1);
  });

  it("ignores stats rows belonging to another task class", () => {
    const d = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [stat({ taskClass: "billing/single", model: "elsewhere" })],
    });
    expect(d.candidates).toEqual([]);
    expect(d.source).toBe("deterministic-fallback");
  });

  it("lets a manual pin bypass the market but still returns the audit trail", () => {
    const d = decideMarketRoute({
      signals,
      taskClass: "auth/single",
      policy: ENFORCING,
      stats: [stat({ model: "would-have-won" })],
      override: "openai/gpt-5.2",
    });
    expect(d.model).toBe("openai/gpt-5.2");
    expect(d.tier).toBe("precise");
    expect(d.source).toBe("deterministic-fallback");
    expect(d.rationale).toMatch(/pinned model/);
    expect(d.candidates).toHaveLength(1);
  });
});

// ── Pareto summary ───────────────────────────────────────────────────────────

describe("summarizeRoutingStats", () => {
  it("reports the cheapest eligible model per class with candidate counts", () => {
    const summary = summarizeRoutingStats(
      [
        stat({ taskClass: "auth/single", model: "haiku", verifiedRate: 0.6 }),
        stat({
          taskClass: "auth/single",
          model: "sonnet",
          verifiedRate: 0.97,
          avgCostUsdMicros: 3000,
        }),
        stat({
          taskClass: "auth/single",
          model: "cheap",
          verifiedRate: 0.99,
          avgCostUsdMicros: 900,
        }),
      ],
      ENFORCING,
    );
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      taskClass: "auth/single",
      cheapestEligibleModel: "cheap",
      verifiedRate: 0.99,
      avgCostUsdMicros: 900,
      candidateCount: 3,
      eligibleCount: 2,
    });
  });

  it("nulls the winner fields when no model clears the bar", () => {
    const summary = summarizeRoutingStats(
      [stat({ taskClass: "billing/single", verifiedRate: 0.1 })],
      ENFORCING,
    );
    expect(summary[0]).toMatchObject({
      cheapestEligibleModel: null,
      verifiedRate: null,
      avgCostUsdMicros: null,
      eligibleCount: 0,
    });
  });

  it("returns one row per class, ordered by class for a stable render", () => {
    const summary = summarizeRoutingStats(
      [
        stat({ taskClass: "security/wide" }),
        stat({ taskClass: "auth/single" }),
        stat({ taskClass: "billing/small" }),
      ],
      ENFORCING,
    );
    expect(summary.map((s) => s.taskClass)).toEqual([
      "auth/single",
      "billing/small",
      "security/wide",
    ]);
  });

  it("returns nothing for an empty snapshot", () => {
    expect(summarizeRoutingStats([], ENFORCING)).toEqual([]);
  });

  it("agrees with decideMarketRoute on eligibility", () => {
    const stats = [
      stat({ taskClass: "auth/single", model: "a", verifiedRate: 0.96 }),
      stat({
        taskClass: "auth/single",
        model: "b",
        verifiedRate: 0.99,
        avgCostUsdMicros: 200,
      }),
    ];
    const decided = decideMarketRoute({
      signals: { text: "oauth" },
      taskClass: "auth/single",
      policy: ENFORCING,
      stats,
    });
    const summarized = summarizeRoutingStats(stats, ENFORCING)[0];
    expect(summarized?.cheapestEligibleModel).toBe(decided.model);
  });
});
