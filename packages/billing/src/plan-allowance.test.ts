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
  /**
   * Stand in for a database behind migration `20260916120000`: any select
   * naming `negotiated_actions_annual` raises PostgreSQL 42703, which is what
   * production does when `deploy-node` lands ahead of `db-migrate.yml`.
   */
  negotiatedColumnMissing: boolean;
  /** Column sets the org leg asked for, in order. */
  orgSelects: string[][];
  /** An error the org leg raises whatever columns were asked for. */
  orgError?: Error;
  /** Like `orgError`, but consumed by the first org read only. */
  orgErrorOnce?: Error;
}

const txState: TxState = {
  subRows: [],
  orgRows: [],
  dbCalls: 0,
  negotiatedColumnMissing: false,
  orgSelects: [],
};

function undefinedColumn(): Error & { code: string } {
  const err = new Error(
    'column organizations.negotiated_actions_annual does not exist',
  ) as Error & { code: string };
  err.code = "42703";
  return err;
}

function makeTx() {
  return {
    select: vi.fn().mockImplementation((columns: Record<string, unknown>) => {
      const names = Object.keys(columns ?? {});
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(txState.subRows),
            }),
          }),
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => {
              txState.orgSelects.push(names);
              if (txState.orgErrorOnce) {
                const once = txState.orgErrorOnce;
                txState.orgErrorOnce = undefined;
                throw once;
              }
              if (txState.orgError) throw txState.orgError;
              if (
                txState.negotiatedColumnMissing &&
                names.includes("negotiatedActionsAnnual")
              ) {
                throw undefinedColumn();
              }
              return txState.orgRows;
            }),
          }),
        }),
      };
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

const {
  resolveOrgActionEntitlement,
  publishedAllowanceForTier,
  resetNegotiatedColumnProbeForTests,
} = await import("./plan-allowance");
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
  txState.negotiatedColumnMissing = false;
  txState.orgSelects = [];
  txState.orgError = undefined;
  txState.orgErrorOnce = undefined;
  resetNegotiatedColumnProbeForTests();
});

describe("a database behind the allowance migration", () => {
  // Deployment and migration are separate manual steps (pipeline.yml: deploy-node
  // no longer waits for db-migrate.yml), so production can run this code before
  // 20260916120000 is applied. The unconditional column reference then raised
  // 42703 on every call, and because the kernel catches the recorder's error,
  // governed actions went uncounted and unbilled for the whole window.
  it("answers on the tier instead of failing the accrual", async () => {
    txState.negotiatedColumnMissing = true;
    txState.orgRows = [{ planType: "enterprise" }];
    expect(await resolveOrgActionEntitlement("org-1")).toEqual({
      tier: "enterprise",
      includedActionsAnnual: null,
    });
    // The first attempt names the column; the retry does not.
    expect(txState.orgSelects[0]).toContain("negotiatedActionsAnnual");
    expect(txState.orgSelects[1]).not.toContain("negotiatedActionsAnnual");
  });

  it("stops asking for the column once it has been told", async () => {
    txState.negotiatedColumnMissing = true;
    txState.orgRows = [{ planType: "enterprise" }];
    await resolveOrgActionEntitlement("org-1");
    txState.orgSelects = [];
    await resolveOrgActionEntitlement("org-2");
    // The accrual path runs after every governed action; a failed query per
    // call would be the round trip this module exists to avoid.
    expect(txState.orgSelects).toEqual([["planType"]]);
  });

  it("still propagates an error that is not a missing column", async () => {
    // A connection failure is not a schema fact, and swallowing it would turn
    // an outage into a silent free tier for every organisation.
    const boom = new Error("connection reset") as Error & { code: string };
    boom.code = "08006";
    txState.orgError = boom;
    await expect(resolveOrgActionEntitlement("org-1")).rejects.toThrow(
      "connection reset",
    );
    expect(txState.orgSelects).toHaveLength(1);
  });

  it("finds 42703 wrapped in a driver error's cause chain", async () => {
    // Drizzle wraps driver failures, so the code is rarely on the top error.
    const inner = new Error("undefined column") as Error & { code: string };
    inner.code = "42703";
    txState.orgErrorOnce = new Error("query failed", { cause: inner });
    txState.orgRows = [{ planType: "build" }];
    expect(await resolveOrgActionEntitlement("org-1")).toEqual({
      tier: "build",
      includedActionsAnnual: null,
    });
    expect(txState.orgSelects).toHaveLength(2);
  });
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
