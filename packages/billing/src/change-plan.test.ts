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
    plan: { tier: string };
  }> = {},
) {
  return {
    stripeSubscriptionId: "sub_active_001",
    seatCount: 1,
    planId: "plan-build-id",
    billingInterval: "month",
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
    // $199/mo → $999/mo: the bill rises, so the proration is invoiced now.
    expect(SCALE_CATALOG.monthlyCents).toBeGreaterThan(
      BUILD_CATALOG.monthlyCents,
    );
    stubPlanLookups(SCALE_PLAN, BUILD_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-build-id" }),
    );

    const result = await changeOrgPlan("org-abc", "scale", "month");

    expect(result).toBeNull(); // swap in-place, no checkout URL
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("downgrade (scale → build) → calls upgradeSubscription with 'none'", async () => {
    // $999/mo → $199/mo: the bill falls, so no proration line is written.
    stubPlanLookups(BUILD_PLAN, SCALE_PLAN);

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

// ── #3157: proration follows price, not the entitlement tier rank ───────────
//
// TIER_ORDER ranks Enterprise above Scale because Enterprise holds the SOC2
// entitlements (ACLs, SSO, SCIM, immutable audit). The catalogue prices it
// below Scale. Every assertion below states the price it depends on, so a
// reprice fails here loudly instead of quietly flipping a branch.

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
      seatCount: 1,
    });
    const upsertChain = {
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    dbMocks.insert.mockReturnValue({
      values: vi.fn().mockReturnValue(upsertChain),
    });
  });

  it("the catalogue prices Enterprise below Scale — the premise of the two tests that follow", () => {
    expect(ENTERPRISE_CATALOG.monthlyCents).toBe(50_000); // $500/mo
    expect(SCALE_CATALOG.monthlyCents).toBe(99_900); // $999/mo
    expect(SCALE_CATALOG.monthlyCents).toBeGreaterThan(
      ENTERPRISE_CATALOG.monthlyCents,
    );
    // …while the entitlement rank puts Enterprise on top. The disagreement is
    // the whole defect: one ordering cannot answer both questions.
    expect(ENTERPRISE_PLAN.tier).toBe("enterprise");
    expect(SCALE_PLAN.tier).toBe("scale");
  });

  it("enterprise → scale ($500/mo → $999/mo, the bill doubles) → 'always_invoice'", async () => {
    expect(ENTERPRISE_CATALOG.monthlyCents).toBe(50_000);
    expect(SCALE_CATALOG.monthlyCents).toBe(99_900);

    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        billingInterval: "month",
      }),
    );

    const result = await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("scale → enterprise ($999/mo → $500/mo, the bill halves) → 'none'", async () => {
    expect(SCALE_CATALOG.monthlyCents).toBe(99_900);
    expect(ENTERPRISE_CATALOG.monthlyCents).toBe(50_000);

    stubPlanLookups(ENTERPRISE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-scale-id", billingInterval: "month" }),
    );

    const result = await changeOrgPlan("org-abc", "enterprise-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("same plan, same interval (the bill does not move) → 'none'", async () => {
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-scale-id", billingInterval: "month" }),
    );

    const result = await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("scale monthly → scale annual ($999 → $9,990 on the next invoice) → 'always_invoice'", async () => {
    // One plan, two intervals. The per-month rate falls (two months free) and
    // the amount the next invoice carries rises, and it is the invoice the
    // proration flag governs.
    expect(SCALE_CATALOG.monthlyCents).toBe(99_900);
    expect(SCALE_CATALOG.annualCents).toBe(999_000);

    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-scale-id", billingInterval: "month" }),
    );

    const result = await changeOrgPlan("org-abc", "scale-v2", "year");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("build annual → build monthly (the next invoice falls) → 'none'", async () => {
    expect(BUILD_CATALOG.annualCents).toBe(199_000);
    expect(BUILD_CATALOG.monthlyCents).toBe(19_900);

    stubPlanLookups(BUILD_PLAN, BUILD_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-build-id", billingInterval: "year" }),
    );

    const result = await changeOrgPlan("org-abc", "build-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("a current plan with no resolvable price settles as 'always_invoice' rather than dropping the money", async () => {
    // A plan row billed annually that carries no annual price, and no
    // catalogue slug to fall back to. Stripe computes the real difference
    // under always_invoice and settles it either way; 'none' is the branch
    // that would lose it.
    const unpricedCurrent = {
      id: "plan-custom-id",
      slug: null,
      tier: "scale",
      stripePriceIdMonthly: "price_custom_m",
      stripePriceIdAnnual: null,
      monthlyCents: null,
      annualCents: null,
    };
    stubPlanLookups(ENTERPRISE_PLAN, unpricedCurrent);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({ planId: "plan-custom-id", billingInterval: "year" }),
    );

    await changeOrgPlan("org-abc", "enterprise-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
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
