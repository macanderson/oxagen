/**
 * plan-label.test.ts — unit tests for planTierLabel and planLabelFrom.
 *
 * Tests:
 *   1. All 4 valid tiers return distinct non-empty labels
 *   2. null/undefined/unknown → "Free"
 *   3. planLabelFrom: subscription overrides legacyPlanType
 *   4. planLabelFrom: both invalid → "Free"
 *   5. CONFIG-DERIVED: Object.keys(TIER_LABELS) set-equals VALID_TIERS (no drift)
 *
 * The valid-tier set is imported from the source module (TIER_LABELS /
 * VALID_TIERS) rather than hard-coded here, so adding or renaming a tier in
 * source automatically flows through every test below — there is no second copy
 * to keep in sync.
 */

import { describe, it, expect } from "vitest";
import {
  planTierLabel,
  planLabelFrom,
  TIER_LABELS,
  VALID_TIERS,
} from "./plan-label";

// Iterable array derived from the source-of-truth set (Set has no .map/.length).
const TIERS = [...VALID_TIERS];

// ---------------------------------------------------------------------------
// 1. All 4 valid tiers
// ---------------------------------------------------------------------------

describe("planTierLabel — valid tiers", () => {
  it("returns a non-empty label for every valid tier", () => {
    for (const tier of TIERS) {
      const label = planTierLabel(tier);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("returns distinct labels for each tier", () => {
    const labels = TIERS.map(planTierLabel);
    const unique = new Set(labels);
    expect(unique.size).toBe(TIERS.length);
  });

  it("returns 'Free' for the free tier", () => {
    expect(planTierLabel("free")).toBe("Free");
  });

  it("returns 'Build' for the build tier", () => {
    expect(planTierLabel("build")).toBe("Build");
  });

  it("returns 'Scale' for the scale tier", () => {
    expect(planTierLabel("scale")).toBe("Scale");
  });

  it("returns 'Enterprise' for the enterprise tier", () => {
    expect(planTierLabel("enterprise")).toBe("Enterprise");
  });
});

// ---------------------------------------------------------------------------
// 2. null / undefined / unknown → "Free"
// ---------------------------------------------------------------------------

describe("planTierLabel — invalid/missing input", () => {
  it("returns 'Free' for null", () => {
    expect(planTierLabel(null)).toBe("Free");
  });

  it("returns 'Free' for undefined", () => {
    expect(planTierLabel(undefined)).toBe("Free");
  });

  it("returns 'Free' for an empty string", () => {
    expect(planTierLabel("")).toBe("Free");
  });

  it("returns 'Free' for an unknown tier string", () => {
    expect(planTierLabel("pro")).toBe("Free");
  });

  it("returns 'Free' for a near-valid but uppercase tier string", () => {
    // "Build" (capitalized) is NOT a valid tier — only lowercase "build" is.
    expect(planTierLabel("Build")).toBe("Free");
  });

  it("returns 'Free' for a numeric-looking string", () => {
    expect(planTierLabel("99")).toBe("Free");
  });
});

// ---------------------------------------------------------------------------
// 3. planLabelFrom: subscription overrides legacy
// ---------------------------------------------------------------------------

describe("planLabelFrom — subscription overrides legacy", () => {
  it("uses subscriptionTier when both are valid", () => {
    const result = planLabelFrom("scale", "build");
    expect(result).toBe(planTierLabel("scale"));
    expect(result).not.toBe(planTierLabel("build"));
  });

  it("uses subscriptionTier even when legacy is null", () => {
    expect(planLabelFrom("enterprise", null)).toBe("Enterprise");
  });

  it("uses subscriptionTier even when legacy is undefined", () => {
    expect(planLabelFrom("build", undefined)).toBe("Build");
  });

  it("falls back to legacyPlanType when subscriptionTier is null", () => {
    expect(planLabelFrom(null, "scale")).toBe("Scale");
  });

  it("falls back to legacyPlanType when subscriptionTier is undefined", () => {
    expect(planLabelFrom(undefined, "enterprise")).toBe("Enterprise");
  });

  it("falls back to legacyPlanType when subscriptionTier is unknown", () => {
    expect(planLabelFrom("legacy-pro", "build")).toBe("Build");
  });
});

// ---------------------------------------------------------------------------
// 4. planLabelFrom: both invalid → "Free"
// ---------------------------------------------------------------------------

describe("planLabelFrom — both invalid", () => {
  it("returns 'Free' when both args are null", () => {
    expect(planLabelFrom(null, null)).toBe("Free");
  });

  it("returns 'Free' when both args are undefined", () => {
    expect(planLabelFrom(undefined, undefined)).toBe("Free");
  });

  it("returns 'Free' when both are unknown strings", () => {
    expect(planLabelFrom("gold", "silver")).toBe("Free");
  });
});

// ---------------------------------------------------------------------------
// 5. CONFIG-DERIVED: TIER_LABELS covers exactly the VALID_TIERS set
//    We verify this by ensuring every tier in VALID_TIERS gets a non-Free
//    result (unless it is 'free') and that no tier outside the set does.
// ---------------------------------------------------------------------------

describe("CONFIG-DERIVED tier coverage", () => {
  it("TIER_LABELS keys set-equal VALID_TIERS (the two source constants never drift)", () => {
    // Both are exported from source; this is the authoritative no-drift check —
    // every label key must be a valid tier and vice-versa.
    expect(new Set(Object.keys(TIER_LABELS))).toEqual(new Set(TIERS));
  });

  it("every tier in VALID_TIERS is recognized by planTierLabel (no fallback drift)", () => {
    const recognized = TIERS.filter((t) => {
      // planTierLabel for a tier in VALID_TIERS must NOT return the generic
      // "Free" fallback, EXCEPT for "free" itself.
      if (t === "free") return planTierLabel(t) === "Free";
      return planTierLabel(t) !== "Free";
    });
    expect(recognized).toHaveLength(TIERS.length);
  });

  it("each valid tier maps to its TIER_LABELS entry", () => {
    // planTierLabel must agree with the source label table for every tier.
    for (const t of TIERS) {
      expect(planTierLabel(t)).toBe(TIER_LABELS[t]);
    }
  });

  it("no tier outside VALID_TIERS is recognized (label falls to 'Free')", () => {
    const outsiders = [
      "gold",
      "platinum",
      "pro",
      "starter",
      "ENTERPRISE",
      "Free",
    ];
    for (const t of outsiders) {
      // An "outsider" that happens to collide with a real tier string would be a
      // genuine tier — guard the fixture against that so the assertion stays valid.
      expect(VALID_TIERS.has(t as never)).toBe(false);
      expect(planTierLabel(t)).toBe("Free");
    }
  });
});
