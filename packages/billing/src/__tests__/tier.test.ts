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
}

const txState: TxState = {
  subRows: [],
  orgRows: [],
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

vi.mock("@oxagen/database", () => ({
  withTenantDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx()),
  schema: {
    plans: { tier: "plans.tier", id: "plans.id" },
    subscriptions: {
      planId: "subscriptions.planId",
      orgId: "subscriptions.orgId",
      status: "subscriptions.status",
    },
    organizations: {
      id: "organizations.id",
      planType: "organizations.planType",
    },
  },
}));

const { resolveOrgTier } = await import("../tier");

describe("resolveOrgTier", () => {
  beforeEach(() => {
    txState.subRows = [];
    txState.orgRows = [];
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
