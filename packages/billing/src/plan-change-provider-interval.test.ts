/**
 * The interval a plan change moves FROM, and the amount the customer is asked
 * for — both taken from the provider, end to end through the real adapter.
 *
 * WHY THIS FILE EXISTS.
 *
 * Two things this path used to read from somewhere other than the money:
 *
 *  1. THE INTERVAL IT IS MOVING FROM. `subscriptions.billing_interval` is
 *     written by the sync that runs AFTER the provider mutation, so the one
 *     failure the already-applied guard exists to survive — a swap that
 *     reached Stripe and whose response was lost — is exactly the one that
 *     leaves the column describing the OLD subscription. After an unrecorded
 *     monthly→annual swap the column still says `month`, so an annual→monthly
 *     move reads as same-interval, its negative proration reads as a
 *     downgrade, `none` is selected and the confirmation quotes $0 — while
 *     Stripe resets the billing-cycle anchor and invoices the new month.
 *
 *     The provider knows: `getSubscription` returns `billingInterval` off the
 *     live subscription's price. The already-applied guard had begun asking it
 *     for the price and throwing that field away (#3157, PR #3171 review).
 *
 *  2. THE AMOUNT. `invoice.total` is the invoice; `invoice.amount_due` is what
 *     Stripe will collect. A customer carrying a credit balance (a refund, an
 *     overpayment, a credit note) has the two disagree, and the interval-change
 *     branch quotes this figure as "charged now". The adapter already draws
 *     that distinction for real invoices — `stripeInvoiceToNeutral` maps
 *     `amount_due` — so quoting the total here overstated the collection by
 *     the customer's whole balance.
 *
 * Both go through the REAL Stripe adapter into the REAL decision, for the
 * reason `plan-change-proration-isolation.test.ts` gives: a canned preview
 * cannot fail either way, and a canned preview is how both halves passed while
 * the join was wrong.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Stripe SDK mock ──────────────────────────────────────────────────────────

const stripeMethods = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  invoices: { createPreview: vi.fn(), retrieve: vi.fn() },
  paymentMethods: { list: vi.fn(), detach: vi.fn() },
};

vi.mock("stripe", () => ({ default: vi.fn(() => stripeMethods) }));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_mock",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  }),
}));

// ── @oxagen/database mock ────────────────────────────────────────────────────

const dbQueryMocks = {
  plans: { findFirst: vi.fn() },
  subscriptions: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
  orgBillingSettings: { findFirst: vi.fn() },
};

const dbMocks = {
  query: dbQueryMocks,
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
    })),
  })),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
  })),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./grants", () => ({
  hasPlanUpgradeGrant: vi.fn().mockResolvedValue(true),
  grantProratedPlanUpgradeCredits: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER the mocks.
const { StripeProvider } = await import("./stripe-provider");
const { setBillingProvider, resetBillingProvider } = await import("./client");
const { changeOrgPlan, previewPlanChange } = await import("./subscriptions");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BUILD_PLAN = {
  id: "plan-build-id",
  slug: "build-v2",
  tier: "build",
  stripePriceIdMonthly: "price_build_m",
  stripePriceIdAnnual: "price_build_y",
  monthlyCents: 20_000,
  annualCents: 200_000,
  stripeProductId: "prod_build",
};

/** The credit for the unused part of the year — large, and negative. */
const UNUSED_ANNUAL_CREDIT_CENTS = -160_000;
/** The month the anchor reset raises, before any account balance. */
const NEW_MONTH_TOTAL_CENTS = 20_000;
/** A credit balance the customer is already carrying. */
const CUSTOMER_BALANCE_CENTS = -15_000;
/** What Stripe will actually collect: the invoice net of that balance. */
const COLLECTIBLE_CENTS = NEW_MONTH_TOTAL_CENTS + CUSTOMER_BALANCE_CENTS;

/**
 * The subscription as the PROVIDER reports it — on the annual price.
 *
 * `interval` is the field under test: it is what the local column would say if
 * the sync after the monthly→annual swap had landed, and does not.
 */
function stubProviderOnAnnual(): void {
  stripeMethods.subscriptions.retrieve.mockImplementation(async () => {
    const lastUpdate = stripeMethods.subscriptions.update.mock.calls.at(-1) as
      | [string, { items?: Array<{ price?: string }> }]
      | undefined;
    const swappedTo = lastUpdate?.[1]?.items?.[0]?.price;
    const onMonthly = swappedTo === "price_build_m";
    return {
      id: "sub_active_001",
      customer: "cus_001",
      metadata: { org_id: "org-abc" },
      status: "active",
      items: {
        data: [
          {
            id: "si_001",
            quantity: 1,
            price: {
              id: swappedTo ?? "price_build_y",
              recurring: { interval: onMonthly ? "month" : "year" },
              product: "prod_build",
            },
          },
        ],
      },
      current_period_start: 1_756_684_800,
      current_period_end: 1_788_220_800,
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
    };
  });
}

/**
 * The anchor-reset invoice: a big negative proration for the unused year, and
 * a non-proration line for the month now being invoiced.
 *
 * `total` is the invoice; `amount_due` is `total` plus the customer's balance,
 * which is how Stripe reports an account credit. They are deliberately
 * different numbers — that is the second half of this file.
 */
function stubAnchorResetPreview(): void {
  stripeMethods.invoices.createPreview.mockImplementation(
    async (args: { subscription_details?: { proration_date?: number } }) => {
      const anchor = args.subscription_details?.proration_date ?? 0;
      return {
        currency: "usd",
        total: NEW_MONTH_TOTAL_CENTS,
        amount_due: COLLECTIBLE_CENTS,
        lines: {
          data: [
            {
              proration: true,
              description: "Unused time on Build (annual)",
              amount: UNUSED_ANNUAL_CREDIT_CENTS,
              period: { start: anchor, end: anchor + 100 },
            },
            {
              proration: false,
              description: "Build — one month",
              amount: NEW_MONTH_TOTAL_CENTS,
              period: { start: anchor, end: anchor + 100 },
            },
          ],
        },
      };
    },
  );
}

/**
 * The local row, describing the subscription BEFORE the monthly→annual swap
 * whose sync was lost. Every column here is stale in exactly the way the
 * already-applied guard exists to survive.
 */
function stubStaleMonthlyRow(): void {
  dbQueryMocks.subscriptions.findFirst.mockResolvedValue({
    stripeSubscriptionId: "sub_active_001",
    stripeCustomerId: "cus_001",
    seatCount: 1,
    planId: BUILD_PLAN.id,
    billingInterval: "month",
    stripePriceId: "price_build_m",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    pendingUpgradeFromPlanId: null,
  });
}

function stubPlanLookups(): void {
  dbQueryMocks.plans.findFirst.mockReset();
  dbQueryMocks.plans.findFirst.mockResolvedValue(BUILD_PLAN);
}

/** The proration flag the swap was actually sent to Stripe with. */
function prorationBehaviorSent(): string | undefined {
  const lastUpdate = stripeMethods.subscriptions.update.mock.calls.at(-1) as
    | [string, { proration_behavior?: string }]
    | undefined;
  return lastUpdate?.[1]?.proration_behavior;
}

describe("a plan change whose local interval column is stale (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    stubProviderOnAnnual();
    stubAnchorResetPreview();
    stubStaleMonthlyRow();
    stubPlanLookups();
    stripeMethods.customers.retrieve.mockResolvedValue({
      id: "cus_001",
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    stripeMethods.subscriptions.update.mockResolvedValue(undefined);
  });

  it("measures the interval against the provider, so an unrecorded swap does not hide the anchor reset", async () => {
    const quote = await previewPlanChange("org-abc", "build-v2", "month");

    // The provider is on the ANNUAL price. Moving to monthly resets the
    // anchor and invoices a month, so something is owed now. Reading the
    // stale local column made this look same-interval, took the sign of the
    // negative proration, and quoted nothing.
    expect(quote.isCharge).toBe(true);
    expect(quote.amountCents).toBeGreaterThan(0);
    // The specific inversion: the credit for the unused year is not the quote.
    expect(quote.amountCents).not.toBe(0);
    expect(quote.amountCents).not.toBe(UNUSED_ANNUAL_CREDIT_CENTS);
  });

  it("bills the anchor reset under always_invoice rather than dropping it as 'none'", async () => {
    await changeOrgPlan("org-abc", "build-v2", "month");

    expect(stripeMethods.subscriptions.update).toHaveBeenCalledTimes(1);
    // `none` writes no proration line at all: the month the anchor reset
    // raises would be charged with nothing on the invoice to explain it, and
    // the credit for the unused year would be silently dropped.
    expect(prorationBehaviorSent()).toBe("always_invoice");
    expect(prorationBehaviorSent()).not.toBe("none");
  });

  it("asks the provider for the interval rather than trusting the synced column", async () => {
    await previewPlanChange("org-abc", "build-v2", "month");

    // The mechanism, asserted directly. Without this, a quote that came out
    // right for some other reason would pass above. The expand is what
    // `getSubscription` sends and the adapter's own preview does not, so this
    // pins the subscription READ rather than any retrieve at all.
    expect(stripeMethods.subscriptions.retrieve).toHaveBeenCalledWith(
      "sub_active_001",
      { expand: ["items.data.price.product"] },
    );
  });
});

describe("an interval-change quote against a customer carrying a balance (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    stubProviderOnAnnual();
    stubAnchorResetPreview();
    stubStaleMonthlyRow();
    stubPlanLookups();
    stripeMethods.customers.retrieve.mockResolvedValue({
      id: "cus_001",
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    stripeMethods.subscriptions.update.mockResolvedValue(undefined);
  });

  it("quotes what Stripe will collect, not the invoice before the balance", async () => {
    const quote = await previewPlanChange("org-abc", "build-v2", "month");

    // `amount_due`, not `total`. The two differ by the credit balance sitting
    // on the account, and the screen this figure lands on says "charged now".
    expect(quote.amountCents).toBe(COLLECTIBLE_CENTS);
    expect(quote.amountCents).not.toBe(NEW_MONTH_TOTAL_CENTS);
    // Guard the fixture itself: a test where the two agree proves nothing.
    expect(COLLECTIBLE_CENTS).not.toBe(NEW_MONTH_TOTAL_CENTS);
  });

  it("still calls it a charge when the balance only reduces the collection", async () => {
    const quote = await previewPlanChange("org-abc", "build-v2", "month");

    expect(quote.isCharge).toBe(true);
    expect(quote.amountCents).toBeGreaterThan(0);
  });
});

// Leave the singleton as this file found it.
afterEach(() => {
  resetBillingProvider();
});
