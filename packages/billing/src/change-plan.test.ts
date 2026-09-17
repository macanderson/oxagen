/**
 * Unit tests for changeOrgPlan + createCheckoutSession guard
 * (packages/billing/src/subscriptions.ts + checkout.ts).
 *
 * Scenarios:
 *  1. changeOrgPlan — no active subscription (free) → returns checkout URL
 *  2. changeOrgPlan — active subscription, bill rises → swaps (always_invoice)
 *  3. changeOrgPlan — active subscription, bill falls → swaps (none)
 *  4. changeOrgPlan — unknown plan slug → throws
 *  5. createCheckoutSession — org has active sub → throws ActiveSubscriptionError
 *  6. createCheckoutSession — free org (no sub) → creates checkout
 *  7. #3157 — proration follows price, not the entitlement tier rank:
 *     Enterprise→Scale invoices (bill doubles) and Scale→Enterprise does not
 *     (bill halves), which is the opposite of what TIER_ORDER says.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── BillingProvider mock ─────────────────────────────────────────────────────

const upgradeSubscriptionMock = vi.fn().mockResolvedValue(undefined);
const getSubscriptionMock = vi.fn();
const createSubscriptionCheckoutMock = vi.fn();
/**
 * The previewed invoice is now the whole input to the proration direction, so
 * these tests drive it directly. `amountCents` is the NET proration Stripe
 * would raise — discounts included — and its sign is the answer.
 */
const previewPlanChangeMock = vi.fn();
function previewingProration(amountCents: number) {
  previewPlanChangeMock.mockResolvedValue({
    amountCents,
    isCharge: amountCents > 0,
    currency: "usd",
    prorationDate: 1_700_000_000,
    totalCents: amountCents,
    lines: [],
  });
}

vi.mock("./client", () => ({
  billingProvider: () => ({
    getSubscription: getSubscriptionMock,
    previewPlanChange: previewPlanChangeMock,
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
  orgBillingSettings: { findFirst: vi.fn() },
};

/**
 * Every `set(...)` payload written to billing.subscriptions in a test, in
 * order. The plan-upgrade intent is a write, not a return value, so this is
 * how "the plan being left was recorded before the provider was touched" is
 * asserted at all.
 */
const subscriptionUpdates: Array<Record<string, unknown>> = [];

const dbMocks = {
  query: dbQueryMocks,
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: (values: Record<string, unknown>) => {
      subscriptionUpdates.push(values);
      return { where: vi.fn().mockResolvedValue(undefined) };
    },
  })),
};

/**
 * The insert chain both writers on this path use.
 *
 * `syncSubscriptionFromStripe` awaits `…onConflictDoUpdate()` directly, while
 * `ensureStripeCustomer` calls `.returning()` on it and destructures the first
 * row, so the object the conflict clause answers with must be awaitable *and*
 * carry `returning`. A plain `mockResolvedValue(undefined)` satisfies only the
 * first caller and makes the second throw on a missing method.
 */
function stubInsertChain() {
  const afterConflict = Promise.resolve(undefined) as Promise<undefined> & {
    returning: ReturnType<typeof vi.fn>;
  };
  // The column is written with the id the caller resolved, which on this path
  // is the one `createCustomer` answers with — so no concurrent-write branch.
  afterConflict.returning = vi
    .fn()
    .mockResolvedValue([{ stripeCustomerId: "cus_new" }]);
  dbMocks.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue(afterConflict),
    }),
  });
  // No stored customer id, so `ensureStripeCustomer` resolves one and writes it.
  dbQueryMocks.orgBillingSettings.findFirst.mockResolvedValue(undefined);
}

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

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("./logger", () => ({ logger: loggerMock }));

const hasPlanUpgradeGrantMock = vi.fn().mockResolvedValue(true);
const grantProratedPlanUpgradeCreditsMock = vi
  .fn()
  .mockResolvedValue(undefined);
vi.mock("./grants", () => ({
  hasPlanUpgradeGrant: hasPlanUpgradeGrantMock,
  grantProratedPlanUpgradeCredits: grantProratedPlanUpgradeCreditsMock,
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://app.test" }),
}));

// Import AFTER mocks.
const { SUBSCRIPTION_PLANS } = await import("./pricing");
const { changeOrgPlan } = await import("./subscriptions");
const { createCheckoutSession, ActiveSubscriptionError } = await import(
  "./checkout"
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The catalogue rows the `billing.plans` fixtures below are priced from, so a
 * reprice moves these tests rather than slipping past them. Named here once;
 * each proration test asserts the figure it depends on.
 */
function catalogPlan(slug: string) {
  const plan = SUBSCRIPTION_PLANS.find((p) => p.slug === slug);
  if (!plan) throw new Error(`catalogue has no plan '${slug}'`);
  return plan;
}

const BUILD_CATALOG = catalogPlan("build-v2");
const SCALE_CATALOG = catalogPlan("scale-v2");
const ENTERPRISE_CATALOG = catalogPlan("enterprise-v2");

const BUILD_PLAN = {
  id: "plan-build-id",
  slug: BUILD_CATALOG.slug,
  tier: "build",
  stripePriceIdMonthly: "price_build_m",
  stripePriceIdAnnual: "price_build_y",
  monthlyCents: BUILD_CATALOG.monthlyCents,
  annualCents: BUILD_CATALOG.annualCents,
};
const SCALE_PLAN = {
  id: "plan-scale-id",
  slug: SCALE_CATALOG.slug,
  tier: "scale",
  stripePriceIdMonthly: "price_scale_m",
  stripePriceIdAnnual: "price_scale_y",
  monthlyCents: SCALE_CATALOG.monthlyCents,
  annualCents: SCALE_CATALOG.annualCents,
};
const ENTERPRISE_PLAN = {
  id: "plan-enterprise-id",
  slug: ENTERPRISE_CATALOG.slug,
  tier: "enterprise",
  stripePriceIdMonthly: "price_enterprise_m",
  stripePriceIdAnnual: "price_enterprise_y",
  monthlyCents: ENTERPRISE_CATALOG.monthlyCents,
  annualCents: ENTERPRISE_CATALOG.annualCents,
};

function makeActiveSub(
  overrides: Partial<{
    stripeSubscriptionId: string;
    seatCount: number;
    planId: string;
    billingInterval: string;
    stripePriceId: string | null;
    currentPeriodStart: Date;
    pendingUpgradeFromPlanId: string | null;
    plan: { tier: string };
  }> = {},
) {
  return {
    stripeSubscriptionId: "sub_active_001",
    seatCount: 1,
    planId: "plan-build-id",
    billingInterval: "month",
    // No plan change in flight. Set by a caller that is exercising a retry of
    // one that is.
    pendingUpgradeFromPlanId: null,
    // WHICH price the subscription sits on. An identity, not an amount: it is
    // how a retry of an already-applied swap is recognised. The direction
    // comes from the previewed invoice (#3157).
    stripePriceId: "price_build_m",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    plan: { tier: "build" },
    ...overrides,
  };
}

/**
 * changeOrgPlan reads `billing.plans` twice before the swap — the target by
 * slug, then the plan the org is on by id — and `syncSubscriptionFromStripe`
 * reads it once more afterwards by product id.
 */
function stubPlanLookups(target: unknown, current: unknown) {
  dbQueryMocks.plans.findFirst
    .mockResolvedValueOnce(target)
    .mockResolvedValueOnce(current)
    .mockResolvedValue(target);
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
    stubInsertChain();
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

  it("bill rises → calls upgradeSubscription with 'always_invoice'", async () => {
    // The previewed invoice is the input. A positive net proration is the
    // change billing more, whatever the catalogue or the price field says.
    previewingProration(80_000);
    stubPlanLookups(SCALE_PLAN, BUILD_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-build-id",
        stripePriceId: "price_build_m",
      }),
    );

    const result = await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(result).toBeNull(); // swap in-place, no checkout URL
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("bill falls → calls upgradeSubscription with 'none'", async () => {
    previewingProration(-80_000);
    stubPlanLookups(BUILD_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
      }),
    );

    const result = await changeOrgPlan("org-abc", "build-v2", "month");

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

// ── #3157: proration follows price, not the entitlement tier rank ───────────
//
// TIER_ORDER ranks Enterprise above Scale because Enterprise holds the SOC2
// entitlements (ACLs, SSO, SCIM, immutable audit). The catalogue prices it
// below Scale. Every assertion below states the price it depends on, so a
// reprice fails here loudly instead of quietly flipping a branch.

// ── #3157: the direction is the previewed money, and nothing standing in ────
//
// Three stand-ins have inverted in turn: the entitlement tier rank, the
// catalogue plan row, and `price.unit_amount` against a discount. Each of the
// cases below sets the previewed invoice AND leaves the stand-ins pointing the
// other way, so a reading taken from any of them fails the assertion rather
// than agreeing with it by luck.

describe("changeOrgPlan proration direction (#3157)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      productId: "prod_scale",
      priceId: "price_scale_m",
      seatCount: 1,
    });
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("the catalogue still disagrees with the tier ordering — the premise the first pass fixed", () => {
    expect(ENTERPRISE_CATALOG.monthlyCents).toBe(50_000); // $500/mo
    expect(SCALE_CATALOG.monthlyCents).toBe(99_900); // $999/mo
    expect(SCALE_CATALOG.monthlyCents).toBeGreaterThan(
      ENTERPRISE_CATALOG.monthlyCents,
    );
    expect(ENTERPRISE_PLAN.tier).toBe("enterprise");
    expect(SCALE_PLAN.tier).toBe("scale");
  });

  it("enterprise → scale: the preview says the bill rises, and the tier rank says downgrade", async () => {
    previewingProration(49_900); // $500 → $999, prorated
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("scale → enterprise: the preview says the bill falls, and the tier rank says upgrade", async () => {
    previewingProration(-49_900);
    stubPlanLookups(ENTERPRISE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
      }),
    );

    await changeOrgPlan("org-abc", "enterprise-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("a discounted subscriber moving to a cheaper list price is still an increase (P1)", async () => {
    // The case no stored amount can answer. $200 list discounted to $100,
    // moving to an undiscounted $150 product: every price FIELD in play reads
    // $200 → $150, a decrease. The invoice Stripe would raise is +$50, and
    // that is the money. `allow_promotion_codes` is set on both checkout
    // paths, so this subscription is a state the product deliberately creates.
    previewingProration(5_000); // net +$50 after the discount
    const DISCOUNTED_CURRENT = {
      id: "plan-list200-id",
      slug: "list200-v2",
      tier: "build",
      stripePriceIdMonthly: "price_list_200",
      stripePriceIdAnnual: null,
      monthlyCents: 20_000, // what the price LISTS, not what they pay
      annualCents: null,
    };
    const TARGET_150 = {
      id: "plan-mid-id",
      slug: "mid-v2",
      tier: "scale",
      stripePriceIdMonthly: "price_mid_150",
      stripePriceIdAnnual: null,
      monthlyCents: 15_000,
      annualCents: null,
    };
    expect(TARGET_150.monthlyCents).toBeLessThan(
      DISCOUNTED_CURRENT.monthlyCents,
    );

    stubPlanLookups(TARGET_150, DISCOUNTED_CURRENT);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-list200-id",
        stripePriceId: "price_list_200",
      }),
    );

    await changeOrgPlan("org-abc", "mid-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("a change that moves no money ships 'none'", async () => {
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-scale-id", stripePriceId: "price_other" }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("monthly → annual on one plan is whatever the invoice says, not what the rates suggest", async () => {
    // The per-month rate falls (two months free) and the next invoice rises.
    previewingProration(899_100);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        billingInterval: "month",
        stripePriceId: "price_scale_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "year");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("a preview that cannot be taken settles as 'always_invoice', never 'none'", async () => {
    // An invoice raised in the wrong direction is a credit the customer can
    // see and we can refund. A charge never raised is simply gone.
    previewPlanChangeMock.mockRejectedValue(new Error("stripe unavailable"));
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("the preview is taken under create_prorations, so asking the question charges nobody", async () => {
    previewingProration(1_000);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(previewPlanChangeMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "create_prorations" }),
    );
  });
});

// ── P2: a retry whose first attempt already landed ──────────────────────────

describe("changeOrgPlan — a retried swap is a no-op, not a second decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionUpdates.length = 0;
    grantProratedPlanUpgradeCreditsMock.mockResolvedValue(undefined);
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("a subscription already on the target price is not swapped again", async () => {
    // First attempt succeeded and its response was lost; the sync already
    // recorded the new price. Re-deciding here would compare the subscription
    // against itself, read no movement, and send `none` where the first
    // attempt sent `always_invoice` — under the SAME idempotency key, which
    // Stripe rejects rather than replaying.
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m", // == SCALE_PLAN.stripePriceIdMonthly
      }),
    );

    const result = await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).not.toHaveBeenCalled();
    // And it does not even ask, so no provider call is spent on a settled swap.
    expect(previewPlanChangeMock).not.toHaveBeenCalled();
  });

  it("a retry whose grant never landed raises it rather than reporting success", async () => {
    // The discriminating case is the credit ledger, not "a function was
    // skipped": the operation looks complete from the outside, so the only
    // evidence that the first attempt died mid-way is the absent grant.
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(hasPlanUpgradeGrantMock).toHaveBeenCalledWith(
      "org-abc",
      SCALE_PLAN.id,
      expect.anything(),
    );
    const raised = loggerMock.error.mock.calls.find((c) =>
      String(c[1]).includes("prorated credit grant is missing"),
    );
    expect(raised).toBeDefined();
  });

  it("a retry finishes the grant the first attempt never reached", async () => {
    // The defect this is keyed on is a WRONG VALUE, not a crash: the retry
    // returned null and logged success while the customer sat on the new plan
    // with none of its included credits. So the assertion is on the grant
    // actually being issued, for the plan actually moved from — which is
    // `pendingUpgradeFromPlanId`, not `planId`. `planId` already reads
    // "scale" here, because the sync that ran as part of the first attempt
    // repointed it at the target; granting scale → scale is a delta of zero
    // and grants nothing, which is precisely the silent no-op this replaced.
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
        pendingUpgradeFromPlanId: "plan-build-id",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-build-id",
      SCALE_PLAN.id,
    );
    // And the provider is still not asked to swap anything.
    expect(upgradeSubscriptionMock).not.toHaveBeenCalled();
    // Settled work retires its intent, so the next retry does not re-run it.
    expect(subscriptionUpdates).toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
  });

  it("a retry whose grant already landed does not grant a second time", async () => {
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
        pendingUpgradeFromPlanId: "plan-build-id",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(grantProratedPlanUpgradeCreditsMock).not.toHaveBeenCalled();
    // The intent is retired anyway — its work is done.
    expect(subscriptionUpdates).toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
  });

  it("a resumed grant that fails leaves the intent standing for the next retry", async () => {
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    grantProratedPlanUpgradeCreditsMock.mockRejectedValue(
      new Error("ledger unavailable"),
    );
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
        pendingUpgradeFromPlanId: "plan-build-id",
      }),
    );

    await expect(
      changeOrgPlan("org-abc", "scale-v2", "month"),
    ).resolves.toBeNull();

    // Clearing it would make the customer's missing credits unrecoverable —
    // the one record of the plan they moved from would be gone.
    expect(subscriptionUpdates).not.toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
    grantProratedPlanUpgradeCreditsMock.mockResolvedValue(undefined);
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
  });

  it("a retry whose grant did land reports nothing", async () => {
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    const raised = loggerMock.error.mock.calls.find((c) =>
      String(c[1]).includes("prorated credit grant is missing"),
    );
    expect(raised).toBeUndefined();
  });

  it("a grant check that itself fails is reported, not swallowed", async () => {
    hasPlanUpgradeGrantMock.mockRejectedValue(new Error("db unavailable"));
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_scale_m",
      }),
    );

    // The retry still succeeds — the swap really is done — but not knowing
    // whether the grant landed is itself worth saying out loud.
    await expect(
      changeOrgPlan("org-abc", "scale-v2", "month"),
    ).resolves.toBeNull();
    const raised = loggerMock.error.mock.calls.find((c) =>
      String(c[1]).includes("could not determine whether the prorated credit"),
    );
    expect(raised).toBeDefined();
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
  });

  it("records the plan being left before the provider is asked to swap it", async () => {
    // Order is the whole point. `upgradeSubscription` syncs the subscription
    // synchronously, and that sync repoints planId at the target — so a record
    // written afterwards would record the destination, and the window it
    // exists to close would still be open.
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(subscriptionUpdates[0]).toMatchObject({
      pendingUpgradeFromPlanId: "plan-enterprise-id",
    });
    expect(dbMocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      upgradeSubscriptionMock.mock.invocationCallOrder[0] as number,
    );
    // Once the grant lands, the intent is retired.
    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-enterprise-id",
      SCALE_PLAN.id,
    );
    expect(subscriptionUpdates).toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
  });

  it("a grant that fails after the swap leaves the intent for a retry to finish", async () => {
    grantProratedPlanUpgradeCreditsMock.mockRejectedValue(
      new Error("ledger unavailable"),
    );
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    // The swap is real and must not be undone by a failed grant…
    await expect(
      changeOrgPlan("org-abc", "scale-v2", "month"),
    ).resolves.toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalled();
    // …but the origin plan stays recorded, because the credits are still owed.
    expect(subscriptionUpdates).not.toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
    grantProratedPlanUpgradeCreditsMock.mockResolvedValue(undefined);
  });

  it("a subscription on a different price is still swapped", async () => {
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("a row with no recorded price id is swapped rather than assumed settled", async () => {
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-enterprise-id", stripePriceId: null }),
    );

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalled();
  });
});

describe("createCheckoutSession — active subscription guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubInsertChain();
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
