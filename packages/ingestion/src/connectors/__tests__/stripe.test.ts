import { describe, it, expect } from "vitest";
import { stripe } from "../stripe/index";
import {
  loadBuiltInSchema,
  validateConfigAgainstSchema,
} from "../../connector-schema-loader";

describe("stripe connector – normalizeRecord", () => {
  describe("customer", () => {
    it("maps a realistic customer payload", () => {
      const raw = {
        id: "cus_ABC123",
        object: "customer",
        name: "ACME Corp",
        email: "billing@acme.com",
        phone: "+1-555-1234",
        description: "Enterprise account",
        currency: "usd",
        balance: -5000,
        delinquent: false,
        livemode: true,
        address: { city: "San Francisco", country: "US" },
        metadata: { plan: "enterprise" },
        created: 1_700_000_000,
      };
      const result = stripe.normalizeRecord("customer", raw);
      expect(result.externalId).toBe("cus_ABC123");
      expect(result.displayName).toBe("ACME Corp");
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/customers/cus_ABC123",
      );
      expect(result.properties["email"]).toBe("billing@acme.com");
      expect(result.properties["balanceMinor"]).toBe(-5000);
      expect(result.properties["country"]).toBe("US");
      expect(result.properties["createdAt"]).toBe("2023-11-14T22:13:20.000Z");
    });

    it("falls back to email then id for the display name", () => {
      expect(
        stripe.normalizeRecord("customer", { id: "cus_1", email: "a@b.com" })
          .displayName,
      ).toBe("a@b.com");
      expect(
        stripe.normalizeRecord("customer", { id: "cus_1" }).displayName,
      ).toBe("cus_1");
    });

    it("handles an empty customer gracefully", () => {
      const result = stripe.normalizeRecord("customer", {});
      expect(result.externalId).toBe("");
      expect(result.properties["createdAt"]).toBeUndefined();
    });
  });

  describe("charge", () => {
    it("reports money in minor units under an unambiguous name", () => {
      const raw = {
        id: "ch_1",
        amount: 2000,
        amount_captured: 2000,
        amount_refunded: 500,
        currency: "usd",
        status: "succeeded",
        paid: true,
        captured: true,
        refunded: false,
        disputed: false,
        customer: "cus_ABC123",
        payment_intent: "pi_1",
        description: "Pro plan — March",
        created: 1_700_000_000,
      };
      const result = stripe.normalizeRecord("charge", raw);
      expect(result.externalId).toBe("ch_1");
      expect(result.displayName).toBe("Pro plan — March");
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/payments/ch_1",
      );
      // 2000 is $20.00 USD — minor units, never a decimal amount.
      expect(result.properties["amountMinor"]).toBe(2000);
      expect(result.properties["amountRefundedMinor"]).toBe(500);
      expect(result.properties["currency"]).toBe("usd");
      expect(result.properties["customerId"]).toBe("cus_ABC123");
      expect(result.properties).not.toHaveProperty("amount");
    });

    it("labels an undescribed charge by id", () => {
      expect(stripe.normalizeRecord("charge", { id: "ch_2" }).displayName).toBe(
        "Charge ch_2",
      );
    });

    it("carries a failure reason through", () => {
      const result = stripe.normalizeRecord("charge", {
        id: "ch_3",
        status: "failed",
        failure_code: "card_declined",
        failure_message: "Your card was declined.",
      });
      expect(result.properties["failureCode"]).toBe("card_declined");
      expect(result.properties["failureMessage"]).toBe(
        "Your card was declined.",
      );
    });
  });

  describe("refund", () => {
    it("maps a refund and links it to the payment it reverses", () => {
      const raw = {
        id: "re_1",
        amount: 1500,
        currency: "usd",
        status: "succeeded",
        reason: "requested_by_customer",
        charge: "ch_1",
        payment_intent: "pi_1",
        receipt_number: "1234-5678",
        created: 1_700_000_500,
      };
      const result = stripe.normalizeRecord("refund", raw);
      expect(result.externalId).toBe("re_1");
      expect(result.displayName).toBe("Refund re_1");
      // A refund has no dashboard page of its own.
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/payments/ch_1",
      );
      expect(result.properties["amountMinor"]).toBe(1500);
      expect(result.properties["reason"]).toBe("requested_by_customer");
      expect(result.properties["chargeId"]).toBe("ch_1");
    });

    it("omits the url when the refund names no charge", () => {
      expect(
        stripe.normalizeRecord("refund", { id: "re_2" }).externalUrl,
      ).toBeUndefined();
    });
  });

  describe("subscription", () => {
    it("lifts price ids out of the nested items list", () => {
      const raw = {
        id: "sub_1",
        customer: "cus_ABC123",
        status: "active",
        currency: "usd",
        collection_method: "charge_automatically",
        cancel_at_period_end: false,
        created: 1_700_000_000,
        start_date: 1_700_000_000,
        current_period_start: 1_700_000_000,
        current_period_end: 1_702_592_000,
        items: {
          data: [
            { id: "si_1", quantity: 3, price: { id: "price_pro" } },
            { id: "si_2", quantity: 1, price: { id: "price_addon" } },
          ],
        },
      };
      const result = stripe.normalizeRecord("subscription", raw);
      expect(result.externalId).toBe("sub_1");
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/subscriptions/sub_1",
      );
      expect(result.properties["status"]).toBe("active");
      expect(result.properties["priceIds"]).toEqual([
        "price_pro",
        "price_addon",
      ]);
      expect(result.properties["quantity"]).toBe(3);
      expect(result.properties["currentPeriodEnd"]).toBe(
        "2023-12-14T22:13:20.000Z",
      );
    });

    it("handles a subscription with no items", () => {
      const result = stripe.normalizeRecord("subscription", { id: "sub_2" });
      expect(result.properties["priceIds"]).toEqual([]);
      expect(result.properties["quantity"]).toBeUndefined();
    });
  });

  describe("invoice", () => {
    it("prefers the hosted invoice page as the external url", () => {
      const raw = {
        id: "in_1",
        number: "ACME-0001",
        status: "paid",
        currency: "usd",
        total: 12_000,
        subtotal: 12_000,
        amount_due: 12_000,
        amount_paid: 12_000,
        amount_remaining: 0,
        paid: true,
        customer: "cus_ABC123",
        customer_email: "billing@acme.com",
        subscription: "sub_1",
        hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/live_ABC",
        created: 1_700_000_000,
      };
      const result = stripe.normalizeRecord("invoice", raw);
      expect(result.displayName).toBe("ACME-0001");
      expect(result.externalUrl).toBe(
        "https://invoice.stripe.com/i/acct_1/live_ABC",
      );
      expect(result.properties["totalMinor"]).toBe(12_000);
      expect(result.properties["amountRemainingMinor"]).toBe(0);
      expect(result.properties["subscriptionId"]).toBe("sub_1");
    });

    it("falls back to the dashboard invoice page and the id", () => {
      const result = stripe.normalizeRecord("invoice", { id: "in_2" });
      expect(result.displayName).toBe("Invoice in_2");
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/invoices/in_2",
      );
    });
  });

  describe("dispute", () => {
    it("maps a dispute and its evidence deadline", () => {
      const raw = {
        id: "dp_1",
        amount: 2000,
        currency: "usd",
        status: "warning_needs_response",
        reason: "fraudulent",
        charge: "ch_1",
        payment_intent: "pi_1",
        is_charge_refundable: true,
        evidence_details: { due_by: 1_702_592_000 },
        created: 1_700_000_000,
      };
      const result = stripe.normalizeRecord("dispute", raw);
      expect(result.externalId).toBe("dp_1");
      expect(result.externalUrl).toBe(
        "https://dashboard.stripe.com/disputes/dp_1",
      );
      expect(result.properties["amountMinor"]).toBe(2000);
      expect(result.properties["reason"]).toBe("fraudulent");
      expect(result.properties["evidenceDueBy"]).toBe(
        "2023-12-14T22:13:20.000Z",
      );
    });
  });

  describe("unknown record type", () => {
    it("throws rather than silently producing an empty record", () => {
      expect(() => stripe.normalizeRecord("payout", { id: "po_1" })).toThrow(
        /unknown sourceRecordType "payout"/,
      );
    });
  });
});

describe("stripe connector – definition", () => {
  it("declares api-key auth and polling delivery", () => {
    expect(stripe.connectorId).toBe("stripe");
    expect(stripe.displayName).toBe("Stripe");
    expect(stripe.supportedAuthSchemes).toEqual(["api_key"]);
    expect(stripe.deliveryMethod).toBe("rest_polling");
    expect(typeof stripe.poll).toBe("function");
    expect(typeof stripe.cursorOf).toBe("function");
  });

  it("applies config defaults", () => {
    const parsed = stripe.connectionConfigSchema.parse({});
    expect(parsed).toEqual({ syncDepthDays: 90, pageSize: 100 });
  });

  it("rejects a page size above Stripe's maximum of 100", () => {
    expect(() =>
      stripe.connectionConfigSchema.parse({ pageSize: 250 }),
    ).toThrow();
  });
});

describe("stripe connector – schema.yaml", () => {
  const schema = loadBuiltInSchema("stripe");

  it("parses as a ConnectorPlugin with matching metadata", () => {
    expect(schema).not.toBeNull();
    expect(schema?.apiVersion).toBe("oxagen.ai/v1alpha1");
    expect(schema?.kind).toBe("ConnectorPlugin");
    expect(schema?.metadata.id).toBe("stripe");
    expect(schema?.metadata.displayName).toBe("Stripe");
    expect(schema?.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(schema?.auth?.schemes.length).toBeGreaterThan(0);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("declares only record types normalizeRecord understands", () => {
    const recordTypes = schema?.["recordTypes"] as {
      items: Array<{ id: string }>;
    };
    const ids = recordTypes.items.map((i) => i.id);
    expect(ids).toEqual([
      "customer",
      "charge",
      "refund",
      "subscription",
      "invoice",
      "dispute",
    ]);
    for (const id of ids) {
      expect(() => stripe.normalizeRecord(id, { id: "x" })).not.toThrow();
    }
  });

  it("accepts a valid config and a secret or restricted key", () => {
    for (const apiKey of [
      "sk_test_51ABCDEFGHIJKLMNOP",
      "rk_live_51ABCDEFGHIJKLMNOP",
    ]) {
      const errors = validateConfigAgainstSchema(
        { apiKey, syncDepthDays: 90, pageSize: 100 },
        schema!,
        "restricted_key",
      );
      expect(errors).toEqual([]);
    }
  });

  it("rejects a publishable key, the common paste mistake", () => {
    const errors = validateConfigAgainstSchema(
      { apiKey: "pk_test_51ABCDEFGHIJKLMNOP" },
      schema!,
      "restricted_key",
    );
    expect(errors).toContainEqual(
      expect.objectContaining({ field: "auth.apiKey", code: "pattern" }),
    );
  });

  it("requires the api key and bounds the numeric config fields", () => {
    expect(
      validateConfigAgainstSchema({}, schema!, "restricted_key"),
    ).toContainEqual(
      expect.objectContaining({ field: "auth.apiKey", code: "required" }),
    );
    expect(
      validateConfigAgainstSchema({ pageSize: 500 }, schema!),
    ).toContainEqual(
      expect.objectContaining({ field: "config.pageSize", code: "max" }),
    );
    expect(
      validateConfigAgainstSchema({ syncDepthDays: 0 }, schema!),
    ).toContainEqual(
      expect.objectContaining({ field: "config.syncDepthDays", code: "min" }),
    );
  });

  it("constrains the optional connected-account id", () => {
    expect(
      validateConfigAgainstSchema({ stripeAccount: "not-an-account" }, schema!),
    ).toContainEqual(
      expect.objectContaining({
        field: "config.stripeAccount",
        code: "pattern",
      }),
    );
    expect(
      validateConfigAgainstSchema({ stripeAccount: "acct_1ABC" }, schema!),
    ).toEqual([]);
  });
});
