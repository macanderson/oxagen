/**
 * Unit tests for tier.ts — resolveOrgTier.
 *
 * Covers:
 *  1. Active subscription → returns the plan tier
 *  2. No subscription but org has legacy planType → returns planType
 *  3. No subscription, no planType → returns 'free'
 *  4. Subscription row has unrecognised tier → falls through to org planType
 *  5. Both subscription and planType present → subscription wins
 */
import { describe, it, expect, vi } from "vitest";

interface TxState {
  subRows: { tier: string }[];
  orgRows: { planType: string | null }[];
  /**
   * Times resolveOrgTier opened a database transaction. The mocked tx returns
   * empty rows, which resolve to 'free' by the normal path too — so asserting
   * only on the return value cannot tell "returned early" from "queried and
   * found nothing". Counting the trip to the database is what separates them.
   */
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

const { resolveOrgTier } = await import("./tier");

describe("resolveOrgTier", () => {
  beforeEach(() => {
    txState.subRows = [];
    txState.orgRows = [];
    txState.dbCalls = 0;
  });

  // `create_org` is user-scoped and runs before an org exists, so checkIAM
  // calls this with an empty orgId. Both columns it filters on are `uuid`, and
  // Postgres raises 22P02 rather than returning no rows — the IAM check then
  // catches, fails closed, and a brand-new account is told it may not create
  // its first organization.
  //
  // The assertion that matters is dbCalls: the mocked tx yields empty rows,
  // which reach 'free' by the ordinary path as well, so the return value alone
  // is true either way and proves nothing.
  it("resolves an absent org to 'free' without querying the database", async () => {
    expect(await resolveOrgTier("")).toBe("free");
    expect(txState.dbCalls).toBe(0);
  });

  it("still queries the database for a real org id", async () => {
    txState.subRows = [{ tier: "scale" }];
    expect(await resolveOrgTier("org-1")).toBe("scale");
    expect(txState.dbCalls).toBe(1);
  });

  it("returns the subscription plan tier when active subscription exists", async () => {
    txState.subRows = [{ tier: "scale" }];
    txState.orgRows = [{ planType: "free" }];
    expect(await resolveOrgTier("org-1")).toBe("scale");
  });

  it("falls back to org.planType when no active subscription", async () => {
    txState.subRows = [];
    txState.orgRows = [{ planType: "build" }];
    expect(await resolveOrgTier("org-1")).toBe("build");
  });

  it("returns 'free' when no subscription and no recognised planType", async () => {
    txState.subRows = [];
    txState.orgRows = [];
    expect(await resolveOrgTier("org-1")).toBe("free");
  });

  it("returns 'free' when subscription has unknown tier and org has no planType", async () => {
    txState.subRows = [{ tier: "legacy_unknown_tier" }];
    txState.orgRows = [{ planType: null }];
    expect(await resolveOrgTier("org-1")).toBe("free");
  });

  it("returns 'enterprise' for enterprise subscription tier", async () => {
    txState.subRows = [{ tier: "enterprise" }];
    txState.orgRows = [{ planType: "free" }];
    expect(await resolveOrgTier("org-1")).toBe("enterprise");
  });

  it("subscription wins over org planType when both are valid", async () => {
    txState.subRows = [{ tier: "build" }];
    txState.orgRows = [{ planType: "enterprise" }];
    expect(await resolveOrgTier("org-1")).toBe("build");
  });
});

// Needed for beforeEach to be available in the module scope (vi.mock hoisted above import)
import { beforeEach } from "vitest";
