/**
 * Unit tests for stripe-provider.ts — StripeProvider implementation.
 *
 * Mocks the Stripe SDK so no real API calls are made. Tests cover:
 *  - findCustomerByOrgId
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
  checkout: {
    sessions: {
      create: vi.fn(),
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

  describe("previewSeatChange", () => {
    it("returns proration preview with amountCents", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.invoices.createPreview.mockResolvedValue({
        currency: "usd",
        lines: {
          data: [
            { proration: true, description: "Unused time", amount: -500 },
            { proration: true, description: "Remaining time", amount: 800 },
          ],
        },
      });
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
      stripeMethods.invoices.createPreview.mockResolvedValue({
        currency: "usd",
        lines: {
          data: [
            { proration: true, description: "Plan upgrade", amount: 1200 },
          ],
        },
      });
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_scale_monthly",
      });
      expect(preview.amountCents).toBe(1200);
      expect(preview.isCharge).toBe(true);
    });

    it("returns negative amountCents for a downgrade", async () => {
      stripeMethods.subscriptions.retrieve.mockResolvedValue(makeStripeSub());
      stripeMethods.invoices.createPreview.mockResolvedValue({
        currency: "usd",
        lines: {
          data: [
            { proration: true, description: "Downgrade credit", amount: -900 },
          ],
        },
      });
      const preview = await provider.previewPlanChange("sub_test_001", {
        newPriceId: "price_build_monthly",
      });
      expect(preview.amountCents).toBe(-900);
      expect(preview.isCharge).toBe(false);
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
