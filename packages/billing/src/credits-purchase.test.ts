/**
 * Unit tests for credits-purchase.ts (createUsageCreditCheckout).
 *
 * Mocks:
 *  - @oxagen/config/env → requireEnv
 *  - ../client.js       → billingProvider() (BillingProvider port)
 *  - ../customers.js    → ensureStripeCustomer
 *  - ../tier.js         → resolveOrgTier
 *  - ../discount.js     → usageVolumeDiscount (real implementation used; env mocked)
 *
 * Scenarios:
 *  1. grantCents < MIN_GRANT_CENTS → throws RangeError.
 *  2. grantCents is non-integer → throws RangeError.
 *  3. Free tier org → throws TierDeniedError (TIER_DENIED code).
 *  4. Provider throws (no URL) → rethrows.
 *  5. Happy path: $250 grant — correct discount, grantCents ≠ priceCents.
 *  6. Happy path: $50 grant — 3% discount applied.
 *  7. Session metadata carries credits = grantCents (face value).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PlanTier } from "@oxagen/oxagen/types";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    OXAGEN_USAGE_DISCOUNT_PERCENT: 3,
    OXAGEN_USAGE_DISCOUNT_INCREMENT: 50,
    OXAGEN_USAGE_DISCOUNT_CEILING_USD: 250,
  })),
}));

const ensureStripeCustomerMock = vi.fn().mockResolvedValue("cus_test_001");
vi.mock("./customers", () => ({
  ensureStripeCustomer: ensureStripeCustomerMock,
}));

const resolveOrgTierMock = vi
  .fn<() => Promise<PlanTier>>()
  .mockResolvedValue("build");
vi.mock("./tier", () => ({
  resolveOrgTier: resolveOrgTierMock,
}));

const createDynamicCreditCheckoutMock = vi.fn();
vi.mock("./client", () => ({
  billingProvider: () => ({
    createDynamicCreditCheckout: createDynamicCreditCheckoutMock,
  }),
}));

// Import after mocks.
const { createUsageCreditCheckout, MIN_GRANT_CENTS } = await import(
  "./credits-purchase"
);
const { TierDeniedError } = await import("./entitlements");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCheckoutResult(
  overrides: Partial<{ url: string; sessionId: string }> = {},
) {
  return {
    url: "https://checkout.stripe.com/pay/cs_dynamic_001",
    sessionId: "cs_dynamic_001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createUsageCreditCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrgTierMock.mockResolvedValue("build");
    ensureStripeCustomerMock.mockResolvedValue("cus_test_001");
    createDynamicCreditCheckoutMock.mockResolvedValue(makeCheckoutResult());
  });

  it("throws RangeError when grantCents is below the minimum", async () => {
    await expect(
      createUsageCreditCheckout({
        orgId: "org-abc",
        grantCents: MIN_GRANT_CENTS - 1,
      }),
    ).rejects.toThrow(RangeError);

    expect(createDynamicCreditCheckoutMock).not.toHaveBeenCalled();
  });

  it("throws RangeError when grantCents is non-integer", async () => {
    await expect(
      createUsageCreditCheckout({ orgId: "org-abc", grantCents: 550.5 }),
    ).rejects.toThrow(RangeError);

    expect(createDynamicCreditCheckoutMock).not.toHaveBeenCalled();
  });

  it("throws TierDeniedError for a Free-tier org", async () => {
    resolveOrgTierMock.mockResolvedValue("free");

    await expect(
      createUsageCreditCheckout({ orgId: "org-free", grantCents: 1000 }),
    ).rejects.toThrow(TierDeniedError);

    expect(createDynamicCreditCheckoutMock).not.toHaveBeenCalled();
  });

  it("rethrows when the provider throws (e.g. no checkout URL)", async () => {
    createDynamicCreditCheckoutMock.mockRejectedValue(
      new Error("Stripe did not return a checkout URL"),
    );

    await expect(
      createUsageCreditCheckout({ orgId: "org-abc", grantCents: 1000 }),
    ).rejects.toThrow("checkout URL");
  });

  it("$250 grant — applies 15% discount, customer pays $212.50, receives 25000 credits", async () => {
    // $250 grant = 25000 cents; 15% off = $37.50 saved; pays $212.50 = 21250 cents
    const grantCents = 25_000;

    const result = await createUsageCreditCheckout({
      orgId: "org-abc",
      grantCents,
    });

    expect(result.grantCents).toBe(grantCents);
    expect(result.percent).toBe(15);
    expect(result.priceCents).toBe(21_250); // 25000 - round(25000 * 15/100)
    expect(result.url).toBe("https://checkout.stripe.com/pay/cs_dynamic_001");

    // Verify the provider was called with the discounted price, not the grant amount
    const providerArgs = createDynamicCreditCheckoutMock.mock.calls[0]![0] as {
      priceCents: number;
      grantCents: number;
      discountPercent: number;
      orgId: string;
    };
    expect(providerArgs.priceCents).toBe(21_250);
    expect(providerArgs.grantCents).toBe(grantCents);
    expect(providerArgs.discountPercent).toBe(15);
    expect(providerArgs.orgId).toBe("org-abc");
  });

  it("$50 grant — applies 3% discount, customer pays $48.50, receives 5000 credits", async () => {
    // $50 grant = 5000 cents; 3% off = $1.50 saved; pays $48.50 = 4850 cents
    const grantCents = 5_000;

    const result = await createUsageCreditCheckout({
      orgId: "org-abc",
      grantCents,
    });

    expect(result.grantCents).toBe(grantCents);
    expect(result.percent).toBe(3);
    expect(result.priceCents).toBe(4_850);
  });

  it("$5 minimum grant — no discount (below first increment), pays full price", async () => {
    // $5 = 500 cents; below the $50 increment threshold; 0% discount
    const grantCents = 500;

    const result = await createUsageCreditCheckout({
      orgId: "org-abc",
      grantCents,
    });

    expect(result.grantCents).toBe(500);
    expect(result.percent).toBe(0);
    expect(result.priceCents).toBe(500);
  });

  it("session metadata carries credits = grantCents (face value)", async () => {
    const grantCents = 10_000;

    await createUsageCreditCheckout({ orgId: "org-abc", grantCents });

    const providerArgs = createDynamicCreditCheckoutMock.mock.calls[0]![0] as {
      grantCents: number;
    };
    // The provider receives grantCents (face value) which it stores as `credits`
    // in session metadata — the webhook reads it to grant the full face value.
    expect(providerArgs.grantCents).toBe(grantCents);
  });

  it("ensures Stripe customer before creating the session", async () => {
    await createUsageCreditCheckout({ orgId: "org-abc", grantCents: 1000 });

    expect(ensureStripeCustomerMock).toHaveBeenCalledWith("org-abc");
    // Provider is called with the customer id returned by ensureStripeCustomer
    const providerArgs = createDynamicCreditCheckoutMock.mock.calls[0]![0] as {
      customerId: string;
    };
    expect(providerArgs.customerId).toBe("cus_test_001");
  });

  it("accepts scale-tier org (tier gate allows build+)", async () => {
    resolveOrgTierMock.mockResolvedValue("scale");

    const result = await createUsageCreditCheckout({
      orgId: "org-scale",
      grantCents: 5000,
    });

    expect(result.url).toBeDefined();
    expect(createDynamicCreditCheckoutMock).toHaveBeenCalledOnce();
  });
});
