/**
 * Tests for the pure market-router decision core.
 *
 * All pure — no I/O, no ClickHouse. The stats snapshot is supplied inline so
 * every branch (Pareto pick, threshold filter, min-samples filter, sparse
 * fallback, tie-breaks, override, escalation ceiling) is exercised
 * deterministically.
 */
import { describe, it, expect } from "vitest";
import {
  decideMarketRoute,
  escalateTier,
  deriveTaskClass,
  resolveEffectiveRoutingPolicy,
  normalizeRoutingPolicy,
  summarizeRoutingStats,
  ROUTING_POLICY_OFF,
  type MarketRoutingPolicy,
  type RoutingStatRow,
} from "./market-router";

const HAIKU = "anthropic/claude-haiku-4.5";
const SONNET = "anthropic/claude-sonnet-5";
const FABLE = "anthropic/claude-fable-5";

/** A default enforce policy: 95% bar, 20 samples. */
const ENFORCE: MarketRoutingPolicy = {
  mode: "enforce",
  successThreshold: 0.95,
  minSamples: 20,
  windowDays: 30,
  escalateOnRejection: true,
};

function row(
  partial: Partial<RoutingStatRow> & { model: string },
): RoutingStatRow {
  return {
    taskClass: "design/single",
    tier: "balanced",
    samples: 100,
    verifiedCount: 100,
    verifiedRate: 1,
    avgCostUsdMicros: 1000,
    avgLatencyMs: 1000,
    lastSeen: "2026-07-10T00:00:00Z",
    ...partial,
  };
}

describe("decideMarketRoute", () => {
  it("picks the cheapest eligible model (Pareto floor)", () => {
    const stats = [
      row({
        model: FABLE,
        avgCostUsdMicros: 9000,
        verifiedRate: 1,
        samples: 100,
      }),
      row({
        model: SONNET,
        avgCostUsdMicros: 3000,
        verifiedRate: 0.97,
        samples: 100,
      }),
      row({
        model: HAIKU,
        avgCostUsdMicros: 500,
        verifiedRate: 0.96,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.source).toBe("market");
    expect(d.model).toBe(HAIKU); // cheapest of the three that all clear 95%
    expect(d.candidates).toHaveLength(3);
    // Candidates are cheapest-first.
    expect(d.candidates.map((c) => c.model)).toEqual([HAIKU, SONNET, FABLE]);
    expect(d.candidates.every((c) => c.eligible)).toBe(true);
  });

  it("excludes models below the success threshold", () => {
    const stats = [
      row({
        model: HAIKU,
        avgCostUsdMicros: 500,
        verifiedRate: 0.8,
        samples: 100,
      }),
      row({
        model: SONNET,
        avgCostUsdMicros: 3000,
        verifiedRate: 0.99,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.source).toBe("market");
    expect(d.model).toBe(SONNET); // Haiku is cheaper but fails the 95% bar
    const haiku = d.candidates.find((c) => c.model === HAIKU)!;
    expect(haiku.eligible).toBe(false);
    expect(haiku.reason).toContain("< 95% bar");
  });

  it("excludes models below the min-samples floor", () => {
    const stats = [
      row({ model: HAIKU, avgCostUsdMicros: 500, verifiedRate: 1, samples: 5 }),
      row({
        model: SONNET,
        avgCostUsdMicros: 3000,
        verifiedRate: 0.96,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.model).toBe(SONNET); // Haiku 5/5=100% but not enough samples
    const haiku = d.candidates.find((c) => c.model === HAIKU)!;
    expect(haiku.eligible).toBe(false);
    expect(haiku.reason).toContain("insufficient samples");
  });

  it("falls back to the deterministic router when no model clears the bar", () => {
    const stats = [
      row({ model: HAIKU, verifiedRate: 0.5, samples: 100 }),
      row({ model: SONNET, verifiedRate: 0.4, samples: 100 }),
    ];
    const d = decideMarketRoute({
      // Deterministic classifier will route a bare short design ask to balanced.
      signals: { text: "refactor the pricing module" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.source).toBe("deterministic-fallback");
    expect(d.rationale).toContain("no model cleared");
    // Candidates still returned as the audit trail.
    expect(d.candidates).toHaveLength(2);
  });

  it("falls back when there are no stats at all for the class (sparse cold start)", () => {
    const d = decideMarketRoute({
      signals: { text: "auth: fix the login session bug" },
      taskClass: "auth/single",
      stats: [],
      policy: ENFORCE,
    });
    expect(d.source).toBe("deterministic-fallback");
    expect(d.candidates).toHaveLength(0);
    // Deterministic router still returns a real model.
    expect(d.model).toBeTruthy();
    expect(d.tier).toBe("precise"); // auth is a precise-only domain
  });

  it("a manual override always wins and bypasses the market", () => {
    const stats = [row({ model: HAIKU, verifiedRate: 1, samples: 100 })];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
      override: FABLE,
    });
    expect(d.model).toBe(FABLE);
    expect(d.source).toBe("deterministic-fallback");
    expect(d.rationale).toContain("pinned model");
    // Audit trail still populated.
    expect(d.candidates).toHaveLength(1);
  });

  it("tie-breaks equal cost by higher verified rate", () => {
    const stats = [
      row({
        model: HAIKU,
        avgCostUsdMicros: 1000,
        verifiedRate: 0.96,
        samples: 100,
      }),
      row({
        model: SONNET,
        avgCostUsdMicros: 1000,
        verifiedRate: 0.99,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.model).toBe(SONNET); // same cost, higher verified rate wins
  });

  it("tie-breaks equal cost and rate by lower latency", () => {
    const stats = [
      row({
        model: HAIKU,
        avgCostUsdMicros: 1000,
        verifiedRate: 0.98,
        avgLatencyMs: 5000,
        samples: 100,
      }),
      row({
        model: SONNET,
        avgCostUsdMicros: 1000,
        verifiedRate: 0.98,
        avgLatencyMs: 800,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.model).toBe(SONNET); // same cost & rate, faster wins
  });

  it("only considers rows for the requested task class", () => {
    const stats = [
      row({
        model: HAIKU,
        taskClass: "trivial/single",
        verifiedRate: 1,
        samples: 100,
      }),
      row({
        model: SONNET,
        taskClass: "design/single",
        verifiedRate: 0.96,
        samples: 100,
      }),
    ];
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: ENFORCE,
    });
    expect(d.model).toBe(SONNET);
    expect(d.candidates).toHaveLength(1); // the trivial/single row is filtered out
  });

  it("respects a lowered threshold in the policy", () => {
    const stats = [
      row({
        model: HAIKU,
        verifiedRate: 0.9,
        samples: 100,
        avgCostUsdMicros: 500,
      }),
    ];
    const relaxed = { ...ENFORCE, successThreshold: 0.85 };
    const d = decideMarketRoute({
      signals: { text: "design something" },
      taskClass: "design/single",
      stats,
      policy: relaxed,
    });
    expect(d.source).toBe("market");
    expect(d.model).toBe(HAIKU);
    expect(d.policySnapshot.successThreshold).toBe(0.85);
  });
});

describe("summarizeRoutingStats", () => {
  it("reports the cheapest eligible model per class and null when none clears", () => {
    const stats = [
      row({
        model: HAIKU,
        taskClass: "auth/single",
        avgCostUsdMicros: 500,
        verifiedRate: 0.6,
        samples: 100,
      }),
      row({
        model: SONNET,
        taskClass: "auth/single",
        avgCostUsdMicros: 3000,
        verifiedRate: 0.97,
        samples: 100,
      }),
      row({
        model: FABLE,
        taskClass: "auth/single",
        avgCostUsdMicros: 9000,
        verifiedRate: 0.99,
        samples: 100,
      }),
      // A class where nothing clears the bar.
      row({
        model: HAIKU,
        taskClass: "trivial/single",
        avgCostUsdMicros: 300,
        verifiedRate: 0.5,
        samples: 100,
      }),
    ];
    const summary = summarizeRoutingStats(stats, ENFORCE);
    expect(summary).toHaveLength(2);
    const auth = summary.find((s) => s.taskClass === "auth/single")!;
    expect(auth.cheapestEligibleModel).toBe(SONNET); // cheapest of the two ≥95%
    expect(auth.candidateCount).toBe(3);
    expect(auth.eligibleCount).toBe(2);
    const trivial = summary.find((s) => s.taskClass === "trivial/single")!;
    expect(trivial.cheapestEligibleModel).toBeNull();
    expect(trivial.eligibleCount).toBe(0);
  });

  it("returns an empty array for empty stats", () => {
    expect(summarizeRoutingStats([], ENFORCE)).toEqual([]);
  });
});

describe("escalateTier", () => {
  it("steps fast → balanced → precise and caps at precise", () => {
    expect(escalateTier("fast")).toBe("balanced");
    expect(escalateTier("balanced")).toBe("precise");
    expect(escalateTier("precise")).toBe("precise");
  });
});

describe("deriveTaskClass", () => {
  it("classifies high-stakes domains by label", () => {
    expect(deriveTaskClass({ text: "fix the oauth login flow" })).toBe(
      "auth/single",
    );
    expect(deriveTaskClass({ text: "reconcile stripe invoice charges" })).toBe(
      "billing/single",
    );
    expect(
      deriveTaskClass({ text: "add an RLS policy for the tenant table" }),
    ).toBe("security/single");
  });

  it("classifies design vs trivial work when no domain matches", () => {
    expect(deriveTaskClass({ text: "debug the sorting logic" })).toBe(
      "design/single",
    );
    expect(
      deriveTaskClass({ text: "rename this variable and fix a typo" }),
    ).toBe("trivial/single");
    expect(deriveTaskClass({ text: "tell me the weather" })).toBe(
      "general/single",
    );
  });

  it("buckets breadth by file count and cross-package", () => {
    expect(deriveTaskClass({ text: "refactor", fileCount: 2 })).toBe(
      "design/small",
    );
    expect(deriveTaskClass({ text: "refactor", fileCount: 5 })).toBe(
      "design/multi",
    );
    expect(deriveTaskClass({ text: "refactor", fileCount: 12 })).toBe(
      "design/wide",
    );
    expect(deriveTaskClass({ text: "refactor", crossPackage: true })).toBe(
      "design/cross-package",
    );
  });

  it("is deterministic and stable for the same input", () => {
    const a = deriveTaskClass({
      text: "implement a new endpoint",
      fileCount: 3,
    });
    const b = deriveTaskClass({
      text: "implement a new endpoint",
      fileCount: 3,
    });
    expect(a).toBe(b);
  });
});

describe("resolveEffectiveRoutingPolicy", () => {
  it("defaults to OFF when nothing is configured", () => {
    const r = resolveEffectiveRoutingPolicy(null, null);
    expect(r.source).toBe("default");
    expect(r.policy).toEqual(ROUTING_POLICY_OFF);
  });

  it("uses org policy when only org is set", () => {
    const org = { ...ROUTING_POLICY_OFF, mode: "shadow" as const };
    const r = resolveEffectiveRoutingPolicy(org, null);
    expect(r.source).toBe("org");
    expect(r.policy.mode).toBe("shadow");
  });

  it("workspace policy overrides org (most-specific wins)", () => {
    const org = { ...ROUTING_POLICY_OFF, mode: "shadow" as const };
    const ws = { ...ROUTING_POLICY_OFF, mode: "enforce" as const };
    const r = resolveEffectiveRoutingPolicy(org, ws);
    expect(r.source).toBe("workspace");
    expect(r.policy.mode).toBe("enforce");
  });
});

describe("normalizeRoutingPolicy", () => {
  it("fills a partial policy with defaults", () => {
    const p = normalizeRoutingPolicy({ mode: "shadow" });
    expect(p.mode).toBe("shadow");
    expect(p.successThreshold).toBe(0.95);
    expect(p.minSamples).toBe(20);
    expect(p.windowDays).toBe(30);
    expect(p.escalateOnRejection).toBe(true);
  });

  it("returns OFF defaults for null/undefined", () => {
    expect(normalizeRoutingPolicy(null)).toEqual(ROUTING_POLICY_OFF);
    expect(normalizeRoutingPolicy(undefined)).toEqual(ROUTING_POLICY_OFF);
  });
});
