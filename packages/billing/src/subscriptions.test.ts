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
import type { BillingSubscription } from "./provider";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const getSubscriptionMock = vi.fn();

vi.mock("./client", () => ({
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

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: () => dbMocks,
  withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),

  };
});

// ---------------------------------------------------------------------------
// Audit emit mock — syncSubscriptionFromStripe emits billing.subscription_canceled
// on a provider-initiated cancel transition (OXA-N1).
// ---------------------------------------------------------------------------

const emitSecurityEventMock = vi.fn();
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: emitSecurityEventMock,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn(() => vi.fn()),
}));

// ---------------------------------------------------------------------------
// Checkout mock — changeOrgPlan dynamically imports ./checkout when the org has
// no active subscription (the Checkout-redirect branch).
// ---------------------------------------------------------------------------

vi.mock("./checkout", () => ({
  createCheckoutSession: vi
    .fn()
    .mockResolvedValue({ url: "https://checkout.example/session" }),
}));

// Import after mocks.
const { syncSubscriptionFromStripe, changeOrgPlan, reactivateOrgSubscription } = await import(
  "./subscriptions"
);

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

  it("provider-initiated cancellation (active → canceled) → emits billing.subscription_canceled", async () => {
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_known", status: "canceled" }),
    );
    dbMocks.query.plans.findFirst.mockResolvedValue({ id: "plan-uuid-1" });
    // Prior row was still active before this sync.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({ status: "active" });

    await syncSubscriptionFromStripe("sub_test_001");

    expect(emitSecurityEventMock).toHaveBeenCalledOnce();
    const [event] = emitSecurityEventMock.mock.calls[0] as [Record<string, unknown>];
    expect(event.eventType).toBe("billing.subscription_canceled");
    expect(event.orgId).toBe("org-abc-123");
    expect(event.actorUserId).toBeNull(); // system / provider-confirmed
    expect(event.outcome).toBe("success");
  });

  it("repeated sync of an already-canceled subscription → does NOT re-emit", async () => {
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_known", status: "canceled" }),
    );
    dbMocks.query.plans.findFirst.mockResolvedValue({ id: "plan-uuid-1" });
    // Prior row was already canceled — no edge transition.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({ status: "canceled" });

    await syncSubscriptionFromStripe("sub_test_001");

    expect(emitSecurityEventMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// changeOrgPlan — emits billing.plan_changed on an in-place plan swap (OXA-1594)
// ---------------------------------------------------------------------------

describe("changeOrgPlan audit emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const upsertChain = { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    dbMocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue(upsertChain) });
  });

  it("active subscription + downgrade → swaps price in place and emits billing.plan_changed", async () => {
    // Shared plans.findFirst superset row: covers targetPlan (slug lookup),
    // currentPlanRow (tier), and the inner syncSubscriptionFromStripe (product id).
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-free-1",
      tier: "free", // target tier — lower than current "scale" → downgrade (skips grants)
      stripePriceIdMonthly: "price_free_month",
      stripePriceIdAnnual: "price_free_year",
    });
    // Shared subscriptions.findFirst: covers activeSubRow (changeOrgPlan) and the
    // prior-status read inside syncSubscriptionFromStripe.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      seatCount: 1,
      planId: "plan-scale-1",
      status: "active",
    });
    // syncSubscriptionFromStripe pulls the canonical record (active, known org).
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_known", status: "active" }),
    );

    const result = await changeOrgPlan("org-abc-123", "free", "month");

    // In-place swap returns null (no checkout redirect).
    expect(result).toBeNull();

    const planChangedCall = emitSecurityEventMock.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).eventType === "billing.plan_changed",
    );
    expect(planChangedCall).toBeDefined();
    const event = planChangedCall![0] as Record<string, unknown>;
    expect(event.orgId).toBe("org-abc-123");
    expect(event.outcome).toBe("success");
    expect(event.actorUserId).toBeNull();
  });

  it("no active subscription → returns a checkout URL and does NOT emit billing.plan_changed", async () => {
    // Target plan exists…
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-build-1",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year",
    });
    // …but there is no active subscription → Checkout branch.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await changeOrgPlan("org-abc-123", "build", "month", {
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    });

    expect(result).toEqual({ checkoutUrl: "https://checkout.example/session" });
    const planChangedCall = emitSecurityEventMock.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).eventType === "billing.plan_changed",
    );
    expect(planChangedCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reactivateOrgSubscription — emits billing.subscription_reactivated (OXA-1594)
// ---------------------------------------------------------------------------

describe("reactivateOrgSubscription audit emit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const upsertChain = { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    dbMocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue(upsertChain) });
  });

  it("undoing a scheduled cancellation emits billing.subscription_reactivated", async () => {
    // The cancellable subscription lookup + the inner sync's prior-status read.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      status: "active",
    });
    // syncSubscriptionFromStripe needs a resolvable plan + org metadata.
    dbMocks.query.plans.findFirst.mockResolvedValue({ id: "plan-uuid-1" });
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ productId: "prod_known", status: "active" }),
    );

    await reactivateOrgSubscription("org-abc-123");

    const reactivatedCall = emitSecurityEventMock.mock.calls.find(
      (c) => (c[0] as Record<string, unknown>).eventType === "billing.subscription_reactivated",
    );
    expect(reactivatedCall).toBeDefined();
    const event = reactivatedCall![0] as Record<string, unknown>;
    expect(event.orgId).toBe("org-abc-123");
    expect(event.outcome).toBe("success");
    expect(event.actorUserId).toBeNull();
  });
});
