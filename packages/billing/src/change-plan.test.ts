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
/**
 * @param billingInterval The interval of the subscription THIS preview was
 * computed against — the field the adapter now carries back so the interval
 * comparison never straddles two provider reads. Monthly unless a test says
 * otherwise, matching {@link stubProviderSubscription}. A test that wants the
 * two to DISAGREE sets this and leaves the `getSubscription` stub alone; that
 * is the concurrent-update interleaving, and the fixture can express it
 * because the two are separate mocks.
 */
function previewingProration(
  amountCents: number,
  billingInterval: "month" | "year" = "month",
) {
  // A mockImplementation, not a fixed value, so the state the preview REPORTS
  // tracks the state the fixture has the provider in — which is what the real
  // adapter does, since it reads both off one response. A frozen payload would
  // let a test describe a preview of a subscription that is not the one the
  // rest of the fixture says exists.
  previewPlanChangeMock.mockImplementation(async () => ({
    amountCents,
    isCharge: amountCents > 0,
    currency: "usd",
    prorationDate: 1_700_000_000,
    totalCents: amountCents,
    // What the provider would collect. Equal to the total here: none of these
    // cases give the customer an account balance.
    amountDueCents: amountCents,
    billingInterval,
    // The subscription this preview priced: the one it is moving FROM. The
    // price binds the swap that follows; the product names the plan the
    // credit grant is sized from.
    billingPriceId: providerActivePriceId,
    billingProductId: currentProviderProduct(providerActivePriceId),
    lines: [],
  }));
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
  stripeProductId: "prod_build",
  monthlyCents: BUILD_CATALOG.monthlyCents,
  annualCents: BUILD_CATALOG.annualCents,
};
const SCALE_PLAN = {
  id: "plan-scale-id",
  slug: SCALE_CATALOG.slug,
  tier: "scale",
  stripePriceIdMonthly: "price_scale_m",
  stripePriceIdAnnual: "price_scale_y",
  stripeProductId: "prod_scale",
  monthlyCents: SCALE_CATALOG.monthlyCents,
  annualCents: SCALE_CATALOG.annualCents,
};
const ENTERPRISE_PLAN = {
  id: "plan-enterprise-id",
  slug: ENTERPRISE_CATALOG.slug,
  tier: "enterprise",
  stripePriceIdMonthly: "price_enterprise_m",
  stripePriceIdAnnual: "price_enterprise_y",
  stripeProductId: "prod_enterprise",
  monthlyCents: ENTERPRISE_CATALOG.monthlyCents,
  annualCents: ENTERPRISE_CATALOG.annualCents,
};

type PlanRow = {
  id: string;
  slug: string;
  stripeProductId?: string;
  stripePriceIdMonthly?: string | null;
  stripePriceIdAnnual?: string | null;
  [key: string]: unknown;
};

const ALL_PLANS: PlanRow[] = [BUILD_PLAN, SCALE_PLAN, ENTERPRISE_PLAN];

/**
 * The product a price belongs to, as the catalogue records it.
 *
 * A subscription's product FOLLOWS its price at the provider — they are two
 * fields of one item, not two independent facts — so the fixture derives one
 * from the other rather than letting a test set them apart by accident. The
 * grant origin is resolved by product, so a fixture whose product drifted from
 * its price would quietly grant from the wrong plan.
 */
function productForPrice(priceId: string | null): string | undefined {
  return ALL_PLANS.find(
    (plan) =>
      plan.stripePriceIdMonthly === priceId ||
      plan.stripePriceIdAnnual === priceId,
  )?.stripeProductId;
}

/**
 * The product the PROVIDER reports for a price it does not recognise from the
 * catalogue — which is the normal state of a grandfathered subscriber, sitting
 * on an immutable old price of a product that still exists.
 *
 * Set by {@link stubProviderSubscription} and read by the preview stub too, so
 * the subscription the preview reports and the subscription `getSubscription`
 * reports cannot drift apart on this field. In the real adapter both come off
 * the same object; a fixture where they differ describes something that cannot
 * happen.
 */
let providerProductFallback = "prod_build";

function currentProviderProduct(priceId: string | null): string {
  return productForPrice(priceId) ?? providerProductFallback;
}

/**
 * The column and value a `findFirst` was actually filtered on.
 *
 * Drizzle's `eq(col, value)` keeps both in `queryChunks`, so a fixture can
 * answer the query it was ASKED rather than the query the test author happened
 * to expect Nth. That distinction is the point of this helper: a positional
 * `mockResolvedValueOnce` chain cannot represent "this product maps to no
 * plan", and it silently answers the wrong row the moment a call is added or
 * removed anywhere upstream — which is the class of fixture that hid three
 * findings on #3238 and three on #3187.
 */
function whereFacts(where: unknown): { column?: string; value?: unknown } {
  const chunks =
    (where as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  let column: string | undefined;
  let value: unknown;
  for (const chunk of chunks) {
    const c = chunk as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object") continue;
    if (typeof c.name === "string" && "notNull" in c) column = c.name;
    else if ("encoder" in c) value = c.value;
  }
  return { column, value };
}

/**
 * `billing.plans`, answering by predicate.
 *
 * changeOrgPlan reads it by slug (the target), by id (the plan the org is on,
 * for the log line) and by stripe_product_id (the plan the PROVIDER says this
 * subscription is moving from, which is what sizes the credit grant), and
 * `syncSubscriptionFromStripe` reads it by product too. Any plan not in
 * `catalog` is genuinely absent — which is how "a grandfathered product no
 * catalogue row carries" is expressed.
 */
function stubCatalog(catalog: PlanRow[] = ALL_PLANS) {
  dbQueryMocks.plans.findFirst.mockImplementation(
    (args: { where?: unknown } = {}) => {
      const { column, value } = whereFacts(args.where);
      const found = catalog.find((plan) => {
        if (column === "slug") return plan.slug === value;
        if (column === "id") return plan.id === value;
        if (column === "stripe_product_id")
          return plan.stripeProductId === value;
        return false;
      });
      return Promise.resolve(found);
    },
  );
}

/**
 * Which price the PROVIDER reports the subscription as being on, before any
 * swap this test issues. The local `stripe_price_id` column is a cache of the
 * last sync; the already-applied guard asks the provider, because the one
 * failure it exists to survive — a swap that reached Stripe and whose
 * response was lost — is exactly the one that leaves the cache stale.
 *
 * They are therefore two different stubs on purpose, and {@link onPrice} sets
 * both so a test does not accidentally describe a subscription that cannot
 * exist. A test that wants them to DISAGREE (the lost-sync case) sets them
 * apart deliberately.
 */
let providerActivePriceId: string | null = "price_build_m";

/**
 * The provider's view of the subscription, which reports the NEW price once a
 * swap has been issued — as the real one does. Static stubs could not express
 * that: the same call is made before the swap (to decide whether it already
 * happened) and after it (by the sync), and those two want different answers.
 */
function stubProviderSubscription(fallbackProductId: string) {
  providerProductFallback = fallbackProductId;
  getSubscriptionMock.mockImplementation(async () => {
    const priceId =
      upgradeSubscriptionMock.mock.calls.length > 0
        ? ((
            upgradeSubscriptionMock.mock.calls.at(-1)?.[1] as
              | { newPriceId?: string }
              | undefined
          )?.newPriceId ?? providerActivePriceId)
        : providerActivePriceId;
    return {
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
      // Derived from the price, never set apart from it — see
      // currentProviderProduct, which the preview stub uses too.
      productId: currentProviderProduct(priceId),
      priceId,
      seatCount: 1,
    };
  });
}

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
 * Put the subscription on a price in BOTH places that answer for it — the
 * local row and the provider — because in production they are two sources and
 * only one of them is authoritative. Setting only the local one describes a
 * subscription that does not exist, which is what the fixtures did before the
 * guard started asking the provider.
 */
function onPrice(
  priceId: string | null,
  overrides: Parameters<typeof makeActiveSub>[0] = {},
) {
  providerActivePriceId = priceId;
  dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
    makeActiveSub({ stripePriceId: priceId, ...overrides }),
  );
}

/**
 * The plans a test wants to exist, answered by predicate rather than by call
 * order — see {@link stubCatalog}. The arguments name which rows matter to the
 * test; every plan in the catalogue is reachable by whichever key the code
 * actually looks it up with.
 */
function stubPlanLookups(target: PlanRow, current: PlanRow) {
  // The rows the test named come FIRST, so a test that defines its own
  // catalogue entry (a grandfathered price, a plan under a slug the standard
  // three do not use) wins over a standing row with the same key.
  const catalog: PlanRow[] = [target, current];
  for (const plan of ALL_PLANS) {
    if (!catalog.some((p) => p.id === plan.id)) catalog.push(plan);
  }
  stubCatalog(catalog);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("changeOrgPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // syncSubscriptionFromStripe uses billingProvider().getSubscription and db().insert
    stubProviderSubscription("prod_build");
    // Answered by predicate: the sync looks up by stripe_product_id, the
    // change looks up the target by slug and the origin by product.
    stubCatalog();
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
    onPrice("price_build_m", {
      planId: "plan-build-id",
      stripePriceId: "price_build_m",
    });

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
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      stripePriceId: "price_scale_m",
    });

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
    stubProviderSubscription("prod_scale");
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
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("scale → enterprise: the preview says the bill falls, and the tier rank says upgrade", async () => {
    previewingProration(-49_900);
    stubPlanLookups(ENTERPRISE_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      stripePriceId: "price_scale_m",
    });

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
    onPrice("price_list_200", {
      planId: "plan-list200-id",
      stripePriceId: "price_list_200",
    });

    await changeOrgPlan("org-abc", "mid-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("a change that moves no money ships 'none'", async () => {
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    onPrice("price_other", { planId: "plan-scale-id" });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "none" }),
    );
  });

  it("monthly → annual on one plan is whatever the invoice says, not what the rates suggest", async () => {
    // The per-month rate falls (two months free) and the next invoice rises.
    previewingProration(899_100, "month");
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      billingInterval: "month",
      stripePriceId: "price_scale_m",
    });

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
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("the preview is taken under create_prorations, so asking the question charges nobody", async () => {
    previewingProration(1_000);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

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
    // == SCALE_PLAN.stripePriceIdMonthly
    onPrice("price_scale_m", { planId: "plan-scale-id" });

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
    //
    // The fixture used to put the row ON the target price with no intent —
    // which is not a retry at all, it is somebody submitting the plan they are
    // already on. Grant recovery no longer runs there, and asserting that it
    // did was asserting the defect: a steady-state request telling an operator
    // to repair credits by hand (#3157, PR #3171 review). The `else` branch
    // under test is reached by a real swap that predates the intent column, so
    // the row is STALE and the provider has moved — which is what that branch
    // means by "no origin plan was recorded".
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-scale-id",
        stripePriceId: "price_build_m", // stale: a swap we never wrote down
        pendingUpgradeFromPlanId: null, // ...and one predating the intent
      }),
    );
    providerActivePriceId = "price_scale_m";

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
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      pendingUpgradeFromPlanId: "plan-build-id",
    });

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
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      pendingUpgradeFromPlanId: "plan-build-id",
    });

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
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      pendingUpgradeFromPlanId: "plan-build-id",
    });

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

  it("a swap the provider applied but our sync never recorded is not swapped again", async () => {
    // The guard used to read `subscriptions.stripe_price_id`, which is written
    // by the sync that runs AFTER the provider mutation — so it was blind to
    // the one failure it exists for. Provider swapped, DB write lost: the
    // local row still says the old price, the retry re-issues the update as
    // `none` under the key the first attempt used with `always_invoice`, and
    // Stripe rejects the reused key. Every retry then fails identically.
    //
    // Local and provider deliberately DISAGREE here — that is the state under
    // test, not a fixture mistake.
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m", // stale: the sync never landed
        pendingUpgradeFromPlanId: "plan-enterprise-id",
      }),
    );
    providerActivePriceId = "price_scale_m"; // the provider already moved

    const result = await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(result).toBeNull();
    expect(upgradeSubscriptionMock).not.toHaveBeenCalled();
    // And the post-swap work still happens: the credits are owed either way.
    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-enterprise-id",
      SCALE_PLAN.id,
    );
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
  });

  it("the stale row left by the lost sync is repaired rather than left wrong", async () => {
    // Detecting it is not enough — the row would otherwise keep reporting the
    // wrong plan and price to every later read.
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    dbQueryMocks.subscriptions.findFirst.mockResolvedValue(
      makeActiveSub({
        planId: "plan-enterprise-id",
        stripePriceId: "price_enterprise_m",
      }),
    );
    providerActivePriceId = "price_scale_m";

    await changeOrgPlan("org-abc", "scale-v2", "month");

    // syncSubscriptionFromStripe upserts the subscription row.
    expect(dbMocks.insert).toHaveBeenCalled();
    const warned = loggerMock.warn.mock.calls.find((c) =>
      String(c[1]).includes("still holds the previous price"),
    );
    expect(warned).toBeDefined();
  });

  it("a retry whose grant did land reports nothing", async () => {
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      stripePriceId: "price_scale_m",
    });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    const raised = loggerMock.error.mock.calls.find((c) =>
      String(c[1]).includes("prorated credit grant is missing"),
    );
    expect(raised).toBeUndefined();
  });

  it("a grant check that itself fails is reported, not swallowed", async () => {
    // A standing intent is what makes this a resumed mutation rather than a
    // no-op; without one the ledger is never asked, because there is no
    // upgrade whose grant could be missing.
    hasPlanUpgradeGrantMock.mockRejectedValue(new Error("db unavailable"));
    previewingProration(0);
    stubPlanLookups(SCALE_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", {
      planId: "plan-scale-id",
      stripePriceId: "price_scale_m",
      pendingUpgradeFromPlanId: "plan-build-id",
    });

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

  it("a swap whose preview failed still grants the credits the upgrade earns", async () => {
    // A preview that could not be taken returns direction "unknown", which is
    // not an answer to "did the allowance go up". Gating the grant on it meant
    // a transient provider blip followed by a real Build→Scale swap charged
    // the customer and withheld the credits — then cleared the durable intent,
    // so the retry path built this round could not repair it either.
    //
    // Keyed on the VALUE: the grant must be called with the origin plan, and
    // the change must still be billed as always_invoice.
    previewPlanChangeMock.mockRejectedValue(new Error("stripe unavailable"));
    stubPlanLookups(SCALE_PLAN, BUILD_PLAN);
    onPrice("price_build_m", { planId: "plan-build-id" });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({
        newPriceId: "price_scale_m",
        prorationBehavior: "always_invoice",
      }),
    );
    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-build-id",
      SCALE_PLAN.id,
    );
    // Settled, so the intent is retired rather than left to a retry.
    expect(subscriptionUpdates).toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: null }),
    );
  });

  it("a downgrade is offered to the grant too, and the grant declines it", async () => {
    // The grant is delta-guarded, so the caller does not need to pre-judge
    // which moves earn credits — and pre-judging is what went wrong. This
    // pins that the decision now sits with the delta.
    previewingProration(-80_000);
    stubPlanLookups(BUILD_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", { planId: "plan-scale-id" });

    // `BUILD_PLAN.slug`, not the literal "build". The catalogue now answers the
    // query it was asked, so a slug no plan carries is correctly not found —
    // the positional mock this replaced returned the target plan for any slug
    // at all, which is how a wrong argument went unnoticed here.
    await changeOrgPlan("org-abc", BUILD_PLAN.slug, "month");

    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-scale-id",
      BUILD_PLAN.id,
    );
  });

  it("records the plan being left before the provider is asked to swap it", async () => {
    // Order is the whole point. `upgradeSubscription` syncs the subscription
    // synchronously, and that sync repoints planId at the target — so a record
    // written afterwards would record the destination, and the window it
    // exists to close would still be open.
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

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
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

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
    onPrice("price_enterprise_m", {
      planId: "plan-enterprise-id",
      stripePriceId: "price_enterprise_m",
    });

    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({ prorationBehavior: "always_invoice" }),
    );
  });

  it("a row with no recorded price id is swapped rather than assumed settled", async () => {
    previewingProration(49_900);
    stubPlanLookups(SCALE_PLAN, ENTERPRISE_PLAN);
    onPrice(null, { planId: "plan-enterprise-id" });

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

// ---------------------------------------------------------------------------
// The preview decided one transition; the provider applies it to whatever the
// subscription is when the update lands (#3157, PR #3171 review, r4042477836
// and r4042477853).
//
// The window inside one adapter call is closed. These are the next two
// boundaries outward, and both carry a value taken before the preview or from
// it and act on it afterwards.
//
// THE FIXTURE CAN REPRESENT BOTH INTERLEAVINGS. `previewPlanChangeMock` and
// `getSubscriptionMock` are independent stubs, and the provider's reported
// price is a variable the test can move BETWEEN calls — so "a plan update
// landed after the preview and before the swap" is a state this mock is
// genuinely in, not one it merely fails to rule out.
// ---------------------------------------------------------------------------

describe("a plan update landing between the preview and the swap (r4042477836)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionUpdates.length = 0;
    grantProratedPlanUpgradeCreditsMock.mockResolvedValue(undefined);
    // `vi.clearAllMocks()` empties the call log and leaves IMPLEMENTATIONS in
    // place, so a test that makes the swap throw would otherwise poison every
    // test after it. Reset the behaviour, not just the history.
    upgradeSubscriptionMock.mockReset();
    upgradeSubscriptionMock.mockResolvedValue(undefined);
    stubProviderSubscription("prod_build");
    stubCatalog();
    stubInsertChain();
  });

  it("refuses the swap when the subscription has left the price that was priced", async () => {
    // Previewed as a decrease off Scale. The preview reports the subscription
    // it priced — Scale — and `none` is selected because the bill falls.
    previewingProration(-40_000);
    stubPlanLookups(BUILD_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", { planId: "plan-scale-id" });

    // Now the concurrent update lands: by the time the swap is issued, the
    // subscription is on Enterprise. The move being applied is no longer the
    // move that was priced, and `none` carried onto it drops a real charge.
    upgradeSubscriptionMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error("moved"), {
        code: "SUBSCRIPTION_MOVED_SINCE_PREVIEW",
      });
    });

    await expect(
      changeOrgPlan("org-abc", BUILD_PLAN.slug, "month"),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_MOVED_SINCE_PREVIEW" });
  });

  it("hands the swap the price the decision was made against", async () => {
    // The mechanism. The adapter cannot check a precondition it was never
    // given, so what is pinned is that the priced state travels with the
    // mutation rather than being left behind with the preview.
    previewingProration(-40_000);
    stubPlanLookups(BUILD_PLAN, SCALE_PLAN);
    onPrice("price_scale_m", { planId: "plan-scale-id" });

    await changeOrgPlan("org-abc", BUILD_PLAN.slug, "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({
        prorationBehavior: "none",
        expectedCurrentPriceId: "price_scale_m",
      }),
    );
  });

  it("binds nothing when there was no preview, because there is no 'none' to protect", async () => {
    // An unpriceable change settles as always_invoice, which bills the true
    // difference whichever way it falls. Refusing it on a precondition would
    // trade a safe outcome for an outage, which is the trade this file has
    // already rejected once.
    previewPlanChangeMock.mockRejectedValue(new Error("stripe unavailable"));
    stubPlanLookups(SCALE_PLAN, BUILD_PLAN);
    onPrice("price_build_m", { planId: "plan-build-id" });

    await changeOrgPlan("org-abc", SCALE_PLAN.slug, "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalledWith(
      "sub_active_001",
      expect.objectContaining({
        prorationBehavior: "always_invoice",
        expectedCurrentPriceId: undefined,
      }),
    );
  });
});

describe("the plan a change moves FROM, when the local row disagrees (r4042477853)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptionUpdates.length = 0;
    grantProratedPlanUpgradeCreditsMock.mockResolvedValue(undefined);
    // `vi.clearAllMocks()` empties the call log and leaves IMPLEMENTATIONS in
    // place, so a test that makes the swap throw would otherwise poison every
    // test after it. Reset the behaviour, not just the history.
    upgradeSubscriptionMock.mockReset();
    upgradeSubscriptionMock.mockResolvedValue(undefined);
    stubProviderSubscription("prod_build");
    stubCatalog();
    stubInsertChain();
  });

  it("sizes the grant from the provider's plan, not the stale row", async () => {
    // The lost-sync case this branch exists for: the provider already moved
    // this subscription to Scale and the row still says Build. A move to
    // Enterprise is a SCALE→Enterprise step; granting it as BUILD→Enterprise
    // credits an allowance step the customer already has.
    previewingProration(49_900);
    stubPlanLookups(ENTERPRISE_PLAN, BUILD_PLAN);
    onPrice("price_scale_m", {
      // The row is stale in both columns, exactly as a lost sync leaves it.
      planId: "plan-build-id",
      stripePriceId: "price_build_m",
    });

    await changeOrgPlan("org-abc", ENTERPRISE_PLAN.slug, "month");

    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-scale-id",
      ENTERPRISE_PLAN.id,
    );
    // The defect's output, named so a regression cannot read as a pass.
    expect(grantProratedPlanUpgradeCreditsMock).not.toHaveBeenCalledWith(
      "org-abc",
      "plan-build-id",
      ENTERPRISE_PLAN.id,
    );
  });

  it("records the provider's origin on the durable intent, so a retry finishes it correctly", async () => {
    // The intent is what a retry reads after a crash. Writing the stale row
    // into it would carry this defect across the crash it exists to survive.
    previewingProration(49_900);
    stubPlanLookups(ENTERPRISE_PLAN, BUILD_PLAN);
    onPrice("price_scale_m", {
      planId: "plan-build-id",
      stripePriceId: "price_build_m",
    });

    await changeOrgPlan("org-abc", ENTERPRISE_PLAN.slug, "month");

    expect(subscriptionUpdates).toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: "plan-scale-id" }),
    );
    expect(subscriptionUpdates).not.toContainEqual(
      expect.objectContaining({ pendingUpgradeFromPlanId: "plan-build-id" }),
    );
  });

  it("resolves a grandfathered subscriber by product, whose price no catalogue row carries", async () => {
    // The discriminating negative for the choice of key. Resolving the origin
    // by PRICE would fail here — this subscriber sits on an immutable old
    // price that was never in `billing.plans` — and the code would then either
    // skip a grant that is owed or fall back to the stale row. The product is
    // what survives a reprice, which is why `syncSubscriptionFromStripe`
    // already keys on it.
    previewingProration(49_900);
    stubProviderSubscription("prod_scale");
    stubPlanLookups(ENTERPRISE_PLAN, BUILD_PLAN);
    onPrice("price_scale_m_legacy_2021", { planId: "plan-build-id" });

    await changeOrgPlan("org-abc", ENTERPRISE_PLAN.slug, "month");

    expect(grantProratedPlanUpgradeCreditsMock).toHaveBeenCalledWith(
      "org-abc",
      "plan-scale-id",
      ENTERPRISE_PLAN.id,
    );
  });

  it("skips the grant rather than sizing it from a source known to be wrong", async () => {
    // The provider reports a PRODUCT no catalogue row carries, so the plan
    // being left cannot be established. The stale column is RIGHT THERE and is
    // deliberately not used: granting from it sends credits out of the door,
    // while skipping leaves a loud log and a standing intent to repair.
    //
    // Note this is an unknown product, not merely an unknown price. A
    // grandfathered subscriber sits on an immutable OLD PRICE of a product the
    // catalogue still carries, which is exactly why the origin is resolved by
    // product — that case resolves fine and is not this one.
    previewingProration(49_900);
    stubProviderSubscription("prod_not_in_catalogue");
    stubPlanLookups(ENTERPRISE_PLAN, BUILD_PLAN);
    onPrice("price_outside_catalogue", { planId: "plan-build-id" });

    await changeOrgPlan("org-abc", ENTERPRISE_PLAN.slug, "month");

    expect(upgradeSubscriptionMock).toHaveBeenCalled();
    expect(grantProratedPlanUpgradeCreditsMock).not.toHaveBeenCalled();
  });
});
