/**
 * Unit tests for checkout.ts (createCheckoutSession,
 * createCreditPackCheckoutSession).
 *
 * Mocks:
 *  - @oxagen/database   → db() factory (plan look-ups)
 *  - ../client.js       → billingProvider() (neutral BillingProvider interface)
 *  - ../customers.js    → ensureStripeCustomer (returns a canned customer id)
 *  - @oxagen/config/env → requireEnv (returns test URL)
 *
 * Scenarios (createCheckoutSession):
 *  1. Plan not found — throws with plan slug in message.
 *  2. Monthly price id missing on plan — throws.
 *  3. Annual price id missing on plan — throws.
 *  4. Provider returns no URL — throws.
 *  5. Happy path — returns { url, sessionId }.
 *
 * Scenarios (createCreditPackCheckoutSession):
 *  1. Provider returns no URL — throws.
 *  2. Happy path — returns { url, sessionId }.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

const ensureStripeCustomerMock = vi.fn().mockResolvedValue("cus_test_001");
vi.mock("./customers", () => ({
  ensureStripeCustomer: ensureStripeCustomerMock,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: "https://app.example.com" })),
}));

import type { PlanTier } from "@oxagen/oxagen/types";

const resolveOrgTierMock = vi
  .fn<() => Promise<PlanTier>>()
  .mockResolvedValue("build");
vi.mock("./tier", () => ({
  resolveOrgTier: resolveOrgTierMock,
}));

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const createSubscriptionCheckoutMock = vi.fn();
const createPaymentCheckoutMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    createSubscriptionCheckout: createSubscriptionCheckoutMock,
    createPaymentCheckout: createPaymentCheckoutMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB mock — only createCheckoutSession uses db().query.plans.findFirst.
// ---------------------------------------------------------------------------

const dbPlansFindFirst = vi.fn();
const dbSubscriptionsFindFirst = vi.fn().mockResolvedValue(null); // no active sub by default

const checkoutDbObj = {
  query: {
    plans: { findFirst: dbPlansFindFirst },
    subscriptions: { findFirst: dbSubscriptionsFindFirst },
  },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => checkoutDbObj,
    withTenantDb: async (fn: (tx: typeof checkoutDbObj) => unknown) =>
      fn(checkoutDbObj),
    withSystemDb: async (fn: (tx: typeof checkoutDbObj) => unknown) =>
      fn(checkoutDbObj),
  };
});

// Import after mocks.
const { createCheckoutSession, createCreditPackCheckoutSession } = await import(
  "./checkout"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_PLAN = {
  id: "plan-uuid-1",
  slug: "pro",
  stripePriceIdMonthly: "price_monthly_001",
  stripePriceIdAnnual: "price_annual_001",
};

// ---------------------------------------------------------------------------
// Tests — createCheckoutSession
// ---------------------------------------------------------------------------

describe("createCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureStripeCustomerMock.mockResolvedValue("cus_test_001");
  });

  it("plan not found — throws with slug in message", async () => {
    dbPlansFindFirst.mockResolvedValue(undefined);

    await expect(
      createCheckoutSession({
        orgId: "org-abc",
        planSlug: "missing-plan",
        interval: "month",
      }),
    ).rejects.toThrow("missing-plan");

    expect(createSubscriptionCheckoutMock).not.toHaveBeenCalled();
  });

  it("monthly price id missing on plan — throws", async () => {
    dbPlansFindFirst.mockResolvedValue({
      ...FULL_PLAN,
      stripePriceIdMonthly: null,
    });

    await expect(
      createCheckoutSession({
        orgId: "org-abc",
        planSlug: "pro",
        interval: "month",
      }),
    ).rejects.toThrow("month");

    expect(createSubscriptionCheckoutMock).not.toHaveBeenCalled();
  });

  it("annual price id missing on plan — throws", async () => {
    dbPlansFindFirst.mockResolvedValue({
      ...FULL_PLAN,
      stripePriceIdAnnual: null,
    });

    await expect(
      createCheckoutSession({
        orgId: "org-abc",
        planSlug: "pro",
        interval: "year",
      }),
    ).rejects.toThrow("year");

    expect(createSubscriptionCheckoutMock).not.toHaveBeenCalled();
  });

  it("provider returns no URL — throws", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    createSubscriptionCheckoutMock.mockRejectedValue(
      new Error("Stripe did not return a checkout URL"),
    );

    await expect(
      createCheckoutSession({
        orgId: "org-abc",
        planSlug: "pro",
        interval: "month",
      }),
    ).rejects.toThrow("checkout URL");
  });

  it("happy path (monthly) — returns url and sessionId", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    createSubscriptionCheckoutMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_test",
      sessionId: "cs_test_001",
    });

    const result = await createCheckoutSession({
      orgId: "org-abc",
      planSlug: "pro",
      interval: "month",
    });

    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test");
    expect(result.sessionId).toBe("cs_test_001");
    expect(createSubscriptionCheckoutMock).toHaveBeenCalledOnce();

    const createArgs = createSubscriptionCheckoutMock.mock.calls[0]![0] as {
      priceId: string;
    };
    expect(createArgs.priceId).toBe("price_monthly_001");
  });

  it("happy path (annual) — uses annual price id", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    createSubscriptionCheckoutMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_annual",
      sessionId: "cs_annual_001",
    });

    const result = await createCheckoutSession({
      orgId: "org-abc",
      planSlug: "pro",
      interval: "year",
    });

    expect(result.sessionId).toBe("cs_annual_001");
    const createArgs = createSubscriptionCheckoutMock.mock.calls[0]![0] as {
      priceId: string;
    };
    expect(createArgs.priceId).toBe("price_annual_001");
  });
});

// ---------------------------------------------------------------------------
// Tests — createCreditPackCheckoutSession
// ---------------------------------------------------------------------------

describe("createCreditPackCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureStripeCustomerMock.mockResolvedValue("cus_test_001");
    resolveOrgTierMock.mockResolvedValue("build");
  });

  it("provider returns no URL — throws", async () => {
    createPaymentCheckoutMock.mockRejectedValue(
      new Error("Stripe did not return a checkout URL"),
    );

    await expect(
      createCreditPackCheckoutSession({
        orgId: "org-abc",
        priceId: "price_pack_001",
      }),
    ).rejects.toThrow("checkout URL");
  });

  it("happy path — returns url and sessionId", async () => {
    createPaymentCheckoutMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_pack",
      sessionId: "cs_pack_001",
    });

    const result = await createCreditPackCheckoutSession({
      orgId: "org-abc",
      priceId: "price_pack_001",
      quantity: 3,
    });

    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_pack");
    expect(result.sessionId).toBe("cs_pack_001");
    expect(createPaymentCheckoutMock).toHaveBeenCalledOnce();

    const createArgs = createPaymentCheckoutMock.mock.calls[0]![0] as {
      priceId: string;
      quantity: number;
      metadata: { org_id: string };
    };
    expect(createArgs.priceId).toBe("price_pack_001");
    expect(createArgs.quantity).toBe(3);
    expect(createArgs.metadata.org_id).toBe("org-abc");
  });
});
