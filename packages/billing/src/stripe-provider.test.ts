/**
 * Unit tests for stripe-provider.ts — StripeProvider implementation.
 *
 * Mocks the Stripe SDK so no real API calls are made. Tests cover:
 *  - findCustomerByOrgId
 *  - customerExists
 *  - createCustomer
 *  - getSubscription (drives stripeSubscriptionToNeutral)
 *  - updateSubscription / cancelSubscription
 *  - upgradeSubscription / setSubscriptionSeats
 *  - previewSeatChange / previewPlanChange (drives summarizeProration)
 *  - listPaymentMethods / getDefaultPaymentMethodId
 *  - setDefaultPaymentMethod / detachPaymentMethod
 *  - createSetupIntent
 *  - chargeOffSession
 *  - getInvoice (drives stripeInvoiceToNeutral)
 *  - createSubscriptionCheckout / createPaymentCheckout / createDynamicCreditCheckout
 *  - getCheckoutSessionCreditPacks
 *  - parseWebhookEvent (drives stripeEventType + all event branches)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Stripe SDK mock — intercept new Stripe(...) to return a controllable object
// ---------------------------------------------------------------------------

const stripeMethods = {
  customers: {
    search: vi.fn(),
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  },
  subscriptions: {
    retrieve: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
  },
  invoices: {
    retrieve: vi.fn(),
    createPreview: vi.fn(),
    create: vi.fn(),
    finalizeInvoice: vi.fn(),
    pay: vi.fn(),
    del: vi.fn(),
    voidInvoice: vi.fn(),
    sendInvoice: vi.fn(),
  },
  invoiceItems: {
    create: vi.fn(),
  },
  paymentMethods: {
    list: vi.fn(),
    detach: vi.fn(),
  },
  setupIntents: {
    create: vi.fn(),
  },
  paymentIntents: {
    create: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
  checkout: {
    sessions: {
      create: vi.fn(),
      retrieve: vi.fn(),
      listLineItems: vi.fn(),
    },
  },
  webhooks: {
    constructEvent: vi.fn(),
  },
};

vi.mock("stripe", () => {
  return {
    default: vi.fn(() => stripeMethods),
  };
});

vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_mock",
  })),
}));

// Import after mocks — also resets the singleton in stripeClient()
const { StripeProvider } = await import("./stripe-provider");

// ---------------------------------------------------------------------------
// Helpers — minimal Stripe object factories
// ---------------------------------------------------------------------------

function makeStripeSub(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "sub_test_001",
    customer: "cus_test_001",
    metadata: { org_id: "org-1" },
    status: "active",
    items: {
      data: [
        {
          id: "si_001",
          quantity: 3,
          price: {
            recurring: { interval: "month" },
            product: "prod_test_001",
          },
        },
      ],
    },
    current_period_start: 1748736000,
    current_period_end: 1751414400,
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
    ...overrides,
  };
}

function makeStripeInvoice(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "in_test_001",
    number: "INV-001",
    status: "paid",
    amount_due: 2000,
    amount_paid: 2000,
    amount_remaining: 0,
    currency: "usd",
    period_start: 1748736000,
    period_end: 1751414400,
    due_date: null,
    status_transitions: { paid_at: 1748800000 },
    hosted_invoice_url: "https://invoice.stripe.com/i/test",
    invoice_pdf: "https://invoice.stripe.com/i/test.pdf",
    subscription: "sub_test_001",
    metadata: { org_id: "org-1" },
    billing_reason: "subscription_cycle",
    lines: {
      data: [
        {
          description: "Scale plan",
          quantity: 1,
          price: { unit_amount: 2000 },
          amount: 2000,
          metadata: { metric: "seats" },
        },
      ],
    },
    ...overrides,
  };
}

function makeStripePaymentMethod(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id: "pm_test_001",
    customer: "cus_test_001",
    type: "card",
    card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 },
    ...overrides,
  };
}

function makeStripeCheckoutSession(
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id: "cs_test_001",
    url: "https://checkout.stripe.com/pay/test_001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StripeProvider", () => {
  let provider: InstanceType<typeof StripeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StripeProvider();
  });

  // ── Customer ────────────────────────────────────────────────────────────────

  describe("findCustomerByOrgId", () => {
    it("returns customer id when found", async () => {
      stripeMethods.customers.search.mockResolvedValue({
        data: [{ id: "cus_found_001" }],
      });
      const result = await provider.findCustomerByOrgId("org-1");
      expect(result).toEqual({ id: "cus_found_001" });
    });

    it("returns null when no customer found", async () => {
      stripeMethods.customers.search.mockResolvedValue({ data: [] });
      const result = await provider.findCustomerByOrgId("org-2");
      expect(result).toBeNull();
    });
  });

  describe("createCustomer", () => {
    it("returns the new customer id", async () => {
      stripeMethods.customers.create.mockResolvedValue({ id: "cus_new_001" });
      const id = await provider.createCustomer({
        name: "Acme Corp",
        metadata: { org_id: "org-3" },
      });
      expect(id).toBe("cus_new_001");
      expect(stripeMethods.customers.create).toHaveBeenCalledWith({
        name: "Acme Corp",
        metadata: { org_id: "org-3" },
      });
    });
  });

  describe("customerExists", () => {
    it("returns true for a live customer", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        id: "cus_live_001",
        deleted: false,
      });
      await expect(provider.customerExists("cus_live_001")).resolves.toBe(true);
    });

    it("returns false for a deleted customer", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        id: "cus_gone_001",
        deleted: true,
      });
      await expect(provider.customerExists("cus_gone_001")).resolves.toBe(
        false,
      );
    });

    it("returns false when Stripe answers resource_missing", async () => {
      const err = Object.assign(new Error("No such customer"), {
        code: "resource_missing",
        type: "StripeInvalidRequestError",
      });
      stripeMethods.customers.retrieve.mockRejectedValue(err);
      await expect(provider.customerExists("cus_stale_001")).resolves.toBe(
        false,
      );
    });

    it("rethrows a transient Stripe error", async () => {
      const err = Object.assign(new Error("rate limited"), {
        type: "StripeRateLimitError",
        statusCode: 429,
      });
      stripeMethods.customers.retrieve.mockRejectedValue(err);
      await expect(provider.customerExists("cus_any")).rejects.toThrow(
        "rate limited",
      );
    });
  });

  // ── Subscription ────────────────────────────────────────────────────────────

  describe("getSubscription", () => {
    it("translates a Stripe subscription to neutral shape", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      const sub = await provider.getSubscription("sub_test_001");
      expect(sub.id).toBe("sub_test_001");
      expect(sub.customerId).toBe("cus_test_001");
      expect(sub.status).toBe("active");
      expect(sub.billingInterval).toBe("month");
      expect(sub.seatCount).toBe(3);
      expect(sub.productId).toBe("prod_test_001");
      expect(sub.cancelAtPeriodEnd).toBe(false);
      expect(sub.canceledAt).toBeNull();
      expect(sub.trialEnd).toBeNull();
    });

    it("sets billingInterval to year when subscription is yearly", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({
          items: {
            data: [
              {
                id: "si_002",
                quantity: 1,
                price: { recurring: { interval: "year" }, product: null },
              },
            ],
          },
        }),
      );
      const sub = await provider.getSubscription("sub_test_year");
      expect(sub.billingInterval).toBe("year");
    });

    it("falls back to status 'incomplete' for unknown status", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ status: "some_unknown_status" }),
      );
      const sub = await provider.getSubscription("sub_unknown");
      expect(sub.status).toBe("incomplete");
    });
  });

  describe("updateSubscription", () => {
    it("calls stripe subscriptions.update with cancelAtPeriodEnd", async () => {
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.updateSubscription("sub_test_001", {
        cancelAtPeriodEnd: true,
      });
      expect(stripeMethods.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        { cancel_at_period_end: true },
      );
    });

    it("sends empty params when no fields provided", async () => {
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.updateSubscription("sub_test_001", {});
      expect(stripeMethods.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        {},
      );
    });
  });

  describe("cancelSubscription", () => {
    it("calls stripe subscriptions.cancel", async () => {
      stripeMethods.subscriptions.cancel.mockResolvedValue({});
      await provider.cancelSubscription("sub_test_001");
      expect(stripeMethods.subscriptions.cancel).toHaveBeenCalledWith(
        "sub_test_001",
      );
    });
  });

  describe("upgradeSubscription", () => {
    it("swaps the price on the first line item", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.upgradeSubscription("sub_test_001", {
        newPriceId: "price_new_001",
        prorationBehavior: "always_invoice",
        idempotencyKey: "idem_001",
      });
      expect(stripeMethods.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({
          items: [expect.objectContaining({ price: "price_new_001" })],
        }),
        { idempotencyKey: "idem_001" },
      );
    });

    it("anchors the swap at the date the preview was priced from", async () => {
      // `subscriptions.update` with no `proration_date` lets Stripe anchor at
      // whatever moment it processes the request. The preview that produced
      // `prorationBehavior` — and the figure `approvedMaxCents` was just
      // checked against — was anchored at a different second, and the unused
      // credit of the old price decays between them. On an interval change
      // that decay makes the invoice LARGER, so the approved maximum can be
      // passed and the customer still billed above it.
      //
      // It is also the only thing that makes the preview's own attribution
      // guards mean anything: `previewWithOwnedAnchor` refuses when another
      // proration already sits at this anchor, and an update that lands on a
      // different anchor was never subject to that test
      // (#3157, PR #3171 review, review 5243042193).
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.upgradeSubscription("sub_test_001", {
        newPriceId: "price_new_001",
        prorationBehavior: "always_invoice",
        idempotencyKey: "idem_001",
        prorationDate: 1_700_000_000,
      });
      expect(stripeMethods.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({ proration_date: 1_700_000_000 }),
        { idempotencyKey: "idem_001" },
      );
    });

    it("sends no anchor when there was no preview to take one from", async () => {
      // The paired negative. An unpriceable change has no anchor to reuse, and
      // inventing `Date.now()` here would be a second reading dressed as the
      // preview's — the exact confusion the rest of this branch removes. Stripe
      // anchoring at its own now is then the honest behaviour, and is what
      // happens today.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.upgradeSubscription("sub_test_001", {
        newPriceId: "price_new_001",
        prorationBehavior: "always_invoice",
      });
      const params = stripeMethods.subscriptions.update.mock.calls[0]?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(params).toBeDefined();
      expect("proration_date" in (params ?? {})).toBe(false);
    });

    it("throws when subscription has no items", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ items: { data: [] } }),
      );
      await expect(
        provider.upgradeSubscription("sub_empty", { newPriceId: "price_new" }),
      ).rejects.toThrow("subscription has no items");
    });
  });

  describe("setSubscriptionSeats", () => {
    it("updates the seat quantity on the first line item", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.subscriptions.update.mockResolvedValue({});
      await provider.setSubscriptionSeats("sub_test_001", { seats: 5 });
      expect(stripeMethods.subscriptions.update).toHaveBeenCalledWith(
        "sub_test_001",
        expect.objectContaining({
          items: [expect.objectContaining({ quantity: 5 })],
        }),
        undefined,
      );
    });

    it("throws when subscription has no items", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ items: { data: [] } }),
      );
      await expect(
        provider.setSubscriptionSeats("sub_empty", { seats: 2 }),
      ).rejects.toThrow("subscription has no items");
    });
  });

  /**
   * A previewed invoice whose proration lines carry the anchor the adapter
   * asked for.
   *
   * Stripe stamps `period.start` of every proration it creates with the
   * `proration_date` the preview was taken at, and that anchor is what tells
   * this change's money apart from prorations already pending on the invoice.
   * A fixture that omits it is not a simpler fixture — it is an invoice whose
   * lines belong to nobody, which the adapter now refuses rather than sum.
   */
  function previewing(
    lines: Array<{
      proration: boolean;
      description: string;
      amount: number;
      /** Omit to anchor at this preview; set to model an older, pending one. */
      periodStart?: number;
    }>,
    total = 0,
    /**
     * What Stripe would COLLECT. Defaults to the total, which is the case with
     * no customer balance; pass it to model an account credit.
     */
    amountDue = total,
    /**
     * The subscription the preview reports having been computed against.
     *
     * The adapter takes the billing interval from HERE rather than from the
     * `subscriptions.retrieve` beside it, because those are two provider
     * requests and a plan update can land between them (r4042380655). Pass
     * `null` to model a preview that does not report what it priced.
     */
    previewedSubscription: unknown = makeStripeSub(),
  ) {
    stripeMethods.invoices.createPreview.mockImplementation(
      async (args: { subscription_details?: { proration_date?: number } }) => {
        const anchoredAt = args.subscription_details?.proration_date ?? 0;
        return {
          subscription: previewedSubscription ?? "sub_test_001",
          currency: "usd",
          total,
          amount_due: amountDue,
          lines: {
            data: lines.map((l) => ({
              proration: l.proration,
              description: l.description,
              amount: l.amount,
              period: { start: l.periodStart ?? anchoredAt, end: anchoredAt },
            })),
          },
        };
      },
    );
  }

  describe("previewSeatChange", () => {
    it("returns proration preview with amountCents", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        { proration: true, description: "Unused time", amount: -500 },
        { proration: true, description: "Remaining time", amount: 800 },
      ]);
      const preview = await provider.previewSeatChange("sub_test_001", {
        seats: 5,
      });
      expect(preview.amountCents).toBe(300);
      expect(preview.isCharge).toBe(true);
      expect(preview.currency).toBe("usd");
      expect(preview.lines).toHaveLength(2);
    });

    it("throws when subscription has no items", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(
        makeStripeSub({ items: { data: [] } }),
      );
      await expect(
        provider.previewSeatChange("sub_empty", { seats: 2 }),
      ).rejects.toThrow("subscription has no items");
    });
  });

  describe("previewPlanChange", () => {
    it("returns proration preview for plan change", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        { proration: true, description: "Plan upgrade", amount: 1200 },
      ]);
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.amountCents).toBe(1200);
      expect(preview.isCharge).toBe(true);
    });

    it("a credit already pending on the invoice does not cancel this upgrade", async () => {
      // The fifth inversion of the same direction, and the first one INSIDE
      // the preview. `proration === true` selects every proration on the
      // upcoming invoice, not the ones this simulation created — so a seat
      // decrease recorded earlier under create_prorations leaves a credit
      // sitting there. Summed together, a real +$12.00 upgrade reads as
      // -$8.00, the caller ships `none`, and the upgrade charge is dropped.
      //
      // Keyed on the VALUE: the answer must be the upgrade's own +1200, not
      // the account's pending -800. A test asserting only "it did not throw"
      // would pass against the defect.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        {
          proration: true,
          description: "Unused seats (recorded last week)",
          amount: -2000,
          periodStart: 1_600_000_000,
        },
        { proration: true, description: "Plan upgrade", amount: 1200 },
      ]);
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.amountCents).toBe(1200);
      expect(preview.isCharge).toBe(true);
      // And the pending line is not reported as part of this change either.
      expect(preview.lines).toHaveLength(1);
    });

    it("an invoice whose prorations all belong to something else is refused, not summed to zero", async () => {
      // Filtering could fail the other way: drop everything and report 0,
      // which reads as "this change is free" and ships `none`. An
      // unattributable preview is not a preview of nothing — the same lesson
      // as the `?? 0` quote, one layer down.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        {
          proration: true,
          description: "Unused seats",
          amount: -2000,
          periodStart: 1_600_000_000,
        },
      ]);
      await expect(
        provider.previewPlanChange("sub_test_001", {
          newPriceId: "price_scale_monthly",
        }),
      ).rejects.toMatchObject({ code: "PRORATION_ATTRIBUTION_FAILED" });
    });

    it("an invoice with no prorations at all is a true zero, not a refusal", async () => {
      // The distinction the refusal above depends on: nothing to attribute is
      // not the same as something that cannot be attributed.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        { proration: false, description: "Next month", amount: 99900 },
      ]);
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.amountCents).toBe(0);
      expect(preview.lines).toHaveLength(0);
    });

    it("returns negative amountCents for a downgrade", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        { proration: true, description: "Downgrade credit", amount: -900 },
      ]);
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_build_monthly",
      });
      expect(preview.amountCents).toBe(-900);
      expect(preview.isCharge).toBe(false);
    });

    it("reports the invoice total and the collectible amount separately", async () => {
      // A customer carrying a credit balance has Stripe apply it to
      // `amount_due`, so the invoice and the collection are different numbers.
      // Only the second is what happens to their card, and the interval-change
      // quote reads it (#3157, PR #3171 review).
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [{ proration: false, description: "One month", amount: 20_000 }],
        20_000,
        5_000,
      );
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.totalCents).toBe(20_000);
      expect(preview.amountDueCents).toBe(5_000);
      // Guard the fixture: a case where the two agree proves nothing.
      expect(preview.amountDueCents).not.toBe(preview.totalCents);
    });

    it("collects the total when the customer carries no balance", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [{ proration: false, description: "One month", amount: 20_000 }],
        20_000,
      );
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.amountDueCents).toBe(20_000);
      expect(preview.totalCents).toBe(20_000);
    });

    // ── The interval comes off the preview, not the retrieval beside it ───
    //
    // `subscriptions.retrieve` and `invoices.createPreview` are two provider
    // requests. The adapter used to retrieve the subscription (to find the
    // item to reprice) and label the preview with it, which is not the same as
    // deriving the interval from the state that was priced: a plan update
    // landing between the two makes the label describe a different
    // subscription (r4042380655).

    it("takes the billing interval from the subscription the preview reports, not the one retrieved beside it", async () => {
      // The two disagree, which is the only configuration that can tell a
      // derivation from a label. Retrieval says monthly; the preview says it
      // priced an annual subscription.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [{ proration: true, description: "Unused time", amount: -80_000 }],
        20_000,
        20_000,
        makeStripeSub({
          items: {
            data: [
              {
                id: "si_001",
                quantity: 3,
                price: {
                  recurring: { interval: "year" },
                  product: "prod_test_001",
                },
              },
            ],
          },
        }),
      );

      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });

      expect(preview.billingInterval).toBe("year");
    });

    it("requests the subscription on the preview call, which is what makes it one observation", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing([
        { proration: true, description: "Unused time", amount: -100 },
      ]);

      await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });

      expect(stripeMethods.invoices.createPreview).toHaveBeenCalledWith(
        expect.objectContaining({ expand: ["subscription"] }),
      );
    });

    it("refuses when the preview does not report the subscription it priced", async () => {
      // The adapter is holding a perfectly good subscription from its own
      // retrieval. Using it is the fallback that was the defect, so there is
      // no fallback — an unreported priced state is a refusal.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [{ proration: true, description: "Unused time", amount: -100 }],
        0,
        0,
        null,
      );

      await expect(
        provider.previewPlanChange("sub_test_001", {
          newPriceId: "price_scale_monthly",
        }),
      ).rejects.toMatchObject({ code: "PREVIEWED_SUBSCRIPTION_UNAVAILABLE" });
    });

    it("quotes a plan the subscription is ALREADY on, rather than refusing", async () => {
      // Load-bearing for the simulation check below, and a real case in its
      // own right: `previewPlanChange` in the domain has no already-applied
      // guard (`changeOrgPlan` does), so a customer asking what their CURRENT
      // plan would cost reaches this adapter with `newPriceId` equal to the
      // price the subscription is on. The previewed subscription then reports
      // the target price legitimately, and repricing an item to the price it
      // already holds moves no money.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [
          { proration: true, description: "Unused time", amount: -5_000 },
          { proration: true, description: "Remaining time", amount: 5_000 },
        ],
        0,
        0,
        makeStripeSub({
          items: {
            data: [
              {
                id: "si_001",
                quantity: 3,
                price: {
                  id: "price_same_monthly",
                  recurring: { interval: "month" },
                  product: "prod_test_001",
                },
              },
            ],
          },
        }),
      );

      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_same_monthly",
      });

      expect(preview.amountCents).toBe(0);
      expect(preview.billingInterval).toBe("month");
    });

    it("refuses when the preview reports the target price while pricing a real move to it", async () => {
      // This models the failure mode the rest of this file CANNOT model: an
      // expansion that reflects the simulated change rather than the stored
      // subscription. Every other stub here is written to the assumption that
      // it is stored, and a double cannot falsify the assumption it was built
      // from — so the check is exercised directly instead.
      //
      // If Stripe behaved this way, `billingInterval` would be the interval
      // being moved TO, every change would score same-interval, `none` would
      // ship and an anchor reset would be quoted at $0. Refusing turns a
      // silent wrong number into a loud stop.
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [
          {
            proration: true,
            description: "Unused time on annual",
            amount: -80_000,
          },
          {
            proration: true,
            description: "Remaining time on monthly",
            amount: 20_000,
          },
        ],
        20_000,
        20_000,
        // Already on the price being moved TO — the simulated signature.
        makeStripeSub({
          items: {
            data: [
              {
                id: "si_001",
                quantity: 3,
                price: {
                  id: "price_scale_monthly",
                  recurring: { interval: "month" },
                  product: "prod_test_001",
                },
              },
            ],
          },
        }),
      );

      await expect(
        provider.previewPlanChange("sub_test_001", {
          newPriceId: "price_scale_monthly",
        }),
      ).rejects.toMatchObject({ code: "PREVIEWED_SUBSCRIPTION_SIMULATED" });
    });

    it("refuses on the seat path too, which shares the helper", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      previewing(
        [{ proration: true, description: "Unused seats", amount: -100 }],
        0,
        0,
        null,
      );

      await expect(
        provider.previewSeatChange("sub_test_001", { seats: 5 }),
      ).rejects.toMatchObject({ code: "PREVIEWED_SUBSCRIPTION_UNAVAILABLE" });
    });
  });

  // ── Payment methods ───────────────────────────────────────────────────────────

  describe("listPaymentMethods", () => {
    it("translates payment methods to neutral shape", async () => {
      stripeMethods.paymentMethods.list.mockResolvedValue({
        data: [makeStripePaymentMethod()],
      });
      const methods = await provider.listPaymentMethods("cus_test_001");
      expect(methods).toHaveLength(1);
      expect(methods[0]).toMatchObject({
        id: "pm_test_001",
        customerId: "cus_test_001",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2028,
      });
    });

    it("returns empty array when no payment methods", async () => {
      stripeMethods.paymentMethods.list.mockResolvedValue({ data: [] });
      const methods = await provider.listPaymentMethods("cus_test_002");
      expect(methods).toEqual([]);
    });
  });

  describe("getDefaultPaymentMethodId", () => {
    it("returns the default payment method id", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: "pm_default_001" },
      });
      const pmId = await provider.getDefaultPaymentMethodId("cus_test_001");
      expect(pmId).toBe("pm_default_001");
    });

    it("returns null for deleted customer", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({ deleted: true });
      const pmId = await provider.getDefaultPaymentMethodId("cus_deleted");
      expect(pmId).toBeNull();
    });

    it("returns null when no default payment method set", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: null },
      });
      const pmId = await provider.getDefaultPaymentMethodId("cus_test_003");
      expect(pmId).toBeNull();
    });
  });

  describe("setDefaultPaymentMethod", () => {
    it("calls customers.update with the payment method", async () => {
      stripeMethods.customers.update.mockResolvedValue({});
      await provider.setDefaultPaymentMethod("cus_test_001", "pm_new_001");
      expect(stripeMethods.customers.update).toHaveBeenCalledWith(
        "cus_test_001",
        {
          invoice_settings: { default_payment_method: "pm_new_001" },
        },
      );
    });
  });

  describe("detachPaymentMethod", () => {
    it("calls paymentMethods.detach", async () => {
      stripeMethods.paymentMethods.detach.mockResolvedValue({});
      await provider.detachPaymentMethod("pm_test_001");
      expect(stripeMethods.paymentMethods.detach).toHaveBeenCalledWith(
        "pm_test_001",
      );
    });
  });

  describe("createSetupIntent", () => {
    it("returns client secret and setup intent id", async () => {
      stripeMethods.setupIntents.create.mockResolvedValue({
        id: "seti_test_001",
        client_secret: "seti_test_001_secret_abc123",
      });
      const result = await provider.createSetupIntent("cus_test_001");
      expect(result.setupIntentId).toBe("seti_test_001");
      expect(result.clientSecret).toBe("seti_test_001_secret_abc123");
    });

    it("throws when Stripe does not return a client secret", async () => {
      stripeMethods.setupIntents.create.mockResolvedValue({
        id: "seti_no_secret",
        client_secret: null,
      });
      await expect(provider.createSetupIntent("cus_test_001")).rejects.toThrow(
        "Stripe did not return a SetupIntent client secret",
      );
    });
  });

  describe("chargeOffSession", () => {
    it("creates a payment intent with explicit payment method", async () => {
      stripeMethods.paymentIntents.create.mockResolvedValue({
        id: "pi_test_001",
        status: "succeeded",
      });
      const result = await provider.chargeOffSession({
        customerId: "cus_test_001",
        amountCents: 5000,
        paymentMethodId: "pm_test_001",
        description: "Credit reload",
        metadata: { org_id: "org-1" },
        idempotencyKey: "reload_idem_001",
      });
      expect(result.paymentIntentId).toBe("pi_test_001");
      expect(result.status).toBe("succeeded");
      expect(result.succeeded).toBe(true);
    });

    it("resolves default payment method when none provided", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: "pm_default_001" },
      });
      stripeMethods.paymentIntents.create.mockResolvedValue({
        id: "pi_test_002",
        status: "succeeded",
      });
      const result = await provider.chargeOffSession({
        customerId: "cus_test_001",
        amountCents: 1000,
        description: "Auto reload",
        metadata: {},
      });
      expect(result.succeeded).toBe(true);
      expect(stripeMethods.paymentIntents.create).toHaveBeenCalledWith(
        expect.objectContaining({ payment_method: "pm_default_001" }),
        undefined,
      );
    });

    it("throws when no payment method on file", async () => {
      stripeMethods.customers.retrieve.mockResolvedValue({
        deleted: false,
        invoice_settings: { default_payment_method: null },
      });
      await expect(
        provider.chargeOffSession({
          customerId: "cus_no_pm",
          amountCents: 500,
          description: "Charge",
          metadata: {},
        }),
      ).rejects.toThrow("no payment method on file");
    });
  });

  // ── Invoice ─────────────────────────────────────────────────────────────────

  describe("getInvoice", () => {
    it("translates a Stripe invoice to neutral shape", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(makeStripeInvoice());
      const invoice = await provider.getInvoice("in_test_001");
      expect(invoice.id).toBe("in_test_001");
      expect(invoice.status).toBe("paid");
      expect(invoice.amountDueCents).toBe(2000);
      expect(invoice.amountPaidCents).toBe(2000);
      expect(invoice.currency).toBe("usd");
      expect(invoice.subscriptionId).toBe("sub_test_001");
      expect(invoice.orgId).toBe("org-1");
      expect(invoice.lineItems).toHaveLength(1);
      expect(invoice.lineItems[0]!.metric).toBe("seats");
      expect(invoice.paidAt).toBeInstanceOf(Date);
    });

    it("binds a Checkout-issued GAU invoice to its org from invoice.metadata.org_id with no subscription", async () => {
      // A payment-mode session with invoice_creation issues an invoice whose
      // only tenant reference is the metadata the session carried.
      stripeMethods.invoices.retrieve.mockResolvedValue(
        makeStripeInvoice({
          subscription: null,
          parent: null,
          billing_reason: "manual",
          metadata: { oxagen_kind: "gau_purchase", org_id: "org-gau" },
        }),
      );
      const invoice = await provider.getInvoice("in_gau_001");
      expect(invoice.orgId).toBe("org-gau");
      expect(invoice.subscriptionId).toBeNull();
      expect(invoice.billingReason).toBe("manual");
    });

    it("reads the settlement a governed-action invoice settles from metadata.gau_settlement_id", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        makeStripeInvoice({
          subscription: null,
          metadata: {
            org_id: "org-gau",
            oxagen_kind: "gau_auto_topup",
            gau_settlement_id: "0192d4a8-7c1e-7a00-8000-0000000005e7",
          },
        }),
      );
      const invoice = await provider.getInvoice("in_gau_002");
      expect(invoice.gauSettlementId).toBe(
        "0192d4a8-7c1e-7a00-8000-0000000005e7",
      );
      expect(invoice.orgId).toBe("org-gau");
    });

    it("leaves gauSettlementId null on every other invoice", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(makeStripeInvoice());
      expect(
        (await provider.getInvoice("in_test_001")).gauSettlementId,
      ).toBeNull();
    });

    it.each([
      [undefined, { kind: "unchanged" }],
      ["none", { kind: "set", capCents: null }],
      ["600000", { kind: "set", capCents: 600_000 }],
      ["20.5", { kind: "unchanged" }],
    ])(
      "reads a prepaid order and its assistant cap instruction %s from the metadata",
      async (cap, expected) => {
        stripeMethods.invoices.retrieve.mockResolvedValue(
          makeStripeInvoice({
            subscription: null,
            metadata: {
              org_id: "org-ent",
              oxagen_kind: "prepaid_order",
              prepaid_order_id: "0192d4a8-7c1e-7a00-8000-0000000000d1",
              ...(cap === undefined ? {} : { assistant_spend_cap_cents: cap }),
            },
          }),
        );
        const invoice = await provider.getInvoice("in_pre_001");
        expect(invoice.prepaidOrder).toEqual({
          orderId: "0192d4a8-7c1e-7a00-8000-0000000000d1",
          assistantSpendCap: expected,
        });
      },
    );

    it("names no prepaid order on an invoice of any other kind, even one carrying the id", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        makeStripeInvoice({
          metadata: {
            oxagen_kind: "gau_interim",
            prepaid_order_id: "0192d4a8-7c1e-7a00-8000-0000000000d1",
          },
        }),
      );
      expect((await provider.getInvoice("in_x")).prepaidOrder).toBeNull();
    });

    it("maps unknown invoice status to 'draft'", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        makeStripeInvoice({ status: "unknown_status" }),
      );
      const invoice = await provider.getInvoice("in_bad_status");
      expect(invoice.status).toBe("draft");
    });

    it("resolves subscriptionId + orgId from Basil-era parent.subscription_details (OXA-1611)", async () => {
      // Stripe Basil (2025-03-31+) removed the top-level invoice.subscription and
      // invoice-level org metadata; both now live under parent.subscription_details.
      // Reading only the legacy fields nulled subscriptionId/orgId in prod, which
      // made grantPlanCreditsForInvoicePaid silently skip the upgrade credit grant.
      stripeMethods.invoices.retrieve.mockResolvedValue(
        makeStripeInvoice({
          subscription: null, // top-level field gone on Basil
          metadata: {}, // org_id no longer stamped on the invoice itself
          billing_reason: "subscription_create",
          parent: {
            subscription_details: {
              subscription: "sub_basil_001",
              metadata: { org_id: "org-basil" },
            },
          },
        }),
      );
      const invoice = await provider.getInvoice("in_basil_001");
      expect(invoice.subscriptionId).toBe("sub_basil_001");
      expect(invoice.orgId).toBe("org-basil");
      expect(invoice.billingReason).toBe("subscription_create");
    });
  });

  // ── Checkout ─────────────────────────────────────────────────────────────────

  describe("createSubscriptionCheckout", () => {
    it("returns session id and url", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );
      const result = await provider.createSubscriptionCheckout({
        customerId: "cus_test_001",
        priceId: "price_scale_monthly",
        seats: 2,
        subscriptionMetadata: { org_id: "org-1" },
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });
      expect(result.sessionId).toBe("cs_test_001");
      expect(result.url).toBe("https://checkout.stripe.com/pay/test_001");
    });

    it("throws when Stripe does not return a URL", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue({
        id: "cs_no_url",
        url: null,
      });
      await expect(
        provider.createSubscriptionCheckout({
          customerId: "cus_test_001",
          priceId: "price_test",
          subscriptionMetadata: {},
          successUrl: "",
          cancelUrl: "",
        }),
      ).rejects.toThrow("Stripe did not return a checkout URL");
    });
  });

  describe("createPaymentCheckout", () => {
    it("returns session id and url", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );
      const result = await provider.createPaymentCheckout({
        customerId: "cus_test_001",
        priceId: "price_credits_500",
        quantity: 1,
        metadata: { org_id: "org-1" },
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });
      expect(result.sessionId).toBe("cs_test_001");
    });

    it("throws when Stripe does not return a URL", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue({
        id: "cs_no_url",
        url: null,
      });
      await expect(
        provider.createPaymentCheckout({
          customerId: "cus_test_001",
          priceId: "price_test",
          quantity: 1,
          metadata: {},
          successUrl: "",
          cancelUrl: "",
        }),
      ).rejects.toThrow("Stripe did not return a checkout URL");
    });
  });

  describe("createDynamicCreditCheckout", () => {
    it("returns session id and url for dynamic credit purchase", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );
      const result = await provider.createDynamicCreditCheckout({
        customerId: "cus_test_001",
        orgId: "org-1",
        priceCents: 4250,
        grantCents: 5000,
        discountPercent: 15,
        successUrl: "https://app.example.com/success",
        cancelUrl: "https://app.example.com/cancel",
      });
      expect(result.sessionId).toBe("cs_test_001");
    });
  });

  describe("createGauInvoice", () => {
    const input = {
      customerId: "cus_test_001",
      orgId: "org-1",
      settlementId: "set_001",
      kind: "gau_auto_topup" as const,
      quantityGau: 5_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      description: "Governed action units, auto top-up: 1 Sep to 30 Sep 2026",
      period: {
        start: new Date("2026-09-01T00:00:00.000Z"),
        end: new Date("2026-10-01T00:00:00.000Z"),
      },
      collection: {
        method: "charge_automatically" as const,
        defaultPaymentMethodId: "pm_test_001",
      },
    };

    beforeEach(() => {
      stripeMethods.invoices.create.mockResolvedValue({ id: "in_gau_001" });
      stripeMethods.invoiceItems.create.mockResolvedValue({ id: "ii_001" });
    });

    it("creates a draft with auto_advance false, excluding pending items, keyed on the settlement, then its one line, and returns the invoice id", async () => {
      const result = await provider.createGauInvoice(input);

      expect(result).toEqual({ invoiceId: "in_gau_001" });
      expect(stripeMethods.invoices.create).toHaveBeenCalledWith(
        {
          customer: "cus_test_001",
          auto_advance: false,
          pending_invoice_items_behavior: "exclude",
          metadata: {
            org_id: "org-1",
            oxagen_kind: "gau_auto_topup",
            gau_settlement_id: "set_001",
            gau_quantity: "5000",
            rate_per_gau_micros: "5000",
            currency: "usd",
          },
          collection_method: "charge_automatically",
          default_payment_method: "pm_test_001",
        },
        { idempotencyKey: "set_001:invoice" },
      );
      expect(stripeMethods.invoiceItems.create).toHaveBeenCalledWith(
        {
          customer: "cus_test_001",
          invoice: "in_gau_001",
          quantity: 5_000,
          unit_amount_decimal: "0.5",
          currency: "usd",
          description:
            "Governed action units, auto top-up: 1 Sep to 30 Sep 2026",
          // The bucket month, with the end on its last second so Stripe
          // prints 30 Sep, the same last day the description does.
          period: { start: 1788220800, end: 1790812799 },
        },
        { idempotencyKey: "set_001:item" },
      );
      expect(
        stripeMethods.invoices.create.mock.invocationCallOrder[0],
      ).toBeLessThan(
        stripeMethods.invoiceItems.create.mock.invocationCallOrder[0]!,
      );
    });

    it("emails a send_invoice invoice due in the given days when the org has no default card", async () => {
      await provider.createGauInvoice({
        ...input,
        kind: "gau_interim",
        collection: { method: "send_invoice", daysUntilDue: 30 },
      });
      const params = stripeMethods.invoices.create.mock.calls[0]![0] as Record<
        string,
        unknown
      >;
      expect(params).toMatchObject({
        collection_method: "send_invoice",
        days_until_due: 30,
        metadata: expect.objectContaining({ oxagen_kind: "gau_interim" }),
      });
      expect(params).not.toHaveProperty("default_payment_method");
    });

    it.each([
      [6_000n, "0.6"],
      [12_345n, "1.2345"],
      [10_000n, "1"],
      [2_000n, "0.2"],
    ])(
      "sends a rate of %s micros as unit_amount_decimal %s cents",
      async (rate, decimal) => {
        await provider.createGauInvoice({ ...input, ratePerGauMicros: rate });
        expect(stripeMethods.invoiceItems.create).toHaveBeenCalledWith(
          expect.objectContaining({ unit_amount_decimal: decimal }),
          expect.anything(),
        );
      },
    );

    it("adds no line when Stripe refuses the invoice", async () => {
      stripeMethods.invoices.create.mockRejectedValue(new Error("down"));
      await expect(provider.createGauInvoice(input)).rejects.toThrow("down");
      expect(stripeMethods.invoiceItems.create).not.toHaveBeenCalled();
    });
  });

  describe("createPrepaidInvoice", () => {
    const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
    const input = {
      customerId: "cus_ent_001",
      orgId: "org-ent",
      orderId: ORDER,
      currency: "usd",
      daysUntilDue: 30,
      lines: [
        {
          key: "licence" as const,
          description:
            "Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027",
          quantity: 1,
          unitAmountDecimal: "12000000",
          period: {
            start: new Date("2026-10-01T00:00:00.000Z"),
            end: new Date("2027-10-01T00:00:00.000Z"),
          },
        },
        {
          key: "credits" as const,
          description:
            "Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)",
          quantity: 1,
          unitAmountDecimal: "500000",
          period: null,
        },
      ],
      customFields: [
        { name: "Agreement", value: "MSA-2026-014" },
        { name: "PO number", value: "PO-7781" },
      ],
      memo: "Year one of the enterprise agreement.",
      footer: "Itemised usage: request a statement.",
      metadata: { assistant_spend_cap_cents: "none" },
    };

    beforeEach(() => {
      stripeMethods.invoices.create.mockResolvedValue({ id: "in_pre_001" });
      stripeMethods.invoiceItems.create.mockResolvedValue({ id: "ii_001" });
    });

    it("creates a send_invoice draft keyed on the order, with the header fields, footer, memo and routing metadata", async () => {
      expect(await provider.createPrepaidInvoice(input)).toEqual({
        invoiceId: "in_pre_001",
      });
      expect(stripeMethods.invoices.create).toHaveBeenCalledWith(
        {
          customer: "cus_ent_001",
          auto_advance: false,
          collection_method: "send_invoice",
          days_until_due: 30,
          currency: "usd",
          pending_invoice_items_behavior: "exclude",
          custom_fields: [
            { name: "Agreement", value: "MSA-2026-014" },
            { name: "PO number", value: "PO-7781" },
          ],
          description: "Year one of the enterprise agreement.",
          footer: "Itemised usage: request a statement.",
          metadata: {
            assistant_spend_cap_cents: "none",
            org_id: "org-ent",
            oxagen_kind: "prepaid_order",
            prepaid_order_id: ORDER,
          },
        },
        { idempotencyKey: `${ORDER}:invoice` },
      );
    });

    it("adds one item per line, each keyed on the order and the line, with the licence period and none on the credits", async () => {
      await provider.createPrepaidInvoice(input);
      expect(stripeMethods.invoiceItems.create).toHaveBeenNthCalledWith(
        1,
        {
          customer: "cus_ent_001",
          invoice: "in_pre_001",
          quantity: 1,
          unit_amount_decimal: "12000000",
          currency: "usd",
          description:
            "Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027",
          period: { start: 1790812800, end: 1822348799 },
          metadata: { prepaid_order_id: ORDER, line: "licence" },
        },
        { idempotencyKey: `${ORDER}:item:licence` },
      );
      const second = stripeMethods.invoiceItems.create.mock.calls[1]!;
      expect(second[0]).not.toHaveProperty("period");
      expect(second[1]).toEqual({ idempotencyKey: `${ORDER}:item:credits` });
    });

    it("omits custom fields and the memo when the order has neither", async () => {
      await provider.createPrepaidInvoice({
        ...input,
        customFields: [],
        memo: null,
      });
      const params = stripeMethods.invoices.create.mock.calls[0]![0];
      expect(params).not.toHaveProperty("custom_fields");
      expect(params).not.toHaveProperty("description");
    });

    it("adds no item when Stripe refuses the invoice", async () => {
      stripeMethods.invoices.create.mockRejectedValue(new Error("down"));
      await expect(provider.createPrepaidInvoice(input)).rejects.toThrow(
        "down",
      );
      expect(stripeMethods.invoiceItems.create).not.toHaveBeenCalled();
    });
  });

  describe("sendPrepaidInvoice", () => {
    const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
    const ref = {
      orderId: ORDER,
      invoiceId: "in_pre_001",
      expectedSubtotalCents: 12_500_000,
    };
    const invoice = (over: Record<string, unknown>) => ({
      id: "in_pre_001",
      status: "draft",
      subtotal: 12_500_000,
      amount_due: 12_500_000,
      number: null,
      hosted_invoice_url: null,
      invoice_pdf: null,
      ...over,
    });

    it("sends a draft whose subtotal matches the order, keyed on the order, and answers with the number and pages", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(invoice({}));
      stripeMethods.invoices.sendInvoice.mockResolvedValue(
        invoice({
          status: "open",
          number: "OXA-0042",
          metadata: {
            oxagen_kind: "prepaid_order",
            prepaid_order_id: ORDER,
            assistant_spend_cap_cents: "600000",
          },
          hosted_invoice_url: "https://invoice.stripe.com/i/pre",
          invoice_pdf: "https://invoice.stripe.com/i/pre.pdf",
        }),
      );
      expect(await provider.sendPrepaidInvoice(ref)).toEqual({
        status: "open",
        number: "OXA-0042",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/pre",
        invoicePdfUrl: "https://invoice.stripe.com/i/pre.pdf",
        amountDueCents: 12_500_000,
        assistantSpendCap: { kind: "set", capCents: 600_000 },
      });
      expect(stripeMethods.invoices.sendInvoice).toHaveBeenCalledWith(
        "in_pre_001",
        {},
        { idempotencyKey: `${ORDER}:send` },
      );
    });

    it("never sends a draft whose subtotal differs from the order", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ subtotal: 12_499_999 }),
      );
      await expect(provider.sendPrepaidInvoice(ref)).rejects.toThrow(
        /subtotals 12499999, the order 12500000; not sent/,
      );
      expect(stripeMethods.invoices.sendInvoice).not.toHaveBeenCalled();
    });

    it.each(["open", "paid"])(
      "only reads an invoice that is already %s: a resume sends no second email",
      async (status) => {
        stripeMethods.invoices.retrieve.mockResolvedValue(
          invoice({ status, number: "OXA-0042" }),
        );
        expect(await provider.sendPrepaidInvoice(ref)).toMatchObject({
          status,
          number: "OXA-0042",
        });
        expect(stripeMethods.invoices.sendInvoice).not.toHaveBeenCalled();
      },
    );

    it.each(["void", "uncollectible"])(
      "throws for a %s invoice",
      async (status) => {
        stripeMethods.invoices.retrieve.mockResolvedValue(invoice({ status }));
        await expect(provider.sendPrepaidInvoice(ref)).rejects.toThrow(
          new RegExp(`is ${status}, neither open nor paid`),
        );
      },
    );
  });

  describe("finalizeAndPayGauInvoice", () => {
    const ref = { settlementId: "set_001", invoiceId: "in_gau_001" };
    const invoice = (over: Record<string, unknown>) => ({
      id: "in_gau_001",
      amount_due: 2_500,
      hosted_invoice_url: "https://invoice.stripe.com/i/gau",
      collection_method: "charge_automatically",
      ...over,
    });
    const stripeError = (over: Record<string, unknown>) =>
      Object.assign(new Error(String(over.message ?? "stripe error")), over);

    it("finalizes a draft with auto_advance true, pays it off-session, each keyed on the settlement, and answers paid", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "draft" }),
      );
      stripeMethods.invoices.finalizeInvoice.mockResolvedValue(
        invoice({ status: "open" }),
      );
      stripeMethods.invoices.pay.mockResolvedValue(invoice({ status: "paid" }));

      const result = await provider.finalizeAndPayGauInvoice(ref);

      expect(result).toEqual({
        status: "paid",
        amountCents: 2_500,
        hostedInvoiceUrl: "https://invoice.stripe.com/i/gau",
      });
      expect(stripeMethods.invoices.finalizeInvoice).toHaveBeenCalledWith(
        "in_gau_001",
        { auto_advance: true },
        { idempotencyKey: "set_001:finalize" },
      );
      expect(stripeMethods.invoices.pay).toHaveBeenCalledWith(
        "in_gau_001",
        { off_session: true },
        { idempotencyKey: "set_001:pay" },
      );
    });

    it("pays an invoice that is already open without finalizing it again", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "open" }),
      );
      stripeMethods.invoices.pay.mockResolvedValue(invoice({ status: "paid" }));
      expect((await provider.finalizeAndPayGauInvoice(ref)).status).toBe(
        "paid",
      );
      expect(stripeMethods.invoices.finalizeInvoice).not.toHaveBeenCalled();
    });

    it("answers paid for an invoice already paid, with no request beyond the retrieve", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "paid" }),
      );
      expect((await provider.finalizeAndPayGauInvoice(ref)).status).toBe(
        "paid",
      );
      expect(stripeMethods.invoices.finalizeInvoice).not.toHaveBeenCalled();
      expect(stripeMethods.invoices.pay).not.toHaveBeenCalled();
    });

    it("never calls pay on a send_invoice invoice and answers open", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "draft", collection_method: "send_invoice" }),
      );
      stripeMethods.invoices.finalizeInvoice.mockResolvedValue(
        invoice({ status: "open", collection_method: "send_invoice" }),
      );
      expect((await provider.finalizeAndPayGauInvoice(ref)).status).toBe(
        "open",
      );
      expect(stripeMethods.invoices.pay).not.toHaveBeenCalled();
    });

    it.each([
      ["a card error", { rawType: "card_error", code: "card_declined" }],
      [
        "invoice_payment_intent_requires_action",
        {
          rawType: "invalid_request_error",
          code: "invoice_payment_intent_requires_action",
        },
      ],
      [
        "a customer with no payment source",
        {
          rawType: "invalid_request_error",
          message:
            "This customer has no attached payment source or default payment method.",
        },
      ],
    ])("answers open when pay fails with %s", async (_n, err) => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "open" }),
      );
      stripeMethods.invoices.pay.mockRejectedValue(stripeError(err));
      expect(await provider.finalizeAndPayGauInvoice(ref)).toEqual({
        status: "open",
        amountCents: 2_500,
        hostedInvoiceUrl: "https://invoice.stripe.com/i/gau",
      });
    });

    it("throws any other pay error", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "open" }),
      );
      stripeMethods.invoices.pay.mockRejectedValue(
        stripeError({ rawType: "api_error", message: "stripe is down" }),
      );
      await expect(provider.finalizeAndPayGauInvoice(ref)).rejects.toThrow(
        "stripe is down",
      );
    });

    it("throws for an invoice that is neither paid nor open", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue(
        invoice({ status: "void" }),
      );
      await expect(provider.finalizeAndPayGauInvoice(ref)).rejects.toThrow(
        /is void/,
      );
    });
  });

  describe("deleteOrVoidDraftInvoice", () => {
    const ref = { settlementId: "set_001", invoiceId: "in_gau_001" };
    const missing = () =>
      Object.assign(new Error("No such invoice"), {
        rawType: "invalid_request_error",
        code: "resource_missing",
      });

    it("deletes a draft", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue({ status: "draft" });
      stripeMethods.invoices.del.mockResolvedValue({ deleted: true });
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "deleted",
      });
      expect(stripeMethods.invoices.del).toHaveBeenCalledWith("in_gau_001");
      expect(stripeMethods.invoices.voidInvoice).not.toHaveBeenCalled();
    });

    it("voids an open invoice, keyed on the settlement", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue({ status: "open" });
      stripeMethods.invoices.voidInvoice.mockResolvedValue({ status: "void" });
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "voided",
      });
      expect(stripeMethods.invoices.voidInvoice).toHaveBeenCalledWith(
        "in_gau_001",
        {},
        { idempotencyKey: "set_001:void" },
      );
      expect(stripeMethods.invoices.del).not.toHaveBeenCalled();
    });

    it("answers paid for a paid invoice and writes nothing", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue({ status: "paid" });
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "paid",
      });
      expect(stripeMethods.invoices.del).not.toHaveBeenCalled();
      expect(stripeMethods.invoices.voidInvoice).not.toHaveBeenCalled();
    });

    it("answers absent for a void invoice and writes nothing", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue({ status: "void" });
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "absent",
      });
      expect(stripeMethods.invoices.del).not.toHaveBeenCalled();
      expect(stripeMethods.invoices.voidInvoice).not.toHaveBeenCalled();
    });

    it("answers absent for a deleted invoice (resource_missing on retrieve) and writes nothing", async () => {
      stripeMethods.invoices.retrieve.mockRejectedValue(missing());
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "absent",
      });
      expect(stripeMethods.invoices.del).not.toHaveBeenCalled();
    });

    it("answers absent when del finds the draft already deleted", async () => {
      stripeMethods.invoices.retrieve.mockResolvedValue({ status: "draft" });
      stripeMethods.invoices.del.mockRejectedValue(missing());
      expect(await provider.deleteOrVoidDraftInvoice(ref)).toEqual({
        outcome: "absent",
      });
    });

    it("throws an error it does not recognise", async () => {
      stripeMethods.invoices.retrieve.mockRejectedValue(new Error("timeout"));
      await expect(provider.deleteOrVoidDraftInvoice(ref)).rejects.toThrow(
        "timeout",
      );
    });
  });

  describe("createGauCheckout", () => {
    const input = {
      customerId: "cus_test_001",
      orgId: "org-1",
      quantityGau: 10_000,
      blocks: 2,
      blockPriceCents: 2_500,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      successUrl: "https://app.example.com/acme/billing?checkout=success",
      cancelUrl: "https://app.example.com/acme/billing?checkout=cancel",
    };
    const metadata = {
      oxagen_kind: "gau_purchase",
      org_id: "org-1",
      gau_quantity: "10000",
      block_size_gau: "5000",
      rate_per_gau_micros: "5000",
      currency: "usd",
    };

    it("builds a payment-mode session from one price_data line at the block price, quantity blocks, with an invoice and the card saved off-session", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );

      const result = await provider.createGauCheckout(input);

      expect(result).toEqual({
        sessionId: "cs_test_001",
        url: "https://checkout.stripe.com/pay/test_001",
      });
      expect(stripeMethods.checkout.sessions.create).toHaveBeenCalledOnce();
      expect(stripeMethods.checkout.sessions.create).toHaveBeenCalledWith({
        mode: "payment",
        customer: "cus_test_001",
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: 2_500,
              product_data: {
                name: "Oxagen governed action units",
                metadata: { oxagen_kind: "gau_block" },
              },
            },
            quantity: 2,
          },
        ],
        metadata,
        invoice_creation: { enabled: true, invoice_data: { metadata } },
        payment_method_types: ["card"],
        payment_intent_data: { setup_future_usage: "off_session", metadata },
        success_url: "https://app.example.com/acme/billing?checkout=success",
        cancel_url: "https://app.example.com/acme/billing?checkout=cancel",
        automatic_tax: { enabled: false },
        customer_update: undefined,
      });
    });

    it("never sends a pre-created price: the one line is price_data", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );
      await provider.createGauCheckout(input);
      const params = stripeMethods.checkout.sessions.create.mock
        .calls[0]![0] as { line_items: Array<Record<string, unknown>> };
      expect(params.line_items).toHaveLength(1);
      expect(params.line_items[0]).not.toHaveProperty("price");
    });

    it("throws when Stripe returns no checkout URL", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession({ url: null }),
      );
      await expect(provider.createGauCheckout(input)).rejects.toThrow(
        "checkout URL",
      );
    });

    /** The webhook envelope Stripe delivers, as parseWebhookEvent sees it. */
    function gauEvent(type: string, data: unknown): unknown {
      return {
        id: "evt_gau_001",
        api_version: "2025-02-24.acacia",
        type,
        data: { object: data },
      };
    }

    // The half of ADR-085 that makes the other half reachable: a refund reads
    // the CHARGE and nothing else, so unless the session puts the purchase
    // identity on payment_intent_data, `charge.refunded` cannot name the
    // organisation that was paid. These two tests walk the real path —
    // session params → the charge Stripe builds from them → parseWebhookEvent
    // — rather than asserting that a metadata key is present.
    it("puts the purchase identity where a charge can carry it: a charge built from the session's payment_intent_data resolves to the org", async () => {
      stripeMethods.checkout.sessions.create.mockResolvedValue(
        makeStripeCheckoutSession(),
      );
      await provider.createGauCheckout(input);
      const params = stripeMethods.checkout.sessions.create.mock
        .calls[0]![0] as {
        metadata: Record<string, string>;
        payment_intent_data: { metadata?: Record<string, string> };
      };

      // Stripe copies a PaymentIntent's metadata onto the Charge it creates;
      // the session's own metadata never reaches the charge. So the charge a
      // later refund reads is built from payment_intent_data alone.
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        gauEvent("charge.refunded", {
          id: "ch_gau_001",
          payment_intent: "pi_gau_001",
          amount_refunded: 5_000,
          currency: "usd",
          metadata: params.payment_intent_data.metadata,
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_gau_refund");

      expect(event.refundedCharge?.orgId).toBe("org-1");
      expect(event.refundedCharge?.metadata.oxagen_kind).toBe("gau_purchase");
      expect(event.refundedCharge?.paymentIntentId).toBe("pi_gau_001");
    });

    it("session metadata alone does not reach the charge — the same charge built without payment_intent_data resolves to no org", () => {
      // The pre-ADR-085 shape, kept as the control: if this ever starts
      // resolving, the test above has stopped proving anything.
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        gauEvent("charge.refunded", {
          id: "ch_gau_001",
          payment_intent: "pi_gau_001",
          amount_refunded: 5_000,
          currency: "usd",
          metadata: {},
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_gau_refund_2");

      expect(event.refundedCharge?.orgId).toBeNull();
      expect(event.refundedCharge?.metadata).toEqual({});
    });

    it("exposes the session's PaymentIntent, which is what the grant records for a dispute to find", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        gauEvent("checkout.session.completed", {
          id: "cs_gau_001",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_test_001",
          metadata,
          subscription: null,
          invoice: "in_gau_001",
          payment_intent: "pi_gau_001",
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_gau_session");

      expect(event.checkoutSession?.paymentIntentId).toBe("pi_gau_001");
    });
  });

  describe("getCheckoutPaymentMethod", () => {
    it("retrieves the session with payment_intent.payment_method expanded and returns the card", async () => {
      stripeMethods.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_test_001",
        payment_intent: {
          id: "pi_001",
          payment_method: makeStripePaymentMethod(),
        },
      });

      const pm = await provider.getCheckoutPaymentMethod("cs_test_001");

      expect(stripeMethods.checkout.sessions.retrieve).toHaveBeenCalledWith(
        "cs_test_001",
        { expand: ["payment_intent.payment_method"] },
      );
      expect(pm).toEqual({
        id: "pm_test_001",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2028,
      });
    });

    it("returns null when the payment method arrived as an id, the shape a one-level expansion leaves", async () => {
      stripeMethods.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_test_001",
        payment_intent: { id: "pi_001", payment_method: "pm_test_001" },
      });
      expect(await provider.getCheckoutPaymentMethod("cs_test_001")).toBeNull();
    });

    it("returns null when the session has no payment intent", async () => {
      stripeMethods.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_test_001",
        payment_intent: null,
      });
      expect(await provider.getCheckoutPaymentMethod("cs_test_001")).toBeNull();
    });

    it("returns null card details for a non-card payment method", async () => {
      stripeMethods.checkout.sessions.retrieve.mockResolvedValue({
        id: "cs_test_001",
        payment_intent: {
          id: "pi_001",
          payment_method: { id: "pm_link_001", type: "link" },
        },
      });
      expect(await provider.getCheckoutPaymentMethod("cs_test_001")).toEqual({
        id: "pm_link_001",
        type: "link",
        brand: null,
        last4: null,
        expMonth: null,
        expYear: null,
      });
    });
  });

  describe("getCheckoutSessionCreditPacks", () => {
    it("extracts creditsPerUnit from price metadata", async () => {
      const mockPaginatorResult = [
        {
          quantity: 2,
          price: {
            metadata: { credits: "500" },
            product: "prod_test",
          },
        },
      ];
      stripeMethods.checkout.sessions.listLineItems.mockReturnValue({
        autoPagingToArray: vi.fn().mockResolvedValue(mockPaginatorResult),
      });
      const packs = await provider.getCheckoutSessionCreditPacks("cs_test_001");
      expect(packs).toEqual([{ creditsPerUnit: 500, quantity: 2 }]);
    });

    it("skips line items with no credits metadata", async () => {
      const mockPaginatorResult = [
        { quantity: 1, price: { metadata: {}, product: null } },
      ];
      stripeMethods.checkout.sessions.listLineItems.mockReturnValue({
        autoPagingToArray: vi.fn().mockResolvedValue(mockPaginatorResult),
      });
      const packs = await provider.getCheckoutSessionCreditPacks("cs_test_001");
      expect(packs).toEqual([]);
    });
  });

  // ── Webhook ─────────────────────────────────────────────────────────────────

  describe("parseWebhookEvent", () => {
    function makeStripeEvent(type: string, data: unknown): unknown {
      return {
        id: "evt_test_001",
        api_version: "2025-02-24.acacia",
        type,
        data: { object: data },
      };
    }

    it("parses a subscription.created event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.created", { id: "sub_001" }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_001");
      expect(event.type).toBe("subscription.created");
      expect(event.subscriptionId).toBe("sub_001");
    });

    it("parses an invoice.paid event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("invoice.paid", makeStripeInvoice()),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_002");
      expect(event.type).toBe("invoice.paid");
      expect(event.invoice).toBeDefined();
      expect(event.invoice!.id).toBe("in_test_001");
    });

    it("parses a checkout.session.completed event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", {
          id: "cs_001",
          mode: "payment",
          payment_status: "paid",
          metadata: { org_id: "org-1" },
          subscription: null,
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_003");
      expect(event.type).toBe("checkout.session.completed");
      expect(event.checkoutSession?.id).toBe("cs_001");
      expect(event.checkoutSession?.mode).toBe("payment");
      expect(event.checkoutSession?.invoiceId).toBeNull();
      expect(event.checkoutSession?.customerId).toBeNull();
    });

    it("carries the invoice and customer of a checkout.session.completed event, whether Stripe sent ids or expanded objects", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", {
          id: "cs_002",
          mode: "payment",
          payment_status: "paid",
          customer: "cus_002",
          metadata: { oxagen_kind: "gau_purchase", org_id: "org-1" },
          subscription: null,
          invoice: "in_002",
        }),
      );
      const byId = provider.parseWebhookEvent("raw_body", "sig_003b");
      expect(byId.checkoutSession?.invoiceId).toBe("in_002");
      expect(byId.checkoutSession?.customerId).toBe("cus_002");

      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("checkout.session.completed", {
          id: "cs_003",
          mode: "payment",
          payment_status: "paid",
          customer: { id: "cus_003" },
          metadata: {},
          subscription: null,
          invoice: { id: "in_003" },
        }),
      );
      const expanded = provider.parseWebhookEvent("raw_body", "sig_003c");
      expect(expanded.checkoutSession?.invoiceId).toBe("in_003");
      expect(expanded.checkoutSession?.customerId).toBe("cus_003");
    });

    it("parses a payment_method.attached event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("payment_method.attached", makeStripePaymentMethod()),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_004");
      expect(event.type).toBe("payment_method.attached");
      expect(event.paymentMethod?.id).toBe("pm_test_001");
    });

    it("parses a payment_method.detached event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("payment_method.detached", makeStripePaymentMethod()),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_005");
      expect(event.type).toBe("payment_method.detached");
    });

    it("parses a charge.dispute.created event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("charge.dispute.created", {
          id: "dp_001",
          charge: "ch_001",
          payment_intent: "pi_001",
          amount: 5000,
          currency: "usd",
          reason: "fraudulent",
          status: "needs_response",
          metadata: { org_id: "org-1" },
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_006");
      expect(event.type).toBe("dispute.created");
      expect(event.dispute?.id).toBe("dp_001");
      expect(event.dispute?.orgId).toBe("org-1");
    });

    it("parses a charge.refunded event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("charge.refunded", {
          id: "ch_001",
          payment_intent: "pi_001",
          amount_refunded: 2000,
          currency: "usd",
          metadata: { org_id: "org-1" },
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_007");
      expect(event.type).toBe("charge.refunded");
      expect(event.refundedCharge?.id).toBe("ch_001");
    });

    it("maps unknown event type to 'unknown'", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("some.unknown.event", {}),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_008");
      expect(event.type).toBe("unknown");
    });

    it("parses payment_method.automatically_updated as payment_method.updated", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent(
          "payment_method.automatically_updated",
          makeStripePaymentMethod(),
        ),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_009");
      expect(event.type).toBe("payment_method.updated");
    });

    it("parses invoice.payment_action_required event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("invoice.payment_action_required", makeStripeInvoice()),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_010");
      expect(event.type).toBe("invoice.payment_action_required");
      expect(event.invoice).toBeDefined();
    });

    it("parses invoice.voided event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent(
          "invoice.voided",
          makeStripeInvoice({ status: "void" }),
        ),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_011");
      expect(event.type).toBe("invoice.voided");
    });

    it("parses invoice.finalized event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("invoice.finalized", makeStripeInvoice()),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_012");
      expect(event.type).toBe("invoice.finalized");
    });

    it("parses invoice.marked_uncollectible event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent(
          "invoice.marked_uncollectible",
          makeStripeInvoice({ status: "uncollectible" }),
        ),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_013");
      expect(event.type).toBe("invoice.marked_uncollectible");
    });

    it("parses charge.dispute.closed event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("charge.dispute.closed", {
          id: "dp_002",
          charge: "ch_002",
          payment_intent: null,
          amount: 1000,
          currency: "usd",
          reason: "product_not_received",
          status: "won",
          metadata: {},
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_014");
      expect(event.type).toBe("dispute.closed");
      expect(event.dispute?.status).toBe("won");
    });

    it("parses subscription.updated event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.updated", { id: "sub_upd_001" }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_015");
      expect(event.type).toBe("subscription.updated");
    });

    it("parses subscription.deleted event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.deleted", { id: "sub_del_001" }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_016");
      expect(event.type).toBe("subscription.deleted");
    });

    it("parses subscription.trial_will_end event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent("customer.subscription.trial_will_end", {
          id: "sub_trial_001",
        }),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_017");
      expect(event.type).toBe("subscription.trial_will_end");
    });

    it("parses invoice.created event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent(
          "invoice.created",
          makeStripeInvoice({ status: "draft" }),
        ),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_018");
      expect(event.type).toBe("invoice.created");
    });

    it("parses invoice.payment_failed event", () => {
      stripeMethods.webhooks.constructEvent.mockReturnValue(
        makeStripeEvent(
          "invoice.payment_failed",
          makeStripeInvoice({ status: "open" }),
        ),
      );
      const event = provider.parseWebhookEvent("raw_body", "sig_019");
      expect(event.type).toBe("invoice.payment_failed");
    });
  });

  describe("getCheckoutSessionCreditPacks — product metadata branch", () => {
    it("extracts creditsPerUnit from product.metadata when price.metadata has no credits", async () => {
      const mockPaginatorResult = [
        {
          quantity: 1,
          price: {
            metadata: {},
            product: {
              metadata: { credits: "1000" },
            },
          },
        },
      ];
      stripeMethods.checkout.sessions.listLineItems.mockReturnValue({
        autoPagingToArray: vi.fn().mockResolvedValue(mockPaginatorResult),
      });
      const packs = await provider.getCheckoutSessionCreditPacks("cs_test_002");
      expect(packs).toEqual([{ creditsPerUnit: 1000, quantity: 1 }]);
    });
  });
});

describe("getChargeMetadata — an outage is not an answer (ADR-085 §9)", () => {
  let provider: InstanceType<typeof StripeProvider>;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StripeProvider();
  });

  /** Stripe's SDK tags its errors with `type`; that is what classifies them. */
  function stripeError(type: string, message = "boom", code?: string): Error {
    return Object.assign(new Error(message), code ? { type, code } : { type });
  }

  it("returns the charge's metadata on a successful read", async () => {
    stripeMethods.charges.retrieve.mockResolvedValue({
      id: "ch_1",
      metadata: { oxagen_kind: "gau_purchase", org_id: "org-1" },
    });

    await expect(provider.getChargeMetadata("ch_1")).resolves.toEqual({
      oxagen_kind: "gau_purchase",
      org_id: "org-1",
    });
  });

  it("returns {} when Stripe says the charge does not exist — retrying cannot change that", async () => {
    // `resource_missing` is the one code that means "Stripe looked, and there
    // is no such charge". It is the sole definitive answer this classifier
    // recognises.
    stripeMethods.charges.retrieve.mockRejectedValue(
      stripeError(
        "StripeInvalidRequestError",
        "No such charge",
        "resource_missing",
      ),
    );

    await expect(provider.getChargeMetadata("ch_gone")).resolves.toEqual({});
  });

  // The sibling of the permission finding. An invalid request that is NOT
  // `resource_missing` — a bad expand, an API version we no longer send, a
  // malformed id — is OUR defect, not a fact about the charge. It is
  // correctable by a deploy, and until it is corrected it would otherwise
  // finalise every dispute that reached it: each one reads as "this charge
  // bought nothing", drops, and is marked processed for ever. Systematically
  // losing every disputed unit is far worse than a redelivery, so this
  // propagates too.
  it.each([
    ["a parameter we sent wrongly", "parameter_unknown"],
    ["an invalid request carrying no code at all", undefined],
  ])(
    "throws on an invalid request that is not resource_missing (%s)",
    async (_label, code) => {
      stripeMethods.charges.retrieve.mockRejectedValue(
        stripeError("StripeInvalidRequestError", "bad expand", code),
      );

      await expect(provider.getChargeMetadata("ch_1")).rejects.toThrow(
        "bad expand",
      );
    },
  );

  // The test is not "did Stripe answer" but "can this answer change on its
  // own?". A key that lacks charge-read permission can be granted it by an
  // operator minutes later, and the identical call then returns real metadata.
  // That is an operator-correctable condition, not a fact about the charge, so
  // it belongs on the retry path with the outages.
  it.each([
    ["StripeConnectionError"],
    ["StripeAPIError"],
    ["StripeRateLimitError"],
    ["StripeAuthenticationError"],
    ["StripePermissionError"],
    // Not a type this codebase knows. Unknown must fall to the safe side.
    ["StripeSomeFutureError"],
  ])("throws on %s so the webhook is retried", async (type) => {
    stripeMethods.charges.retrieve.mockRejectedValue(stripeError(type));

    await expect(provider.getChargeMetadata("ch_1")).rejects.toThrow();
  });

  // The classifier has two gates: the disposition table, then the
  // `resource_missing` narrowing. Every other test here clears BOTH, so none of
  // them can see the table entry alone change: flip `StripePermissionError` to
  // "definitive" and the narrowing still catches it, because a permission error
  // carries no `resource_missing` code. The suite stays green while the table —
  // the surface the SDK-upgrade `satisfies` check exists to force an answer on
  // — says the wrong thing.
  //
  // This isolates the first gate. A permission error is retried BECAUSE it is a
  // permission error, not because it happens to lack a code, so one carrying
  // the definitive code must still propagate.
  it("throws on a permission error even when it carries the definitive code", async () => {
    stripeMethods.charges.retrieve.mockRejectedValue(
      stripeError(
        "StripePermissionError",
        "key lacks charges:read",
        "resource_missing",
      ),
    );

    await expect(provider.getChargeMetadata("ch_1")).rejects.toThrow(
      "key lacks charges:read",
    );
  });

  it("throws on an error carrying no Stripe type at all", async () => {
    // A timeout from the transport layer, a DNS failure, an assertion — none
    // of them are Stripe answering. Unknown defaults to transient, because the
    // cost of an extra retry is far below the cost of a dropped dispute.
    stripeMethods.charges.retrieve.mockRejectedValue(new Error("ETIMEDOUT"));

    await expect(provider.getChargeMetadata("ch_1")).rejects.toThrow(
      "ETIMEDOUT",
    );
  });
});
