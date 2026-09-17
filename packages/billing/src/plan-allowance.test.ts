/**
 * Unit tests for plan-allowance.ts — resolveOrgActionEntitlement and
 * publishedAllowanceForTier.
 *
 * Mocks the withSystemDb seam using the same shape as tier.test.ts
 * (resolveOrgActionEntitlement's query is the tier resolver's query plus one
 * extra selected column), so the two files' resolution logic cannot silently
 * drift apart without a test noticing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface TxState {
  subRows: { tier: string; includedActionsAnnual: bigint | number | null }[];
  orgRows: {
    planType: string | null;
    negotiatedActionsAnnual?: bigint | number | null;
  }[];
  dbCalls: number;
}

const txState: TxState = {
  subRows: [],
  orgRows: [],
  dbCalls: 0,
};

function makeTx() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(txState.subRows),
          }),
        }),
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(txState.orgRows),
        }),
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) => {
      txState.dbCalls += 1;
      return fn(makeTx());
    },
    withTenantDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) => {
      txState.dbCalls += 1;
      return fn(makeTx());
    },
  };
});

const { resolveOrgActionEntitlement, publishedAllowanceForTier } = await import(
  "./plan-allowance"
);
const {
  TIER_ACTION_ALLOWANCES,
  resolveActionAllowance,
  ENTERPRISE_FALLBACK_ALLOWANCE,
} = await import("./action-metering");
const { ENTITLED_SUBSCRIPTION_STATUSES } = await import("./tier");

beforeEach(() => {
  txState.subRows = [];
  txState.orgRows = [];
  txState.dbCalls = 0;
});

// ---------------------------------------------------------------------------
// resolveOrgActionEntitlement
// ---------------------------------------------------------------------------

describe("resolveOrgActionEntitlement", () => {
  // Both `billing.subscriptions.org_id` and `org.organizations.id` are uuid
  // columns; Postgres cannot compare a uuid to "". An empty orgId must be
  // answered without querying, on the most restricted tier.
  it("returns free/null for an empty orgId WITHOUT querying the database", async () => {
    const result = await resolveOrgActionEntitlement("");
    expect(result).toEqual({ tier: "free", includedActionsAnnual: null });
    expect(txState.dbCalls).toBe(0);
  });

  it("still queries the database for a real org id", async () => {
    txState.subRows = [{ tier: "scale", includedActionsAnnual: null }];
    await resolveOrgActionEntitlement("org-1");
    expect(txState.dbCalls).toBe(1);
  });

  it("a stored subscription figure wins", async () => {
    txState.subRows = [{ tier: "build", includedActionsAnnual: 400_000 }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "build", includedActionsAnnual: 400_000 });
  });

  it("normalises the bigint-mode includedActionsAnnual column to a JS number", async () => {
    // billing.plans.included_actions_annual is a `bigint`-mode column — the
    // driver returns a JS bigint, not a number.
    txState.subRows = [{ tier: "scale", includedActionsAnnual: 1_500_000n }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result.includedActionsAnnual).toBe(1_500_000);
    expect(typeof result.includedActionsAnnual).toBe("number");
  });

  it("uses the tier default (null includedActionsAnnual) when the subscription carries none", async () => {
    txState.subRows = [{ tier: "build", includedActionsAnnual: null }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "build", includedActionsAnnual: null });
  });

  it("falls back to the legacy organizations.plan_type leg when no subscription answered", async () => {
    txState.subRows = [];
    txState.orgRows = [{ planType: "scale" }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "scale", includedActionsAnnual: null });
  });

  // ── The legacy leg's own allowance column ────────────────────────────────
  //
  // Before this column existed the legacy leg returned null unconditionally, so
  // an enterprise org that never went through Stripe checkout had no way at all
  // to record its commitment: resolveActionAllowance fell to the scale figure
  // and logged `billing_enterprise_allowance_missing` on EVERY governed action,
  // permanently, with nothing an operator could do about it.

  it("reads negotiated_actions_annual on the legacy leg", async () => {
    txState.subRows = [];
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: 25_000_000n },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({
      tier: "enterprise",
      includedActionsAnnual: 25_000_000,
    });
  });

  it("treats a null negotiated figure as 'use the tier default', never 'unlimited'", async () => {
    txState.subRows = [];
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: null },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "enterprise", includedActionsAnnual: null });
    // And the allowance resolver still refuses to read that as unlimited.
    expect(
      resolveActionAllowance("enterprise", result.includedActionsAnnual),
    ).toBe(ENTERPRISE_FALLBACK_ALLOWANCE);
  });

  it("accepts a recorded zero — a commitment of no included actions is a real one", async () => {
    txState.subRows = [];
    txState.orgRows = [{ planType: "enterprise", negotiatedActionsAnnual: 0n }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "enterprise", includedActionsAnnual: 0 });
  });

  it("lands on the tier default when the column is absent from the row", async () => {
    // A row shape missing the column (an older read path, a partial select)
    // must not become NaN in the figure the meter compares an action count to.
    txState.subRows = [];
    txState.orgRows = [{ planType: "enterprise" }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "enterprise", includedActionsAnnual: null });
  });

  it("rejects a corrupt negative figure rather than passing it to the meter", async () => {
    txState.subRows = [];
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: -5n },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "enterprise", includedActionsAnnual: null });
  });

  it("does not let the legacy allowance override a plan row a customer is paying for", async () => {
    txState.subRows = [{ tier: "scale", includedActionsAnnual: 1_500_000n }];
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: 99_000_000n },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "scale", includedActionsAnnual: 1_500_000 });
  });

  it("falls through to free when the subscription's tier is unrecognised, rather than trusting it", async () => {
    txState.subRows = [
      { tier: "legacy_unknown_tier", includedActionsAnnual: 999 },
    ];
    txState.orgRows = [{ planType: null }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "free", includedActionsAnnual: null });
  });

  it("falls through to free when neither a subscription nor an org row answers", async () => {
    txState.subRows = [];
    txState.orgRows = [];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "free", includedActionsAnnual: null });
  });

  it("falls through to free when org.plan_type is itself unrecognised", async () => {
    txState.subRows = [];
    txState.orgRows = [{ planType: "not_a_real_tier" }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "free", includedActionsAnnual: null });
  });

  // ── #1384 parity — the entitled-status list is SHARED, not restated ──────
  it("shares its entitled-status list with tier.ts's ENTITLED_SUBSCRIPTION_STATUSES", async () => {
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain("trialing");
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain("active");
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain("past_due");
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain("paused");
  });

  it("entitles a trialing enterprise subscription exactly like an active one (the #1384 fix)", async () => {
    // Before #1384, tier resolution counted only 'active'; a trialing
    // enterprise org would have resolved as if unentitled here too, and
    // because the tier gate switches IAM off below enterprise, the mismatch
    // would have switched a security control off for that org.
    txState.subRows = [
      { tier: "enterprise", includedActionsAnnual: 10_000_000 },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({
      tier: "enterprise",
      includedActionsAnnual: 10_000_000,
    });
  });
});

// ---------------------------------------------------------------------------
// publishedAllowanceForTier
// ---------------------------------------------------------------------------

describe("publishedAllowanceForTier", () => {
  it("returns the tier default for free/build/scale", () => {
    expect(publishedAllowanceForTier("free")).toBe(TIER_ACTION_ALLOWANCES.free);
    expect(publishedAllowanceForTier("build")).toBe(
      TIER_ACTION_ALLOWANCES.build,
    );
    expect(publishedAllowanceForTier("scale")).toBe(
      TIER_ACTION_ALLOWANCES.scale,
    );
  });

  it("returns null for enterprise — negotiated, with no DB read", () => {
    expect(publishedAllowanceForTier("enterprise")).toBeNull();
  });
});
