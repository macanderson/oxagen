/**
 * Unit tests for syncSubscriptionFromStripe
 * (packages/billing/src/subscriptions.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → stripeClient() (no live API)
 *
 * Scenarios:
 *  1. Subscription with unknown plan (resolvePlanId returns null) → function
 *     returns without inserting any row.
 *  2. Subscription with no org_id metadata → function returns early without
 *     touching the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Stripe client mock — must be registered before the module is imported.
// ---------------------------------------------------------------------------

const stripeMocks = {
  subscriptions: {
    retrieve: vi.fn(),
  },
};

vi.mock("../client.js", () => ({
  stripeClient: () => stripeMocks,
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
    },
  },
}));

// Import after mocks.
const { syncSubscriptionFromStripe } = await import("../subscriptions.js");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeStripeSubscription(
  overrides: {
    metadata?: Record<string, string>;
    productId?: string | null;
    status?: string;
  } = {},
): Stripe.Subscription {
  const productId = overrides.productId !== undefined ? overrides.productId : "prod_test";

  return {
    id: "sub_test_001",
    object: "subscription",
    status: overrides.status ?? "active",
    metadata: overrides.metadata ?? { org_id: "org-abc-123" },
    customer: "cus_test_001",
    current_period_start: Math.floor(Date.now() / 1000) - 86400,
    current_period_end: Math.floor(Date.now() / 1000) + 86400,
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    items: {
      object: "list",
      data: [
        {
          id: "si_test",
          object: "subscription_item",
          quantity: 1,
          price: {
            id: "price_test",
            object: "price",
            product: productId
              ? ({ id: productId, object: "product" } as Stripe.Product)
              : null,
            recurring: { interval: "month", interval_count: 1 } as Stripe.Price.Recurring,
          } as Stripe.Price,
        } as Stripe.SubscriptionItem,
      ],
      has_more: false,
      url: "/v1/subscription_items",
      total_count: 1,
    },
  } as unknown as Stripe.Subscription;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncSubscriptionFromStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: insert chain resolves silently.
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("unknown plan (no DB plan row) — returns without inserting a subscription row", async () => {
    const sub = makeStripeSubscription({ productId: "prod_unknown" });
    stripeMocks.subscriptions.retrieve.mockResolvedValue(sub);

    // No plan row exists for this product.
    dbMocks.query.plans.findFirst.mockResolvedValue(undefined);

    await syncSubscriptionFromStripe("sub_test_001");

    // insert() should not have been called — early bail-out.
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("no org_id metadata — returns without touching DB at all", async () => {
    // metadata is missing org_id → early return before plan resolution.
    const sub = makeStripeSubscription({ metadata: {} });
    stripeMocks.subscriptions.retrieve.mockResolvedValue(sub);

    await syncSubscriptionFromStripe("sub_test_001");

    expect(dbMocks.query.plans.findFirst).not.toHaveBeenCalled();
    expect(dbMocks.insert).not.toHaveBeenCalled();
  });

  it("known plan + org_id → upserts subscription row", async () => {
    const sub = makeStripeSubscription({ productId: "prod_known" });
    stripeMocks.subscriptions.retrieve.mockResolvedValue(sub);

    dbMocks.query.plans.findFirst.mockResolvedValue({ id: "plan-uuid-1" });

    await syncSubscriptionFromStripe("sub_test_001");

    expect(dbMocks.insert).toHaveBeenCalledOnce();
  });
});
