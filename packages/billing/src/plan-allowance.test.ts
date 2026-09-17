/**
 * Unit tests for plan-allowance.ts — resolveOrgActionEntitlement and
 * publishedAllowanceForTier.
 *
 * Mocks the withSystemDb seam using the same shape as tier.test.ts
 * (resolveOrgActionEntitlement's query is the tier resolver's query plus one
 * extra selected column), so the two files' resolution logic cannot silently
 * drift apart without a test noticing. The extra column is
 * `billing.plans.included_gau_per_month` since WL-27; the annual figure the
 * rate card prints is twelve of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface TxState {
  subRows: { tier: string; includedGauPerMonth: number }[];
  orgRows: {
    planType: string | null;
    negotiatedActionsAnnual?: bigint | number | null;
  }[];
  dbCalls: number;
  /**
   * Stand in for a database behind migration `20260916120000`: the column is
   * absent, so `information_schema` does not list it and any select naming it
   * raises PostgreSQL 42703 — which is what production does when `deploy-node`
   * lands ahead of `db-migrate.yml`.
   */
  negotiatedColumnMissing: boolean;
  /** Column sets the org leg asked for, in order. */
  orgSelects: string[][];
  /** An error the org leg raises whatever columns were asked for. */
  orgError?: Error;
  /** Like `orgError`, but consumed by the first org read only. */
  orgErrorOnce?: Error;
  /** How many transactions `withSystemDb` has opened. */
  transactions: number;
  /** `information_schema` probes issued, across all transactions. */
  probes: number;
}

const txState: TxState = {
  subRows: [],
  orgRows: [],
  dbCalls: 0,
  negotiatedColumnMissing: false,
  orgSelects: [],
  transactions: 0,
  probes: 0,
};

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const undefinedColumn = () =>
  pgError(
    "42703",
    "column organizations.negotiated_actions_annual does not exist",
  );

/**
 * A transaction that behaves like PostgreSQL's after a failed statement.
 *
 * This is the whole point of the fixture. A mock that simply rejects one query
 * and answers the next models the error but NOT what the database does to the
 * transaction around it: after 42703 the transaction is aborted, and every
 * later statement on it raises 25P02 until the block ends. A catch-and-retry
 * fix passes the naive mock and fails in production, which is exactly what
 * happened here.
 *
 * So: any statement that throws marks this transaction aborted, and every
 * statement afterwards raises 25P02. Only a NEW transaction clears it.
 */
function makeTx() {
  txState.transactions += 1;
  let aborted = false;

  const run = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    if (aborted) {
      throw pgError(
        "25P02",
        "current transaction is aborted, commands ignored until end of transaction block",
      );
    }
    try {
      return await fn();
    } catch (err) {
      aborted = true;
      throw err;
    }
  };

  return {
    execute: vi.fn().mockImplementation(async () =>
      run(() => {
        txState.probes += 1;
        // `information_schema` lists the column only on a migrated database.
        return txState.negotiatedColumnMissing ? [] : [{ "?column?": 1 }];
      }),
    ),
    select: vi.fn().mockImplementation((columns: Record<string, unknown>) => {
      const names = Object.keys(columns ?? {});
      return {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockImplementation(async () => run(() => txState.subRows)),
            }),
          }),
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () =>
              run(() => {
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
            ),
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
  txState.transactions = 0;
  txState.probes = 0;
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
  });

  it("never issues the statement that would abort the transaction", async () => {
    // The case a catch-and-retry fix gets wrong. 42703 aborts the enclosing
    // transaction, so a retry inside it raises 25P02 and the call still fails;
    // the fixture models that, and this assertion is what a retry-based fix
    // cannot satisfy — it has to ask the column first in order to fail.
    txState.negotiatedColumnMissing = true;
    txState.orgRows = [{ planType: "enterprise" }];
    await resolveOrgActionEntitlement("org-1");
    for (const names of txState.orgSelects) {
      expect(names).not.toContain("negotiatedActionsAnnual");
    }
    // One transaction, so no fix that opens a second one is being credited here.
    expect(txState.transactions).toBe(1);
  });

  it("stops asking for the column once it has been told", async () => {
    txState.negotiatedColumnMissing = true;
    txState.orgRows = [{ planType: "enterprise" }];
    await resolveOrgActionEntitlement("org-1");
    txState.orgSelects = [];
    await resolveOrgActionEntitlement("org-2");
    // The accrual path runs after every governed action; a probe per call would
    // be the round trip this module exists to avoid.
    expect(txState.orgSelects).toEqual([["planType"]]);
    expect(txState.probes).toBe(1);
  });

  it("probes once for the process when the column is there", async () => {
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: 25_000_000n },
    ];
    for (let i = 0; i < 3; i += 1) {
      expect(await resolveOrgActionEntitlement("org-1")).toEqual({
        tier: "enterprise",
        includedActionsAnnual: 25_000_000,
      });
    }
    // A column that exists does not stop existing, so the yes is kept.
    expect(txState.probes).toBe(1);
  });

  it("re-probes after the negative TTL so a hand-applied migration takes effect", async () => {
    // Production migrations are applied by hand, so an instance that started
    // before the migration has to notice it without being recycled. Caching the
    // miss for the process meant it charged enterprise overage against the
    // fallback until it was restarted.
    vi.useFakeTimers();
    try {
      txState.negotiatedColumnMissing = true;
      txState.orgRows = [{ planType: "enterprise" }];
      expect(await resolveOrgActionEntitlement("org-1")).toEqual({
        tier: "enterprise",
        includedActionsAnnual: null,
      });
      expect(txState.probes).toBe(1);

      // Still inside the TTL: the miss is trusted, nothing is re-asked.
      vi.advanceTimersByTime(30_000);
      await resolveOrgActionEntitlement("org-1");
      expect(txState.probes).toBe(1);

      // The operator applies the migration, and the TTL lapses.
      vi.advanceTimersByTime(31_000);
      txState.negotiatedColumnMissing = false;
      txState.orgRows = [
        { planType: "enterprise", negotiatedActionsAnnual: 25_000_000n },
      ];
      expect(await resolveOrgActionEntitlement("org-1")).toEqual({
        tier: "enterprise",
        includedActionsAnnual: 25_000_000,
      });
      expect(txState.probes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("shows why catch-and-retry inside the transaction cannot work", async () => {
    // Not a test of the shipped code: a demonstration that the fixture models
    // the behaviour the previous fix fell foul of. A second statement on a
    // transaction whose first statement threw raises 25P02, so recovering
    // in-place is impossible however the error is caught.
    txState.negotiatedColumnMissing = true;
    txState.orgRows = [{ planType: "build" }];
    const { withSystemDb } = await import("@oxagen/database");
    const caught = await (
      withSystemDb as unknown as (
        fn: (
          tx: ReturnType<typeof makeTx>,
        ) => Promise<string | null | undefined>,
      ) => Promise<string | null | undefined>
    )(async (tx: ReturnType<typeof makeTx>) => {
      // Statement one names the missing column and raises 42703.
      await tx
        .select({ negotiatedActionsAnnual: 1 })
        .from({})
        .where({})
        .limit(1)
        .then(
          () => undefined,
          (e: Error & { code?: string }) => {
            expect(e.code).toBe("42703");
          },
        );
      // Statement two is the retry a catch-based fix would issue.
      return tx
        .select({ planType: 1 })
        .from({})
        .where({})
        .limit(1)
        .then(
          () => null,
          (e: Error & { code?: string }) => e.code,
        );
    });
    expect(caught).toBe("25P02");
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
    txState.subRows = [{ tier: "scale", includedGauPerMonth: 300_000 }];
    await resolveOrgActionEntitlement("org-1");
    expect(txState.dbCalls).toBe(1);
  });

  it("reports the plan row's monthly allowance as twelve of them (WL-27)", async () => {
    // billing.plans.included_actions_annual is gone; the annual figure the
    // rate card prints is the published monthly allowance times twelve, so a
    // plan change through Stripe moves both on the next read.
    txState.subRows = [{ tier: "build", includedGauPerMonth: 50_000 }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "build", includedActionsAnnual: 600_000 });
    expect(typeof result.includedActionsAnnual).toBe("number");
  });

  it("reports zero rather than the tier default for a plan row that includes nothing", async () => {
    // included_gau_per_month is NOT NULL and may be 0. Answering null here
    // would send resolveActionAllowance to the tier default and hand the org
    // an allowance its plan does not include.
    txState.subRows = [{ tier: "build", includedGauPerMonth: 0 }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "build", includedActionsAnnual: 0 });
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
    // The plan row states a monthly GAU allowance now; the annual figure the
    // resolver returns is that times twelve (ADR-055 section 2, WL-27).
    txState.subRows = [{ tier: "scale", includedGauPerMonth: 125_000 }];
    txState.orgRows = [
      { planType: "enterprise", negotiatedActionsAnnual: 99_000_000n },
    ];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({ tier: "scale", includedActionsAnnual: 1_500_000 });
  });

  it("falls through to free when the subscription's tier is unrecognised, rather than trusting it", async () => {
    txState.subRows = [
      { tier: "legacy_unknown_tier", includedGauPerMonth: 999 },
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
    txState.subRows = [{ tier: "enterprise", includedGauPerMonth: 1_000_000 }];
    const result = await resolveOrgActionEntitlement("org-1");
    expect(result).toEqual({
      tier: "enterprise",
      includedActionsAnnual: 12_000_000,
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
