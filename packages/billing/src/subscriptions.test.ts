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
const previewPlanChangeMock = vi.fn().mockResolvedValue({
  amountCents: 0,
  isCharge: false,
  currency: "usd",
  prorationDate: 1_700_000_000,
});

vi.mock("./client", () => ({
  billingProvider: () => ({
    getSubscription: getSubscriptionMock,
    previewPlanChange: previewPlanChangeMock,
    updateSubscription: vi.fn().mockResolvedValue(undefined),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    upgradeSubscription: vi.fn().mockResolvedValue(undefined),
    // previewPlanChange's card lookup (resolveDefaultCard) hits these when a
    // customer id resolves cleanly. Default to "no card on file".
    getDefaultPaymentMethodId: vi.fn().mockResolvedValue(null),
    listPaymentMethods: vi.fn().mockResolvedValue([]),
  }),
}));

// ---------------------------------------------------------------------------
// Logger mock — assert the plan-change preview card-lookup failure is logged
// (an over-broad silent catch previously hid Stripe outages behind "no card").
// ---------------------------------------------------------------------------

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./logger", () => ({ logger: loggerMock }));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

/**
 * Every `set(...)` payload written to billing.subscriptions, in order. The
 * plan-upgrade intent (`pendingUpgradeFromPlanId`) is recorded as a write
 * before the provider swap, so a mock without `update` makes `changeOrgPlan`
 * throw rather than exercise the path under test.
 */
const subscriptionUpdates: Array<Record<string, unknown>> = [];

const dbMocks = {
  query: {
    plans: { findFirst: vi.fn() },
    subscriptions: { findFirst: vi.fn() },
  },
  insert: vi.fn(),
  update: vi.fn(() => ({
    set: (values: Record<string, unknown>) => {
      subscriptionUpdates.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    },
  })),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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

// ---------------------------------------------------------------------------
// Customers mock — resolveCustomerId dynamically imports ./customers when the
// org has no subscription row with a stripeCustomerId.
// ---------------------------------------------------------------------------

vi.mock("./customers", () => ({
  ensureStripeCustomer: vi
    .fn()
    .mockRejectedValue(new Error("no customer in test")),
}));

// ---------------------------------------------------------------------------
// Seats mock — previewPlanChange / changeOrgPlan may call this. `./entitlements`
// is deliberately NOT mocked: since #3157 the proration decision is a price
// comparison and this module no longer reads the entitlement tier ordering.
// ---------------------------------------------------------------------------

vi.mock("./seats", () => ({
  getOrgSeatUsage: vi.fn().mockResolvedValue({ licenses: 5, used: 1 }),
  SeatLimitError: class SeatLimitError extends Error {
    code = "seat_limit_reached" as const;
    readonly licenses: number;
    readonly used: number;
    constructor(licenses = 5, used = 1) {
      super("Seat limit reached");
      this.licenses = licenses;
      this.used = used;
    }
  },
  isSeatLimitError: (e: unknown) =>
    e instanceof Error &&
    (e as { code?: string }).code === "seat_limit_reached",
}));

// Import after mocks.
const {
  syncSubscriptionFromStripe,
  changeOrgPlan,
  reactivateOrgSubscription,
  previewPlanChange,
} = await import("./subscriptions");

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
    // WHICH price it sits on. An identity, not an amount (#3157).
    priceId: "price_test",
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
    getSubscriptionMock.mockResolvedValue(makeSubscription({ metadata: {} }));

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
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      status: "active",
    });

    await syncSubscriptionFromStripe("sub_test_001");

    expect(emitSecurityEventMock).toHaveBeenCalledOnce();
    const [event] = emitSecurityEventMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
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
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      status: "canceled",
    });

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
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("active subscription + downgrade → swaps price in place and emits billing.plan_changed", async () => {
    // Shared plans.findFirst superset row: covers targetPlan (slug lookup),
    // currentPlanRow (tier), and the inner syncSubscriptionFromStripe (product id).
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-free-1",
      slug: "free",
      // Target price equals the current one here (the same row answers both
      // lookups), so the bill does not move → proration 'none', grants skipped.
      tier: "free",
      stripePriceIdMonthly: "price_free_month",
      stripePriceIdAnnual: "price_free_year",
      monthlyCents: 0,
      annualCents: 0,
    });
    // Shared subscriptions.findFirst: covers activeSubRow (changeOrgPlan) and the
    // prior-status read inside syncSubscriptionFromStripe.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      seatCount: 1,
      planId: "plan-scale-1",
      billingInterval: "month",
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
      (c) =>
        (c[0] as Record<string, unknown>).eventType === "billing.plan_changed",
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
      slug: "build-v2",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year",
      monthlyCents: 19_900,
      annualCents: 199_000,
    });
    // …but there is no active subscription → Checkout branch.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await changeOrgPlan("org-abc-123", "build", "month", {
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    });

    expect(result).toEqual({ checkoutUrl: "https://checkout.example/session" });
    const planChangedCall = emitSecurityEventMock.mock.calls.find(
      (c) =>
        (c[0] as Record<string, unknown>).eventType === "billing.plan_changed",
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
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
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
      (c) =>
        (c[0] as Record<string, unknown>).eventType ===
        "billing.subscription_reactivated",
    );
    expect(reactivatedCall).toBeDefined();
    const event = reactivatedCall![0] as Record<string, unknown>;
    expect(event.orgId).toBe("org-abc-123");
    expect(event.outcome).toBe("success");
    expect(event.actorUserId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// previewPlanChange — annualCents null guard (OXA-silent-fix)
// ---------------------------------------------------------------------------

describe("previewPlanChange — annual price misconfiguration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("throws when annualCents is null for an annual-interval plan (bad-fallback fix)", async () => {
    // Verifies fix for subscriptions.ts:631-634 where `annualCents ?? monthlyCents`
    // previously fell back to the monthly price (e.g. $20 instead of $200) when
    // annualCents was null, giving the customer a 10× under-quote while Stripe
    // charged the full annual amount.
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-build-1",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year", // annual price ID exists…
      monthlyCents: 2000,
      annualCents: null, // …but annualCents is not configured
    });
    // No active subscription → triggers the checkout preview path that uses fullPriceCents.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    await expect(
      previewPlanChange("org-abc-123", "build", "year"),
    ).rejects.toThrow(/annualCents/);
  });

  it("does not throw when annualCents is properly configured", async () => {
    // Happy path: annualCents is set — the preview should compute the correct amount
    // and return requiresCheckout: true with the annual price.
    // (customers mock rejects so the no-active-sub path's card lookup is caught silently)
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-build-1",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year",
      monthlyCents: 2000,
      annualCents: 24000,
    });
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await previewPlanChange("org-abc-123", "build", "year");

    expect(result.requiresCheckout).toBe(true);
    expect(result.amountCents).toBe(24000);
    expect(result.interval).toBe("year");
  });

  it("does not throw for monthly interval even when annualCents is null", async () => {
    // The guard must only fire for interval=year; monthly plans legitimately
    // have annualCents=null and must not be affected.
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-free-1",
      tier: "free",
      stripePriceIdMonthly: "price_free_month",
      stripePriceIdAnnual: null,
      monthlyCents: 0,
      annualCents: null,
    });
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await previewPlanChange("org-abc-123", "free", "month");

    // monthlyCents = 0, stripePriceIdMonthly = "price_free_month" → valid.
    // No throw because interval !== "year".
    expect(result.requiresCheckout).toBe(true);
    expect(result.amountCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// previewPlanChange — proration direction on an ACTIVE subscription (#3157)
//
// The preview is the number the customer sees before confirming, so it has to
// reach the same proration flag changeOrgPlan will apply. Both read the price.
// ---------------------------------------------------------------------------

describe("previewPlanChange — the quote and the change agree (#3157)", () => {
  const TARGET = {
    id: "plan-mid-1",
    slug: "mid-v2",
    tier: "scale",
    stripePriceIdMonthly: "price_mid_150",
    stripePriceIdAnnual: null,
    monthlyCents: 15_000,
    annualCents: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The interval this change moves FROM is read from the provider, not from
    // the synced column (#3157, PR #3171 review), so each of these has to say
    // what the provider reports. Monthly unless the test says otherwise.
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ billingInterval: "month" }),
    );
  });

  it("quotes the previewed charge when the bill rises, under the flag the change will apply", async () => {
    previewPlanChangeMock.mockResolvedValue({
      amountCents: 5_000,
      isCharge: true,
      currency: "usd",
      prorationDate: 1_700_000_000,
      totalCents: 0,
      amountDueCents: 0,
      billingInterval: "month",
      lines: [],
    });
    dbMocks.query.plans.findFirst.mockResolvedValueOnce(TARGET);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      stripeCustomerId: "cus_test_001",
      planId: "plan-legacy-1",
      billingInterval: "month",
      stripePriceId: "price_list_200",
    });

    const result = await previewPlanChange("org-abc-123", "mid-v2", "month");

    expect(previewPlanChangeMock).toHaveBeenCalledWith(
      "sub_test_001",
      expect.objectContaining({ prorationBehavior: "create_prorations" }),
    );
    expect(result.amountCents).toBe(5_000);
    expect(result.isCharge).toBe(true);
  });

  it("quotes zero when the bill falls, because the change writes no proration line", async () => {
    // The previewed credit is real, and `none` means it is never raised. A
    // quote of -$499 would promise the customer money the swap will not move.
    previewPlanChangeMock.mockResolvedValue({
      amountCents: -49_900,
      isCharge: false,
      currency: "usd",
      prorationDate: 1_700_000_000,
      totalCents: 0,
      amountDueCents: 0,
      billingInterval: "month",
      lines: [],
    });
    dbMocks.query.plans.findFirst.mockResolvedValueOnce(TARGET);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      stripeCustomerId: "cus_test_001",
      planId: "plan-scale-1",
      billingInterval: "month",
      stripePriceId: "price_scale_m",
    });

    const result = await previewPlanChange("org-abc-123", "mid-v2", "month");

    expect(result.amountCents).toBe(0);
    expect(result.isCharge).toBe(false);
  });

  it("an unavailable preview produces no quote at all, rather than a quote of zero", async () => {
    // The discriminating case: NOT "the quote is zero when the preview fails",
    // which is the defect written down as an expectation. A caller must be
    // unable to read a number here, because `always_invoice` will go on to
    // charge the true difference and a $0 confirmation promises otherwise.
    previewPlanChangeMock.mockRejectedValue(new Error("stripe unavailable"));
    dbMocks.query.plans.findFirst.mockResolvedValueOnce(TARGET);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      stripeCustomerId: "cus_test_001",
      planId: "plan-legacy-1",
      billingInterval: "month",
      stripePriceId: "price_list_200",
    });

    await expect(
      previewPlanChange("org-abc-123", "mid-v2", "month"),
    ).rejects.toMatchObject({ code: "PLAN_CHANGE_PREVIEW_UNAVAILABLE" });
  });

  it("annual → monthly quotes the anchor-reset invoice, not zero", async () => {
    // Changing the recurring interval resets the billing-cycle anchor and
    // invoices the new period immediately. The proration nets NEGATIVE (credit
    // for unused annual time), so treating it as a downgrade quoted $0 while a
    // full month was charged. The money owed is the invoice total.
    previewPlanChangeMock.mockResolvedValue({
      amountCents: -80_000, // credit for the unused year
      isCharge: false,
      currency: "usd",
      prorationDate: 1_700_000_000,
      totalCents: 15_000, // the month the anchor reset raises
      // No account balance here, so the collection equals the invoice. The
      // case where they differ is `plan-change-provider-interval.test.ts`.
      amountDueCents: 15_000,
      // The subscription this preview priced is the ANNUAL one. It is the
      // preview that says so, not a second read of the subscription — see
      // BillingProrationPreview.billingInterval.
      billingInterval: "year",
      lines: [],
    });
    getSubscriptionMock.mockResolvedValue(
      makeSubscription({ billingInterval: "year", priceId: "price_annual" }),
    );
    dbMocks.query.plans.findFirst.mockResolvedValueOnce(TARGET);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      stripeCustomerId: "cus_test_001",
      planId: "plan-annual-1",
      billingInterval: "year", // moving to a monthly price
      stripePriceId: "price_annual",
    });

    const result = await previewPlanChange("org-abc-123", "mid-v2", "month");

    expect(result.amountCents).toBe(15_000);
    expect(result.isCharge).toBe(true);
  });

  it("a discounted subscriber is quoted the discounted proration", async () => {
    // Same P1 case as the swap path: the list prices read as a decrease, the
    // invoice is +$50, and the quote has to be the invoice.
    previewPlanChangeMock.mockResolvedValue({
      amountCents: 5_000,
      isCharge: true,
      currency: "usd",
      prorationDate: 1_700_000_000,
      totalCents: 0,
      amountDueCents: 0,
      billingInterval: "month",
      lines: [],
    });
    dbMocks.query.plans.findFirst.mockResolvedValueOnce(TARGET);
    dbMocks.query.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_test_001",
      stripeCustomerId: "cus_test_001",
      planId: "plan-list200-1",
      billingInterval: "month",
      stripePriceId: "price_list_200",
    });

    const result = await previewPlanChange("org-abc-123", "mid-v2", "month");

    expect(result.amountCents).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// previewPlanChange — card-lookup error visibility (silent-catch fix)
//
// The no-active-subscription branch previously swallowed every error from the
// customer/card lookup behind `card = null`, so a Stripe auth/outage/rate-limit
// failure was indistinguishable from "no card on file". These tests pin that
// the failure is now logged while the happy no-card path stays silent.
// ---------------------------------------------------------------------------

describe("previewPlanChange — card lookup error visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a warning when the customer/card lookup throws, still returns the no-card checkout preview", async () => {
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-build-1",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year",
      monthlyCents: 2000,
      annualCents: 24000,
    });
    // activeSub lookup → no active sub → checkout branch. resolveCustomerId's
    // own subscription lookup also returns undefined → ensureStripeCustomer
    // (mocked to reject) throws → the preview's card-lookup catch fires.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await previewPlanChange("org-abc-123", "build", "year");

    // Fallback preserved: preview still renders with no card.
    expect(result.requiresCheckout).toBe(true);
    expect(result.card).toBeNull();
    // But the failure is now observable.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-abc-123" }),
      expect.stringContaining("plan-change preview card lookup failed"),
    );
  });

  it("stays silent (no card-lookup warning) when the card resolves cleanly for a customer on file", async () => {
    dbMocks.query.plans.findFirst.mockResolvedValue({
      id: "plan-build-1",
      tier: "build",
      stripePriceIdMonthly: "price_build_month",
      stripePriceIdAnnual: "price_build_year",
      monthlyCents: 2000,
      annualCents: 24000,
    });
    // 1st findFirst (activeSub) → no active sub → checkout branch.
    // 2nd findFirst (inside resolveCustomerId) → a customer id on file, so
    // resolveCustomerId succeeds and resolveDefaultCard returns null cleanly.
    dbMocks.query.subscriptions.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ stripeCustomerId: "cus_on_file" });

    const result = await previewPlanChange("org-abc-123", "build", "year");

    expect(result.requiresCheckout).toBe(true);
    expect(result.card).toBeNull();
    const cardWarn = loggerMock.warn.mock.calls.find(
      (c) =>
        typeof c[1] === "string" &&
        c[1].includes("plan-change preview card lookup failed"),
    );
    expect(cardWarn).toBeUndefined();
  });
});
