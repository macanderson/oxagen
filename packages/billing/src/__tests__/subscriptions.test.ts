/**
 * Unit tests for syncSubscriptionFromStripe
 * (packages/billing/src/subscriptions.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider() (neutral BillingProvider interface)
 *
 * Scenarios:
 *  1. Subscription with unknown plan (resolvePlanId returns null) → function
 *     returns without inserting any row.
 *  2. Subscription with no org_id metadata → function returns early without
 *     touching the DB.
 *  3. Known plan + org_id → upserts subscription row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingSubscription } from "../provider";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const getSubscriptionMock = vi.fn();

vi.mock("../client", () => ({
  billingProvider: () => ({
    getSubscription: getSubscriptionMock,
    updateSubscription: vi.fn().mockResolvedValue(undefined),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    upgradeSubscription: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const dbMocks = {
  query: {
    plans: { findFirst: vi.fn() },
    subscriptions: { findFirst: vi.fn() },
  },
  insert: vi.fn(),
};

vi.mock("@oxagen/database", () => ({
  db: () => dbMocks,
  schema: {
    plans: { stripeProductId: "plans.stripeProductId" },
    subscriptions: {
      stripeSubscriptionId: "subscriptions.stripeSubscriptionId",
      orgId: "subscriptions.orgId",
      status: "subscriptions.status",
    },
  },
}));

// Import after mocks.
const { syncSubscriptionFromStripe } = await import("../subscriptions");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSubscription(
  overrides: Partial<BillingSubscription> = {},
): BillingSubscription {
  return {
    id: "sub_test_001",
    customerId: "cus_test_001",
    metadata: { org_id: "org-abc-123" },
    status: "active",
    billingInterval: "month",
    currentPeriodStart: new Date(Date.now() - 86400 * 1000),
    currentPeriodEnd: new Date(Date.now() + 86400 * 1000),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    trialEnd: null,
    productId: "prod_test",
    seatCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncSubscriptionFromStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("unknown plan (no DB plan row) — returns without inserting a subscription row", async () => {
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_unknown" }),
    );

    // No plan row exists for this product.
    dbMocks.query.plans.findFirst.mockResolvedValue(undefined);

    await syncSubscriptionFromStripe("sub_test_001");

    // insert() should not have been called — early bail-out.
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("no org_id metadata — returns without touching DB at all", async () => {
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ metadata: {} }),
    );

    await syncSubscriptionFromStripe("sub_test_001");

    expect(dbMocks.query.plans.findFirst).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("known plan + org_id → upserts subscription row", async () => {
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_known" }),
    );

    dbMocks.query.plans.findFirst.mockResolvedValue({ id: "plan-uuid-1" });

    await syncSubscriptionFromStripe("sub_test_001");

    expect(dbMocks.insert).toHaveBeenCalledOnce();
  });
});
