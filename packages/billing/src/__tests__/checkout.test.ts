/**
 * Unit tests for checkout.ts (createCheckoutSession,
 * createCreditPackCheckoutSession).
 *
 * Mocks:
 *  - @oxagen/database  → db() factory (plan look-ups)
 *  - ../client.js      → stripeClient() (no live Stripe API)
 *  - ../customers.js   → ensureStripeCustomer (returns a canned customer id)
 *  - @oxagen/config/env → requireEnv (returns test URL)
 *
 * Scenarios (createCheckoutSession):
 *  1. Plan not found — throws with plan slug in message.
 *  2. Monthly price id missing on plan — throws.
 *  3. Annual price id missing on plan — throws.
 *  4. Stripe returns no URL — throws.
 *  5. Happy path — returns { url, sessionId }.
 *
 * Scenarios (createCreditPackCheckoutSession):
 *  1. Stripe returns no URL — throws.
 *  2. Happy path — returns { url, sessionId }.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

const ensureStripeCustomerMock = vi.fn().mockResolvedValue("cus_test_001");
vi.mock("../customers.js", () => ({
  ensureStripeCustomer: ensureStripeCustomerMock,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({ NEXT_PUBLIC_APP_URL: "https://app.example.com" })),
}));

// ---------------------------------------------------------------------------
// Tier mock — resolveOrgTier is the only call into tier.ts from checkout.ts.
// Default to "build" so canBuyCredits() returns true and tests can proceed
// to the Stripe layer.  Individual tests that exercise the tier-denied path
// can override resolveOrgTierMock.mockResolvedValueOnce("free").
// ---------------------------------------------------------------------------

import type { PlanTier } from "@oxagen/oxagen/types";

const resolveOrgTierMock = vi.fn<() => Promise<PlanTier>>().mockResolvedValue("build");
vi.mock("../tier.js", () => ({
  resolveOrgTier: resolveOrgTierMock,
}));

// ---------------------------------------------------------------------------
// Stripe client mock
// ---------------------------------------------------------------------------

const stripeSessionCreateMock = vi.fn();
vi.mock("../client.js", () => ({
  stripeClient: () => ({
    checkout: {
      sessions: { create: stripeSessionCreateMock },
    },
  }),
}));

// ---------------------------------------------------------------------------
// DB mock — only createCheckoutSession uses db().query.plans.findFirst.
// createCreditPackCheckoutSession delegates its DB access to resolveOrgTier
// (mocked above) and ensureStripeCustomer (mocked above), so no chainable
// select() is needed here.
// ---------------------------------------------------------------------------

const dbPlansFindFirst = vi.fn();

vi.mock("@oxagen/database", () => ({
  db: () => ({
    query: {
      plans: { findFirst: dbPlansFindFirst },
    },
  }),
  schema: {
    plans: { slug: "plans.slug" },
  },
}));

// Import after mocks.
const { createCheckoutSession, createCreditPackCheckoutSession } = await import(
  "../checkout.js"
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
      createCheckoutSession({ orgId: "org-abc", planSlug: "missing-plan", interval: "month" }),
    ).rejects.toThrow("missing-plan");

    expect(stripeSessionCreateMock).not.toHaveBeenCalled();
  });

  it("monthly price id missing on plan — throws", async () => {
    dbPlansFindFirst.mockResolvedValue({
      ...FULL_PLAN,
      stripePriceIdMonthly: null,
    });

    await expect(
      createCheckoutSession({ orgId: "org-abc", planSlug: "pro", interval: "month" }),
    ).rejects.toThrow("month");

    expect(stripeSessionCreateMock).not.toHaveBeenCalled();
  });

  it("annual price id missing on plan — throws", async () => {
    dbPlansFindFirst.mockResolvedValue({
      ...FULL_PLAN,
      stripePriceIdAnnual: null,
    });

    await expect(
      createCheckoutSession({ orgId: "org-abc", planSlug: "pro", interval: "year" }),
    ).rejects.toThrow("year");

    expect(stripeSessionCreateMock).not.toHaveBeenCalled();
  });

  it("Stripe returns no URL — throws", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    stripeSessionCreateMock.mockResolvedValue({ url: null, id: "cs_no_url" });

    await expect(
      createCheckoutSession({ orgId: "org-abc", planSlug: "pro", interval: "month" }),
    ).rejects.toThrow("checkout URL");
  });

  it("happy path (monthly) — returns url and sessionId", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    stripeSessionCreateMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_test",
      id: "cs_test_001",
    });

    const result = await createCheckoutSession({
      orgId: "org-abc",
      planSlug: "pro",
      interval: "month",
    });

    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test");
    expect(result.sessionId).toBe("cs_test_001");
    expect(stripeSessionCreateMock).toHaveBeenCalledOnce();

    // Verify the monthly price id was used, not the annual one.
    const createArgs = stripeSessionCreateMock.mock.calls[0]![0] as {
      line_items: Array<{ price: string }>;
    };
    expect(createArgs.line_items[0]?.price).toBe("price_monthly_001");
  });

  it("happy path (annual) — uses annual price id", async () => {
    dbPlansFindFirst.mockResolvedValue(FULL_PLAN);
    stripeSessionCreateMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_annual",
      id: "cs_annual_001",
    });

    const result = await createCheckoutSession({
      orgId: "org-abc",
      planSlug: "pro",
      interval: "year",
    });

    expect(result.sessionId).toBe("cs_annual_001");
    const createArgs = stripeSessionCreateMock.mock.calls[0]![0] as {
      line_items: Array<{ price: string }>;
    };
    expect(createArgs.line_items[0]?.price).toBe("price_annual_001");
  });
});

// ---------------------------------------------------------------------------
// Tests — createCreditPackCheckoutSession
// ---------------------------------------------------------------------------

describe("createCreditPackCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureStripeCustomerMock.mockResolvedValue("cus_test_001");
    // Restore tier default after vi.clearAllMocks() wipes mock implementations.
    resolveOrgTierMock.mockResolvedValue("build");
  });

  it("Stripe returns no URL — throws", async () => {
    stripeSessionCreateMock.mockResolvedValue({ url: null, id: "cs_no_url" });

    await expect(
      createCreditPackCheckoutSession({ orgId: "org-abc", priceId: "price_pack_001" }),
    ).rejects.toThrow("checkout URL");
  });

  it("happy path — returns url and sessionId", async () => {
    stripeSessionCreateMock.mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_pack",
      id: "cs_pack_001",
    });

    const result = await createCreditPackCheckoutSession({
      orgId: "org-abc",
      priceId: "price_pack_001",
      quantity: 3,
    });

    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_pack");
    expect(result.sessionId).toBe("cs_pack_001");
    expect(stripeSessionCreateMock).toHaveBeenCalledOnce();

    const createArgs = stripeSessionCreateMock.mock.calls[0]![0] as {
      mode: string;
      line_items: Array<{ price: string; quantity: number }>;
      metadata: { org_id: string };
    };
    expect(createArgs.mode).toBe("payment");
    expect(createArgs.line_items[0]?.price).toBe("price_pack_001");
    expect(createArgs.line_items[0]?.quantity).toBe(3);
    expect(createArgs.metadata.org_id).toBe("org-abc");
  });
});
