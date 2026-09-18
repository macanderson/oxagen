/**
 * The prorations a plan-change preview CREATES, told apart from the prorations
 * already pending on the invoice — end to end, from the Stripe adapter through
 * the direction decision and the customer-facing quote.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM THE OTHER TWO.
 *
 * `stripe-provider.test.ts` proves the adapter attributes lines by the anchor
 * it asked for. `change-plan.test.ts` proves the decision follows the sign of
 * the previewed amount, handing it a canned number. Neither joins the two, and
 * the defect this guards against lives exactly in the join: the adapter summed
 * every `proration === true` line on the upcoming invoice, so a credit some
 * EARLIER change left pending there was added to this change's lines. A large
 * enough pending credit made a real upgrade sum nonpositive, `none` was
 * selected, and the upgrade charge was dropped (#3157, PR #3171 review).
 *
 * So the invoice here is contaminated on purpose and goes through the REAL
 * adapter into the REAL decision. A canned preview cannot fail this way, and a
 * canned preview is what let the join go untested while both halves passed.
 *
 * `tier-price-decoupling.test.ts` guard 6 pins the filter's SOURCE TEXT, which
 * catches a deletion and nothing else: a filter rewritten to match on a field
 * that pre-existing prorations also carry would keep the regex happy while the
 * charge disappeared again. Behaviour is what this file asserts.
 *
 * It also asserts the two halves AGREE. The quote and the behaviour are
 * computed from the same preview through two different call paths
 * (`previewPlanChange` for the number a person is shown, `changeOrgPlan` for
 * the proration flag Stripe is sent), and a filter fixed in one and not the
 * other is a confirmation screen that promises one thing and a charge that
 * does another.
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
const SCALE_PLAN = {
  id: "plan-scale-id",
  slug: "scale-v2",
  tier: "scale",
  stripePriceIdMonthly: "price_scale_m",
  stripePriceIdAnnual: "price_scale_y",
  monthlyCents: 80_000,
  annualCents: 800_000,
  stripeProductId: "prod_scale",
};

/** A pending proration from an earlier change, anchored in the past. */
const PENDING_SEAT_CREDIT_CENTS = -20_000;
const PENDING_ANCHOR = 1_600_000_000;
/** This change's own two lines: credit for unused Build, charge for Scale. */
const THIS_CHANGE_UNUSED_CENTS = -40_000;
const THIS_CHANGE_REMAINING_CENTS = 52_000;
/** What this change actually moves: +12000, an unambiguous upgrade. */
const THIS_CHANGE_NET_CENTS =
  THIS_CHANGE_UNUSED_CENTS + THIS_CHANGE_REMAINING_CENTS;
/** What the unfiltered sum used to report: +10000 is not the defect's answer… */
const CONTAMINATED_SUM_CENTS =
  THIS_CHANGE_NET_CENTS + PENDING_SEAT_CREDIT_CENTS;

/**
 * The subscription as the provider reports it: on Build until this test issues
 * a swap, on the swapped-to price afterwards — because the same call answers
 * both the already-applied guard (before) and the sync (after).
 */
function stubProviderSubscription(): void {
  stripeMethods.subscriptions.retrieve.mockImplementation(async () => {
    const lastUpdate = stripeMethods.subscriptions.update.mock.calls.at(-1) as
      | [string, { items?: Array<{ price?: string }> }]
      | undefined;
    const swappedTo = lastUpdate?.[1]?.items?.[0]?.price;
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
              id: swappedTo ?? "price_build_m",
              recurring: { interval: "month" },
              product: swappedTo ? "prod_scale" : "prod_build",
            },
          },
        ],
      },
      current_period_start: 1_756_684_800,
      current_period_end: 1_759_276_800,
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
    };
  });
}

/**
 * An upcoming invoice that already carries somebody else's proration.
 *
 * Stripe stamps `period.start` of each proration it creates with the
 * `proration_date` the preview was taken at, so the anchor the adapter asked
 * for is what makes a line this change's. The pending line is deliberately
 * anchored somewhere else — that is the whole fixture.
 */
function stubContaminatedPreview(): void {
  stripeMethods.invoices.createPreview.mockImplementation(
    async (args: { subscription_details?: { proration_date?: number } }) => {
      const anchor = args.subscription_details?.proration_date ?? 0;
      return {
        // The adapter derives the billing interval from the preview's own
        // response rather than from the retrieval beside it (r4042380655), so
        // a change-preview has to say what it priced. This file is about
        // proration ATTRIBUTION, not intervals, so it agrees with
        // `subscriptions.retrieve`; the case where the two disagree is
        // `plan-change-provider-interval.test.ts`.
        subscription: {
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
                  id: "price_build_m",
                  recurring: { interval: "month" },
                  product: "prod_build",
                },
              },
            ],
          },
          current_period_start: 1_756_684_800,
          current_period_end: 1_759_276_800,
          cancel_at_period_end: false,
          canceled_at: null,
          trial_end: null,
        },
        currency: "usd",
        total: THIS_CHANGE_NET_CENTS + PENDING_SEAT_CREDIT_CENTS,
        lines: {
          data: [
            {
              proration: true,
              description: "Unused seats (seat decrease recorded last week)",
              amount: PENDING_SEAT_CREDIT_CENTS,
              period: { start: PENDING_ANCHOR, end: anchor },
            },
            {
              proration: true,
              description: "Unused time on Build",
              amount: THIS_CHANGE_UNUSED_CENTS,
              period: { start: anchor, end: anchor + 100 },
            },
            {
              proration: true,
              description: "Remaining time on Scale",
              amount: THIS_CHANGE_REMAINING_CENTS,
              period: { start: anchor, end: anchor + 100 },
            },
          ],
        },
      };
    },
  );
}

function stubActiveSubscriptionRow(): void {
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

/**
 * The catalogue reads on this path, in order: the target by slug, the plan the
 * org is on by id, then — inside the post-swap sync — the target again by
 * product id.
 */
function stubPlanLookups(): void {
  // `mockResolvedValueOnce` queues survive `clearAllMocks`, so an unconsumed
  // entry from a previous test would answer the next test's first read — which
  // is how this file first "proved" a swap that never happened.
  dbQueryMocks.plans.findFirst.mockReset();
  dbQueryMocks.plans.findFirst
    .mockResolvedValueOnce(SCALE_PLAN)
    .mockResolvedValueOnce(BUILD_PLAN)
    .mockResolvedValue(SCALE_PLAN);
}

/** The proration flag the swap was actually sent to Stripe with. */
function prorationBehaviorSent(): string | undefined {
  const lastUpdate = stripeMethods.subscriptions.update.mock.calls.at(-1) as
    | [string, { proration_behavior?: string }]
    | undefined;
  return lastUpdate?.[1]?.proration_behavior;
}

describe("a plan change previewed against an invoice that already carries a proration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    stubProviderSubscription();
    stubContaminatedPreview();
    stubActiveSubscriptionRow();
    stubPlanLookups();
    // No card on file — the quote path resolves one, and a missing customer
    // must not be what decides this test.
    stripeMethods.customers.retrieve.mockResolvedValue({
      id: "cus_001",
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    stripeMethods.subscriptions.update.mockResolvedValue(undefined);
  });

  it("quotes THIS change's proration, not the account's pending balance", async () => {
    const quote = await previewPlanChange("org-abc", "scale-v2", "month");

    // Keyed on the value: the number a person is shown before they confirm is
    // the +$120.00 this swap raises, never the -$20.00 credit sitting on the
    // invoice from a seat decrease they already made.
    expect(quote.amountCents).toBe(THIS_CHANGE_NET_CENTS);
    expect(quote.isCharge).toBe(true);
    // The unfiltered sum is nonpositive; a quote equal to it, or to the zero
    // the `none` branch would produce from it, is the defect.
    expect(CONTAMINATED_SUM_CENTS).toBeLessThanOrEqual(0);
    expect(quote.amountCents).not.toBe(CONTAMINATED_SUM_CENTS);
    expect(quote.amountCents).toBeGreaterThan(0);
  });

  it("charges the upgrade rather than selecting 'none'", async () => {
    await changeOrgPlan("org-abc", "scale-v2", "month");

    expect(stripeMethods.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(prorationBehaviorSent()).toBe("always_invoice");
    expect(prorationBehaviorSent()).not.toBe("none");
  });

  it("quotes and charges the same change — the confirmation screen is honoured", async () => {
    const quote = await previewPlanChange("org-abc", "scale-v2", "month");

    // Second run of the same change, through the other call path. The
    // catalogue stubs are consumed per call, so re-arm them.
    stubPlanLookups();
    await changeOrgPlan("org-abc", "scale-v2", "month");

    // A positive quote is a promise that money changes hands now, and only
    // `always_invoice` keeps it: `none` writes no proration line at all.
    expect(quote.amountCents).toBeGreaterThan(0);
    expect(prorationBehaviorSent()).toBe("always_invoice");
    expect(quote.isCharge).toBe(prorationBehaviorSent() === "always_invoice");
  });

  it("anchors every line it attributed at the proration_date it asked for", async () => {
    await previewPlanChange("org-abc", "scale-v2", "month");

    // The mechanism, asserted directly: the adapter passes an anchor and the
    // lines it keeps are the ones carrying it. Without this, a filter that
    // happened to keep the right lines for the wrong reason would pass above.
    //
    // Found by its `subscription_details` rather than by position. The changed
    // preview is bracketed by a baseline read on either side of it — both of
    // which deliberately carry no change and therefore no anchor — so the last
    // call is no longer the one under test.
    const changed = stripeMethods.invoices.createPreview.mock.calls
      .map(
        (c) => c[0] as { subscription_details?: { proration_date?: number } },
      )
      .find((a) => a?.subscription_details !== undefined);
    expect(changed?.subscription_details?.proration_date).toBeTypeOf("number");
  });
});

// Leave the singleton as this file found it, so a later file in the same
// worker does not inherit a provider wired to these mocks.
afterEach(() => {
  resetBillingProvider();
});
