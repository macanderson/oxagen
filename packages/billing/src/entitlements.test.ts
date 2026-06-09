/**
 * Unit tests for packages/billing/src/entitlements.ts.
 *
 * Pure logic — no DB, no Stripe. Covers the tier ordering, requireTier guard,
 * and each feature-specific predicate.
 */
import { describe, it, expect } from "vitest";
import {
  meetsMinimumTier,
  requireTier,
  TierDeniedError,
  isTierDenied,
  canAccessACL,
  canAccessSSO,
  canAccessSCIM,
  canAccessAuditLog,
  canBuyCredits,
} from "./entitlements";
import type { PlanTier } from "@oxagen/oxagen/types";

// ── meetsMinimumTier ──────────────────────────────────────────────────────────

describe("meetsMinimumTier", () => {
  it("same tier always meets minimum", () => {
    const tiers: PlanTier[] = ["free", "build", "scale", "enterprise"];
    for (const t of tiers) {
      expect(meetsMinimumTier(t, t)).toBe(true);
    }
  });

  it("higher tier meets a lower minimum", () => {
    expect(meetsMinimumTier("scale", "build")).toBe(true);
    expect(meetsMinimumTier("enterprise", "free")).toBe(true);
    expect(meetsMinimumTier("enterprise", "build")).toBe(true);
    expect(meetsMinimumTier("build", "free")).toBe(true);
  });

  it("lower tier does NOT meet a higher minimum", () => {
    expect(meetsMinimumTier("free", "build")).toBe(false);
    expect(meetsMinimumTier("free", "enterprise")).toBe(false);
    expect(meetsMinimumTier("build", "scale")).toBe(false);
    expect(meetsMinimumTier("scale", "enterprise")).toBe(false);
  });
});

// ── requireTier ───────────────────────────────────────────────────────────────

describe("requireTier", () => {
  it("returns void when tier meets minimum", () => {
    expect(() => requireTier("build", "build")).not.toThrow();
    expect(() => requireTier("enterprise", "build")).not.toThrow();
    expect(() => requireTier("scale", "free")).not.toThrow();
  });

  it("throws TierDeniedError when tier is below minimum", () => {
    expect(() => requireTier("free", "build")).toThrow(TierDeniedError);
    expect(() => requireTier("build", "enterprise")).toThrow(TierDeniedError);
    expect(() => requireTier("scale", "enterprise")).toThrow(TierDeniedError);
  });

  it("error carries actualTier and requiredTier fields", () => {
    let caught: unknown;
    try {
      requireTier("free", "scale", "fancy-feature");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TierDeniedError);
    const e = caught as TierDeniedError;
    expect(e.actualTier).toBe("free");
    expect(e.requiredTier).toBe("scale");
    expect(e.code).toBe("TIER_DENIED");
    expect(e.message).toMatch(/fancy-feature/);
  });

  it("error message includes both tiers", () => {
    let caught: unknown;
    try {
      requireTier("build", "enterprise");
    } catch (err) {
      caught = err;
    }
    const e = caught as TierDeniedError;
    expect(e.message).toMatch(/build/);
    expect(e.message).toMatch(/enterprise/);
  });
});

// ── isTierDenied ─────────────────────────────────────────────────────────────

describe("isTierDenied", () => {
  it("returns true for a TierDeniedError", () => {
    const err = new TierDeniedError("free", "build");
    expect(isTierDenied(err)).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isTierDenied(new Error("oops"))).toBe(false);
    expect(isTierDenied("string")).toBe(false);
    expect(isTierDenied(null)).toBe(false);
  });
});

// ── canAccessACL ─────────────────────────────────────────────────────────────

describe("canAccessACL", () => {
  it("only enterprise can access ACLs", () => {
    expect(canAccessACL("enterprise")).toBe(true);
    expect(canAccessACL("scale")).toBe(false);
    expect(canAccessACL("build")).toBe(false);
    expect(canAccessACL("free")).toBe(false);
  });
});

// ── canAccessSSO ─────────────────────────────────────────────────────────────

describe("canAccessSSO", () => {
  it("only enterprise can access SSO", () => {
    expect(canAccessSSO("enterprise")).toBe(true);
    expect(canAccessSSO("scale")).toBe(false);
    expect(canAccessSSO("build")).toBe(false);
    expect(canAccessSSO("free")).toBe(false);
  });
});

// ── canAccessSCIM ─────────────────────────────────────────────────────────────

describe("canAccessSCIM", () => {
  it("only enterprise can access SCIM", () => {
    expect(canAccessSCIM("enterprise")).toBe(true);
    expect(canAccessSCIM("scale")).toBe(false);
    expect(canAccessSCIM("build")).toBe(false);
    expect(canAccessSCIM("free")).toBe(false);
  });
});

// ── canAccessAuditLog ─────────────────────────────────────────────────────────

describe("canAccessAuditLog", () => {
  it("only enterprise can access the immutable audit log", () => {
    expect(canAccessAuditLog("enterprise")).toBe(true);
    expect(canAccessAuditLog("scale")).toBe(false);
    expect(canAccessAuditLog("build")).toBe(false);
    expect(canAccessAuditLog("free")).toBe(false);
  });
});

// ── canBuyCredits ─────────────────────────────────────────────────────────────

describe("canBuyCredits", () => {
  it("free orgs cannot buy credit packs", () => {
    expect(canBuyCredits("free")).toBe(false);
  });

  it("build, scale, enterprise orgs can buy credit packs", () => {
    expect(canBuyCredits("build")).toBe(true);
    expect(canBuyCredits("scale")).toBe(true);
    expect(canBuyCredits("enterprise")).toBe(true);
  });
});
