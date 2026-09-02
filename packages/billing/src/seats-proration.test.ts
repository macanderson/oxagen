/**
 * Unit tests for previewSeatChange and direction-aware setSubscriptionSeats
 * (packages/billing/src/subscriptions.ts).
 *
 * Also tests previewPlanChange (checkout vs in-place paths).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider() via setBillingProvider/resetBillingProvider
 *  - ../seats.js      → getOrgSeatUsage
 *  - ../customers.js  → ensureStripeCustomer
 *  - ../grants.js     → grantProratedPlanUpgradeCredits (no-op)
 *
 * Covers:
 *  1. previewSeatChange — increase direction → charge, prorationBehavior always_invoice
 *  2. previewSeatChange — decrease direction → credit, prorationBehavior create_prorations
 *  3. previewSeatChange — no change (none direction) → amountCents=0, no provider call
 *  4. previewSeatChange — decrease below usage → returns blocked, no provider call
 *  5. setSubscriptionSeats — increase passes prorationBehavior always_invoice
 *  6. setSubscriptionSeats — decrease passes prorationBehavior create_prorations
 *  7. previewPlanChange — no active sub → requiresCheckout=true, full plan price
 *  8. previewPlanChange — upgrade (active sub) → requiresCheckout=false, preview amountCents
 *  9. previewPlanChange — downgrade (active sub) → prorationBehavior none
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Provider mock (set via setBillingProvider)
// ---------------------------------------------------------------------------

const previewSeatChangeMock = vi.fn();
const previewPlanChangeMock = vi.fn();
const setSubscriptionSeatsMock = vi.fn().mockResolvedValue(undefined);
const getSubscriptionMock = vi.fn();
const listPaymentMethodsMock = vi.fn().mockResolvedValue([]);
const getDefaultPaymentMethodIdMock = vi.fn().mockResolvedValue(null);
const upgradeSubscriptionMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./client", () => ({
  billingProvider: () => ({
    previewSeatChange: previewSeatChangeMock,
    previewPlanChange: previewPlanChangeMock,
    setSubscriptionSeats: setSubscriptionSeatsMock,
    getSubscription: getSubscriptionMock,
    listPaymentMethods: listPaymentMethodsMock,
    getDefaultPaymentMethodId: getDefaultPaymentMethodIdMock,
    upgradeSubscription: upgradeSubscriptionMock,
    updateSubscription: vi.fn().mockResolvedValue(undefined),
    cancelSubscription: vi.fn().mockResolvedValue(undefined),
  }),
}));

// ---------------------------------------------------------------------------
// seats mock
// ---------------------------------------------------------------------------

const getOrgSeatUsageMock = vi.fn();
vi.mock("./seats", () => ({
  getOrgSeatUsage: getOrgSeatUsageMock,
  SeatLimitError: class SeatLimitError extends Error {
    readonly code = "seat_limit_reached";
    readonly licenses: number;
    readonly used: number;
    constructor(licenses: number, used: number) {
      super(`Seat limit: ${used}/${licenses}`);
      this.name = "SeatLimitError";
      this.licenses = licenses;
      this.used = used;
    }
  },
  isSeatLimitError: (err: unknown) =>
    err instanceof Error &&
    (err as { code?: string }).code === "seat_limit_reached",
}));

// ---------------------------------------------------------------------------
// customers mock
// ---------------------------------------------------------------------------

vi.mock("./customers", () => ({
  ensureStripeCustomer: vi.fn().mockResolvedValue("cus_mock"),
}));

// ---------------------------------------------------------------------------
// grants mock (sibling agent will add grantProratedPlanUpgradeCredits)
// ---------------------------------------------------------------------------

vi.mock("./grants", () => ({
  grantFreeCredits: vi.fn().mockResolvedValue(undefined),
  grantPlanCreditsForInvoicePaid: vi.fn().mockResolvedValue(undefined),
  grantCreditPackForCheckout: vi.fn().mockResolvedValue(undefined),
  grantProratedPlanUpgradeCredits: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const subscriptionsFindFirstMock = vi.fn();
const plansFindFirstMock = vi.fn();
const insertUpsertChain = {
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};
const insertMock = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue(insertUpsertChain),
});

const dbMocks = {
  insert: insertMock,
  query: {
    subscriptions: { findFirst: subscriptionsFindFirstMock },
    plans: { findFirst: plansFindFirstMock },
  },
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

// Import AFTER mocks.
const { previewSeatChange, setSubscriptionSeats, previewPlanChange } =
  await import("./subscriptions");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeActiveSubRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stripeSubscriptionId: "sub_test",
    stripeCustomerId: "cus_test",
    seatCount: 5,
    planId: "plan-uuid-build",
    status: "active",
    ...overrides,
  };
}

function makeProrationPreview(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    amountCents: 2000,
    isCharge: true,
    currency: "usd",
    prorationDate: 1700000000,
    lines: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// previewSeatChange tests
// ---------------------------------------------------------------------------

describe("previewSeatChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPaymentMethodsMock.mockResolvedValue([]);
    getDefaultPaymentMethodIdMock.mockResolvedValue(null);
  });

  it("increase direction — provider called with always_invoice, returns charge", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 3 }),
    );
    previewSeatChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: 1500, isCharge: true }),
    );

    const result = await previewSeatChange("org-001", 5);

    expect(result.direction).toBe("increase");
    expect(result.isCharge).toBe(true);
    expect(result.isCredit).toBe(false);
    expect(result.amountCents).toBe(1500);

    const callArgs = previewSeatChangeMock.mock.calls[0] as [
      string,
      { seats: number; prorationBehavior: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("always_invoice");
    expect(callArgs[1].seats).toBe(5);
  });

  it("decrease direction — provider called with create_prorations, returns credit", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 5 }),
    );
    getOrgSeatUsageMock.mockResolvedValue({
      licenses: 5,
      used: 2,
      available: 3,
    });
    previewSeatChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: -800, isCharge: false }),
    );

    const result = await previewSeatChange("org-001", 3);

    expect(result.direction).toBe("decrease");
    expect(result.isCharge).toBe(false);
    expect(result.isCredit).toBe(true);
    expect(result.amountCents).toBe(-800);

    const callArgs = previewSeatChangeMock.mock.calls[0] as [
      string,
      { seats: number; prorationBehavior: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("create_prorations");
  });

  it("no change (none) — returns amountCents=0 without calling provider", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 5 }),
    );

    const result = await previewSeatChange("org-001", 5);

    expect(result.direction).toBe("none");
    expect(result.amountCents).toBe(0);
    expect(result.isCharge).toBe(false);
    expect(result.isCredit).toBe(false);
    expect(previewSeatChangeMock).not.toHaveBeenCalled();
  });

  it("decrease below current usage — returns blocked without calling provider", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 5 }),
    );
    getOrgSeatUsageMock.mockResolvedValue({
      licenses: 5,
      used: 4,
      available: 1,
    });

    const result = await previewSeatChange("org-001", 2);

    expect(result.blocked).toBeDefined();
    expect(result.blocked!.code).toBe("seat_limit_reached");
    expect(result.blocked!.used).toBe(4);
    expect(result.blocked!.licenses).toBe(5);
    expect(previewSeatChangeMock).not.toHaveBeenCalled();
  });

  it("throws when no active subscription exists", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(undefined);

    await expect(previewSeatChange("org-001", 3)).rejects.toThrow(
      "No active subscription",
    );
  });

  it("resolves default card brand and last4 when available", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 2, stripeCustomerId: "cus_card" }),
    );
    previewSeatChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: 500 }),
    );
    getDefaultPaymentMethodIdMock.mockResolvedValue("pm_abc");
    listPaymentMethodsMock.mockResolvedValue([
      {
        id: "pm_abc",
        customerId: "cus_card",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2028,
      },
    ]);

    const result = await previewSeatChange("org-001", 5);

    expect(result.card).toEqual({ brand: "visa", last4: "4242" });
  });

  it("card is null when no default payment method is on file", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 2 }),
    );
    previewSeatChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: 500 }),
    );
    getDefaultPaymentMethodIdMock.mockResolvedValue(null);

    const result = await previewSeatChange("org-001", 5);

    expect(result.card).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setSubscriptionSeats direction-aware tests
// ---------------------------------------------------------------------------

describe("setSubscriptionSeats — direction-aware proration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertUpsertChain.onConflictDoUpdate.mockResolvedValue(undefined);
    insertMock.mockReturnValue({
      values: vi.fn().mockReturnValue(insertUpsertChain),
    });
    getOrgSeatUsageMock.mockResolvedValue({
      licenses: 5,
      used: 1,
      available: 4,
    });

    // For syncSubscriptionFromStripe: provider.getSubscription + plan lookup
    getSubscriptionMock.mockResolvedValue({
      id: "sub_test",
      customerId: "cus_test",
      metadata: { org_id: "org-001" },
      status: "active",
      billingInterval: "month",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      productId: "prod_build",
      seatCount: 5,
    });
    plansFindFirstMock.mockResolvedValue({ id: "plan-uuid-build" });
  });

  it("increase — passes prorationBehavior always_invoice with idempotencyKey", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 3 }),
    );

    await setSubscriptionSeats("org-001", 5);

    expect(setSubscriptionSeatsMock).toHaveBeenCalledOnce();
    const callArgs = setSubscriptionSeatsMock.mock.calls[0] as [
      string,
      { seats: number; prorationBehavior: string; idempotencyKey: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("always_invoice");
    expect(callArgs[1].seats).toBe(5);
    expect(callArgs[1].idempotencyKey).toBe("seats:sub_test:5");
  });

  it("decrease — passes prorationBehavior create_prorations", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(
      makeActiveSubRow({ seatCount: 5 }),
    );
    getOrgSeatUsageMock.mockResolvedValue({
      licenses: 5,
      used: 2,
      available: 3,
    });

    await setSubscriptionSeats("org-001", 3);

    const callArgs = setSubscriptionSeatsMock.mock.calls[0] as [
      string,
      { seats: number; prorationBehavior: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("create_prorations");
  });
});

// ---------------------------------------------------------------------------
// previewPlanChange tests
// ---------------------------------------------------------------------------

describe("previewPlanChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPaymentMethodsMock.mockResolvedValue([]);
    getDefaultPaymentMethodIdMock.mockResolvedValue(null);
  });

  it("no active subscription — requiresCheckout=true, full monthly price", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(undefined);
    plansFindFirstMock.mockResolvedValue({
      id: "plan-build",
      tier: "build",
      stripePriceIdMonthly: "price_build_mo",
      stripePriceIdAnnual: "price_build_yr",
      monthlyCents: 2000,
      annualCents: 20000,
    });
    // No subscription row means no customerId — ensureStripeCustomer will be skipped.
    // DB subscriptions.findFirst for resolveCustomerId returns undefined.
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await previewPlanChange("org-free", "build-v2", "month");

    expect(result.requiresCheckout).toBe(true);
    expect(result.amountCents).toBe(2000);
    expect(result.isCharge).toBe(true);
    expect(result.targetPlanSlug).toBe("build-v2");
    expect(result.interval).toBe("month");
    expect(previewPlanChangeMock).not.toHaveBeenCalled();
  });

  it("no active subscription — annual price used when interval=year", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(undefined);
    plansFindFirstMock.mockResolvedValue({
      id: "plan-build",
      tier: "build",
      stripePriceIdMonthly: "price_build_mo",
      stripePriceIdAnnual: "price_build_yr",
      monthlyCents: 2000,
      annualCents: 20000,
    });
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    const result = await previewPlanChange("org-free", "build-v2", "year");

    expect(result.requiresCheckout).toBe(true);
    expect(result.amountCents).toBe(20000);
  });

  it("upgrade (active sub, higher tier) — requiresCheckout=false, provider preview used", async () => {
    // First call (active sub check), second call (current plan lookup),
    // third call (resolveCustomerId).
    subscriptionsFindFirstMock
      .mockResolvedValueOnce(makeActiveSubRow({ planId: "plan-build" })) // active sub
      .mockResolvedValueOnce({ stripeCustomerId: "cus_001" }); // resolveCustomerId

    // plansFindFirstMock called twice: target plan + current plan
    plansFindFirstMock
      .mockResolvedValueOnce({
        id: "plan-scale",
        tier: "scale",
        stripePriceIdMonthly: "price_scale_mo",
        stripePriceIdAnnual: "price_scale_yr",
        monthlyCents: 9900,
        annualCents: 99000,
      })
      .mockResolvedValueOnce({ tier: "build" }); // current plan

    previewPlanChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: 7500, isCharge: true }),
    );

    const result = await previewPlanChange("org-001", "scale-v2", "month");

    expect(result.requiresCheckout).toBe(false);
    expect(result.amountCents).toBe(7500);
    expect(result.isCharge).toBe(true);

    // Upgrade → always_invoice.
    const callArgs = previewPlanChangeMock.mock.calls[0] as [
      string,
      { newPriceId: string; prorationBehavior: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("always_invoice");
  });

  it("downgrade (active sub, lower tier) — prorationBehavior none, amountCents=0", async () => {
    subscriptionsFindFirstMock
      .mockResolvedValueOnce(makeActiveSubRow({ planId: "plan-scale" }))
      .mockResolvedValueOnce({ stripeCustomerId: "cus_001" });

    plansFindFirstMock
      .mockResolvedValueOnce({
        id: "plan-build",
        tier: "build",
        stripePriceIdMonthly: "price_build_mo",
        stripePriceIdAnnual: null,
        monthlyCents: 2000,
        annualCents: null,
      })
      .mockResolvedValueOnce({ tier: "scale" }); // current plan

    previewPlanChangeMock.mockResolvedValue(
      makeProrationPreview({ amountCents: 0, isCharge: false }),
    );

    const result = await previewPlanChange("org-001", "build-v2", "month");

    expect(result.requiresCheckout).toBe(false);
    const callArgs = previewPlanChangeMock.mock.calls[0] as [
      string,
      { newPriceId: string; prorationBehavior: string },
    ];
    expect(callArgs[1].prorationBehavior).toBe("none");
  });

  it("throws when target plan slug is not found", async () => {
    plansFindFirstMock.mockResolvedValueOnce(undefined);

    await expect(
      previewPlanChange("org-001", "unknown-plan", "month"),
    ).rejects.toThrow("unknown-plan");
  });

  it("throws when target plan has no price for the requested interval", async () => {
    subscriptionsFindFirstMock.mockResolvedValue(undefined);
    plansFindFirstMock.mockResolvedValueOnce({
      id: "plan-build",
      tier: "build",
      stripePriceIdMonthly: null,
      stripePriceIdAnnual: null,
      monthlyCents: 2000,
      annualCents: null,
    });
    dbMocks.query.subscriptions.findFirst.mockResolvedValue(undefined);

    await expect(
      previewPlanChange("org-001", "build-v2", "month"),
    ).rejects.toThrow("no month price");
  });
});
