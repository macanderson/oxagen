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
 *     The provider knows. The first fix for this had the caller issue its own
 *     `getSubscription` and hand the comparison down as a boolean — which
 *     traded a stale column for a SECOND provider read of the same
 *     subscription, with nothing holding it and the preview to one
 *     observation. The interval now comes back ON the preview, off the
 *     retrieval that priced it, and the caller passes only the interval it is
 *     asking for. See the last describe in this file for what the two-read
 *     form cost (#3157, PR #3171 review, r4042249142).
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

  it("takes the interval off the subscription the preview priced, not off the synced column", async () => {
    await previewPlanChange("org-abc", "build-v2", "month");

    // The mechanism, asserted directly. Without this, a quote that came out
    // right for some other reason would pass above.
    //
    // It used to be asserted as "`getSubscription` was called" — the expanded
    // retrieve that the adapter's own preview does not send. That pinned the
    // wrong mechanism: a SECOND read of the subscription is precisely what
    // this path must not take, because it and the preview can describe
    // different subscriptions (r4042249142). So what is pinned now is that
    // the subscription was retrieved AT ALL — by the preview — and that the
    // annual interval it reports is what the quote was decided on, while the
    // local column saying `month` was not.
    expect(stripeMethods.subscriptions.retrieve).toHaveBeenCalledWith(
      "sub_active_001",
    );
    // `createPreview` is the call the decision is actually made from.
    expect(stripeMethods.invoices.createPreview).toHaveBeenCalled();
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

describe("a transient failure of the provider-state read (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    stubAnchorResetPreview();
    stubStaleMonthlyRow();
    stubPlanLookups();
    stripeMethods.customers.retrieve.mockResolvedValue({
      id: "cus_001",
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    stripeMethods.subscriptions.update.mockResolvedValue(undefined);
    // The provider is UP — only the authoritative state read fails.
    //
    // `getSubscription` is the call that passes `expand`; the adapter's own
    // preview retrieves the subscription bare to find the item id. Failing
    // only the expanded one models a transient failure of a single API call
    // rather than an outage, and that distinction is the whole finding: in an
    // outage the swap fails anyway, so the fallback costs nothing. Here
    // everything downstream SUCCEEDS, and the fallback is what lets the
    // operation proceed on the stale row.
    stripeMethods.subscriptions.retrieve.mockImplementation(
      async (_id: string, opts?: { expand?: string[] }) => {
        if (opts?.expand) throw new Error("503 from Stripe");
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
                  id: "price_build_y",
                  recurring: { interval: "year" },
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
      },
    );
  });

  it("quotes correctly from the preview when only the extra read fails, because it no longer takes one", async () => {
    // This used to assert a REFUSAL. The quote path issued its own expanded
    // `getSubscription` purely to learn the interval, so failing that one
    // call left it with nothing but the stale row — month, on the monthly
    // price — while the preview that followed succeeded against an annual
    // subscription. Refusing was the right answer to a question it should
    // never have been asking.
    //
    // It no longer asks: the interval arrives on the preview, off the same
    // retrieval that priced it (r4042249142). So a transient failure of a
    // call this path does not make cannot affect it, and the correct quote
    // is the one that now comes out — the anchor-reset invoice, from the
    // annual subscription the preview really was computed against.
    const quote = await previewPlanChange("org-abc", "build-v2", "month");

    expect(quote.isCharge).toBe(true);
    expect(quote.amountCents).toBe(COLLECTIBLE_CENTS);
    expect(quote.amountCents).not.toBe(0);
  });

  it("still refuses to quote when the PREVIEW itself cannot be taken", async () => {
    // The refusal that matters is preserved, and now keyed on the thing the
    // decision is actually made from. A provider that cannot price the change
    // yields no number, and a quote of $0 would promise the customer that
    // `always_invoice` will charge them nothing.
    stripeMethods.invoices.createPreview.mockRejectedValue(
      new Error("503 from Stripe"),
    );

    await expect(
      previewPlanChange("org-abc", "build-v2", "month"),
    ).rejects.toMatchObject({ code: "PLAN_CHANGE_PREVIEW_UNAVAILABLE" });
  });

  it("does not mutate a subscription whose state it could not confirm", async () => {
    await expect(
      changeOrgPlan("org-abc", "build-v2", "month"),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_STATE_UNAVAILABLE" });

    // The whole point. The read failed, the update would have succeeded, and
    // issuing it would have swapped a subscription on the strength of a row
    // the guard exists to distrust.
    expect(stripeMethods.subscriptions.update).not.toHaveBeenCalled();
  });

  it("fails before anything durable is written", async () => {
    await expect(
      changeOrgPlan("org-abc", "build-v2", "month"),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_STATE_UNAVAILABLE" });

    // The upgrade intent is written before the provider is touched, so a
    // refusal that came after it would leave an intent for a swap that never
    // happened.
    expect(dbMocks.update).not.toHaveBeenCalled();
  });
});

// Leave the singleton as this file found it.
afterEach(() => {
  resetBillingProvider();
});

// ---------------------------------------------------------------------------
// The finding this file was extended for: TWO provider reads of ONE
// subscription inside one logical operation (#3157, PR #3171 review,
// r4042249142).
//
// Every describe above puts the provider in ONE state and holds it there, so
// the interval read separately and the interval the preview was computed
// against always agreed. They agreed because nothing moved, not because
// anything held them together — which is exactly the thing a fixture can hide.
//
// Here they DISAGREE, because a concurrent plan update lands between them.
// `subscriptions.retrieve` is keyed on `expand`: the expanded call is
// `getSubscription`, the bare one is the adapter's own retrieval inside
// `previewPlanChange`. The expanded call answers MONTHLY; the update lands;
// every call after it — including the preview's — answers ANNUAL.
//
// THE FIXTURE CAN REPRESENT THE INTERLEAVING, and that is load-bearing. The
// two reads are distinguishable (only `getSubscription` passes `expand`) and
// the stub is an implementation rather than a fixed value, so "the
// subscription changed between the two reads" is a state this mock can be in.
// A stub that answered one interval to every caller could not express it, and
// a test built on one would pass against the defect.
//
// What it costs when nothing holds them together: the request asks for
// monthly, the separately-read interval says monthly, so the change scores as
// same-interval; the preview — computed on the ANNUAL subscription — nets
// negative, because it is the credit for the unused year; a negative net
// reads as a downgrade, which ships `none` and quotes $0. Stripe resets the
// billing-cycle anchor on an interval change regardless of the proration flag
// and invoices the new month immediately. The customer is told $0 and charged
// a month.
// ---------------------------------------------------------------------------

/**
 * A plan update landing between the two reads, moving the subscription from a
 * MONTHLY price to an ANNUAL one.
 *
 * Neither price is the one this request targets (`price_build_m`), so the
 * already-applied guard in `changeOrgPlan` does not fire and the swap path is
 * the one under test. That matters: the guard firing would make these tests
 * pass by never reaching the decision they are about.
 *
 * @param before what the separately-issued `getSubscription` sees — the
 *   subscription BEFORE the concurrent update. It carries `expand`; nothing
 *   else does, which is what makes the two reads distinguishable here.
 * @param after what every later read sees, including the one the preview is
 *   computed from — the subscription AFTER it.
 */
function stubConcurrentIntervalUpdate(
  before: { interval: "month" | "year"; priceId: string },
  after: { interval: "month" | "year"; priceId: string },
): void {
  stripeMethods.subscriptions.retrieve.mockImplementation(
    async (_id: string, opts?: { expand?: string[] }) => {
      const seen = opts?.expand ? before : after;
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
                id: seen.priceId,
                recurring: { interval: seen.interval },
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
    },
  );
}

describe("a plan update landing between two reads of one subscription (#3157, PR #3171 review, r4042249142)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    // The first read sees a MONTHLY price. The update to annual lands.
    // Everything after it — the preview included — sees ANNUAL.
    stubConcurrentIntervalUpdate(
      { interval: "month", priceId: "price_scale_m" },
      { interval: "year", priceId: "price_build_y" },
    );
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

  it("the fixture really does put the two reads in disagreement", async () => {
    // Guard the test itself. Every assertion below is about a disagreement,
    // and a fixture that quietly stopped producing one would make all of them
    // pass for the wrong reason — which is how three findings on #3238 and
    // three on #3187 stayed hidden.
    const expanded = (await stripeMethods.subscriptions.retrieve(
      "sub_active_001",
      { expand: ["items.data.price.product"] },
    )) as {
      items: { data: Array<{ price: { recurring: { interval: string } } }> };
    };
    const bare = (await stripeMethods.subscriptions.retrieve(
      "sub_active_001",
    )) as {
      items: { data: Array<{ price: { recurring: { interval: string } } }> };
    };

    expect(expanded.items.data[0]?.price.recurring.interval).toBe("month");
    expect(bare.items.data[0]?.price.recurring.interval).toBe("year");
  });

  it("quotes the anchor-reset invoice, not the $0 the stale read would have produced", async () => {
    const quote = await previewPlanChange("org-abc", "build-v2", "month");

    // The subscription the preview PRICED is annual, so moving to monthly is
    // an interval change and owes the invoice the anchor reset raises.
    expect(quote.isCharge).toBe(true);
    expect(quote.amountCents).toBe(COLLECTIBLE_CENTS);
    // The defect's output, named so a regression cannot pass as a pass.
    expect(quote.amountCents).not.toBe(0);
    // And not the credit either — the sign of the proration is not the answer.
    expect(quote.amountCents).not.toBe(UNUSED_ANNUAL_CREDIT_CENTS);
  });

  it("bills the swap under always_invoice, not the 'none' that drops the month", async () => {
    await changeOrgPlan("org-abc", "build-v2", "month");

    expect(stripeMethods.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(prorationBehaviorSent()).toBe("always_invoice");
    expect(prorationBehaviorSent()).not.toBe("none");
  });

  it("the quote takes no reading of the subscription of its own", async () => {
    // The mechanism, not just its output. A quote that came out right while
    // still holding a second read would regress the moment the two diverged
    // again, so what is pinned is that there is nothing to diverge FROM: the
    // only retrievals the quote path makes are the adapter's own, and none of
    // them carries the `expand` that `getSubscription` alone passes.
    await previewPlanChange("org-abc", "build-v2", "month");

    const expandedReads =
      stripeMethods.subscriptions.retrieve.mock.calls.filter(
        (call) => (call[1] as { expand?: string[] } | undefined)?.expand,
      );
    expect(expandedReads).toHaveLength(0);
  });

  it("the swap's own second read decides nothing about the interval", async () => {
    // changeOrgPlan DOES still read the subscription separately — for the
    // active price id, to recognise a swap already applied. That read is
    // consumed before the preview is taken and feeds one decision, so it is
    // not the straddle this finding is about. Pin that it cannot reach the
    // interval: it reports monthly, and the change is still billed as the
    // interval change the preview says it is.
    await changeOrgPlan("org-abc", "build-v2", "month");

    const expandedReads =
      stripeMethods.subscriptions.retrieve.mock.calls.filter(
        (call) => (call[1] as { expand?: string[] } | undefined)?.expand,
      );
    expect(expandedReads.length).toBeGreaterThan(0);
    expect(prorationBehaviorSent()).toBe("always_invoice");
  });
});
