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

// Import after mocks.
const { syncSubscriptionFromStripe } = await import("./subscriptions");

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
