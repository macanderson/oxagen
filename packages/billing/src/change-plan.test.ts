/**
 * Unit tests for changeOrgPlan + createCheckoutSession guard
 * (packages/billing/src/subscriptions.ts + checkout.ts).
 *
 * Scenarios:
 *  1. changeOrgPlan — no active subscription (free) → returns checkout URL
 *  2. changeOrgPlan — active subscription, upgrade → swaps price (always_invoice)
 *  3. changeOrgPlan — active subscription, downgrade → swaps price (none)
 *  4. changeOrgPlan — unknown plan slug → throws
 *  5. createCheckoutSession — org has active sub → throws ActiveSubscriptionError
 *  6. createCheckoutSession — free org (no sub) → creates checkout
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── BillingProvider mock ─────────────────────────────────────────────────────

const upgradeSubscriptionMock = vi.fn().mockResolvedValue(undefined);
const getSubscriptionMock = vi.fn();
const createSubscriptionCheckoutMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    getSubscription: getSubscriptionMock,
    upgradeSubscription: upgradeSubscriptionMock,
    setSubscriptionSeats: vi.fn().mockResolvedValue(undefined),
    updateSubscription: vi.fn().mockResolvedValue(undefined),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
    createSubscriptionCheckout: createSubscriptionCheckoutMock,
    createPaymentCheckout: vi.fn(),
    getCheckoutSessionCreditPacks: vi.fn(),
    findCustomerByOrgId: vi.fn().mockResolvedValue(null),
    createCustomer: vi.fn().mockResolvedValue("cus_new"),
    getInvoice: vi.fn(),
    parseWebhookEvent: vi.fn(),
  }),
}));

// ── @oxagen/database mock ────────────────────────────────────────────────────

const dbQueryMocks = {
  plans: { findFirst: vi.fn() },
  subscriptions: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
};

const dbMocks = {
  query: dbQueryMocks,
  insert: vi.fn(),
  select: vi.fn(),
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

// ── drizzle-orm mock ─────────────────────────────────────────────────────────

// ── @oxagen/config/env mock ──────────────────────────────────────────────────

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

// Import AFTER mocks.
const { changeOrgPlan } = await import("./subscriptions");
const { createCheckoutSession, ActiveSubscriptionError } = await import(
  "./checkout"
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BUILD_PLAN = {
  id: "plan-build-id",
  tier: "build",
  stripePriceIdMonthly: "price_build_m",
  stripePriceIdAnnual: "price_build_y",
};
const SCALE_PLAN = {
  id: "plan-scale-id",
  tier: "scale",
  stripePriceIdMonthly: "price_scale_m",
  stripePriceIdAnnual: null,
};

function makeActiveSub(
  overrides: Partial<{
    stripeSubscriptionId: string;
    seatCount: number;
    planId: string;
    plan: { tier: string };
  }> = {},
) {
  return {
    stripeSubscriptionId: "sub_active_001",
    seatCount: 1,
    planId: "plan-build-id",
    plan: { tier: "build" },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("changeOrgPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // syncSubscriptionFromStripe uses billingProvider().getSubscription and db().insert
    getSubscriptionMock.mockResolvedValue({
      id: "sub_active_001",
      customerId: "cus_001",
      metadata: { org_id: "org-abc" },
      status: "active",
      billingInterval: "month",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      productId: "prod_build",
      seatCount: 1,
    });
    dbQueryMocks.plans.findFirst.mockImplementation(() => {
      // sync uses stripeProductId; changeOrgPlan uses slug
      return Promise.resolve(BUILD_PLAN);
    });
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("no active subscription → returns checkoutUrl", async () => {
    dbQueryMocks.plans.findFirst.mockResolvedValue(BUILD_PLAN);
    // No active sub.
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(null);
    dbQueryMocks.organizations.findFirst.mockResolvedValue({
      id: "org-abc",
      name: "Acme",
      slug: "acme",
    });
    createSubscriptionCheckoutMock.mockResolvedValue({
      sessionId: "sess_001",
      url: "https://checkout.test/1",
    });

    const result = await changeOrgPlan("org-abc", "build", "month");
    expect(result).not.toBeNull();
    expect(result?.checkoutUrl).toBe("https://checkout.test/1");
  });

  it("upgrade (build → scale) → calls upgradeSubscription with 'always_invoice'", async () => {
    dbQueryMocks.plans.findFirst.mockResolvedValue(SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ plan: { tier: "build" } }),
    );

    const result = await changeOrgPlan("org-abc", "scale", "month");

    expect(result).toBeNull(); // swap in-place, no checkout URL
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("downgrade (scale → build) → calls upgradeSubscription with 'none'", async () => {
    // plans.findFirst is called in sequence:
    //   call 1: target plan lookup by slug → BUILD_PLAN
    //   call 2: current plan lookup by id  → SCALE_PLAN (current plan is scale)
    //   call 3: syncSubscriptionFromStripe's resolvePlanId → BUILD_PLAN
    dbQueryMocks.plans.findFirst
      .mockResolvedValueOnce(BUILD_PLAN)
      .mockResolvedValueOnce(SCALE_PLAN)
      .mockResolvedValue(BUILD_PLAN);

    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-scale-id" }),
    );

    const result = await changeOrgPlan("org-abc", "build", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("unknown plan slug → throws", async () => {
    dbQueryMocks.plans.findFirst.mockResolvedValue(null);
    await expect(
      changeOrgPlan("org-abc", "nonexistent", "month"),
    ).rejects.toThrow("not found");
  });

  it("plan exists but has no price for the interval → throws", async () => {
    dbQueryMocks.plans.findFirst.mockResolvedValue({
      ...BUILD_PLAN,
      stripePriceIdAnnual: null,
    });
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(null);
    await expect(changeOrgPlan("org-abc", "build", "year")).rejects.toThrow(
      "no year price",
    );
  });
});

describe("createCheckoutSession — active subscription guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("org already has active subscription → throws ActiveSubscriptionError", async () => {
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_existing",
    });
    dbQueryMocks.plans.findFirst.mockResolvedValue(BUILD_PLAN);

    await expect(
      createCheckoutSession({
        orgId: "org-paid",
        planSlug: "build",
        interval: "month",
      }),
    ).rejects.toThrow(ActiveSubscriptionError);
  });

  it("ActiveSubscriptionError has correct code", async () => {
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue({
      stripeSubscriptionId: "sub_existing_002",
    });

    let caught: unknown;
    try {
      await createCheckoutSession({
        orgId: "org-paid",
        planSlug: "build",
        interval: "month",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActiveSubscriptionError);
    expect((caught as InstanceType<typeof ActiveSubscriptionError>).code).toBe(
      "active_subscription_exists",
    );
    expect(
      (caught as InstanceType<typeof ActiveSubscriptionError>)
        .stripeSubscriptionId,
    ).toBe("sub_existing_002");
  });

  it("free org (no active sub) → proceeds to create checkout", async () => {
    // First call (active sub check) → null
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(null);
    dbQueryMocks.plans.findFirst.mockResolvedValue(BUILD_PLAN);
    dbQueryMocks.organizations.findFirst.mockResolvedValue({
      id: "org-free",
      name: "FreeOrg",
      slug: "free-org",
    });
    createSubscriptionCheckoutMock.mockResolvedValue({
      sessionId: "sess_free_001",
      url: "https://checkout.test/free",
    });

    const result = await createCheckoutSession({
      orgId: "org-free",
      planSlug: "build",
      interval: "month",
    });
    expect(result.url).toBe("https://checkout.test/free");
  });
});
