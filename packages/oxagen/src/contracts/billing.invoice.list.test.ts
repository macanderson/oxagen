import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  billingInvoiceList,
  invoiceItemSchema,
  invoiceKindSchema,
} from "./billing.invoice.list";

const item = {
  publicId: "inv_4q8r1t6v3x5z0b2d7h2k9m",
  number: "OXG-0042",
  status: "paid",
  kind: "gau_purchase",
  amountDueMicros: "25000000",
  amountPaidMicros: "25000000",
  currency: "usd",
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
  hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_abc",
};

describe("list_invoices contract", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("list_invoices")).toBe(billingInvoiceList);
  });

  it("is a billing-page read: mutates false, noBillingGate true, scoped, Owner/Admin/Billing", () => {
    expect(billingInvoiceList.mutates).toBe(false);
    expect(billingInvoiceList.noBillingGate).toBe(true);
    expect(billingInvoiceList.scoped).toBe(true);
    expect(billingInvoiceList.defaultEffect).toBe("deny");
    expect(billingInvoiceList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Billing: "allow" },
      workspace: {},
    });
    expect(billingInvoiceList.layers).not.toContain("e2e");
  });

  it("defaults the page size and refuses a size outside 1…100 or an unknown key", () => {
    expect(billingInvoiceList.input.parse({})).toEqual({ limit: 50 });
    expect(
      billingInvoiceList.input.parse({ limit: 10, cursor: "abc" }),
    ).toEqual({ limit: 10, cursor: "abc" });
    expect(billingInvoiceList.input.safeParse({ limit: 0 }).success).toBe(
      false,
    );
    expect(billingInvoiceList.input.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(billingInvoiceList.input.safeParse({ status: "open" }).success).toBe(
      false,
    );
  });

  it("names the subscription and the four settlement kinds, and nothing else", () => {
    expect(invoiceKindSchema.options).toEqual([
      "subscription",
      "gau_purchase",
      "gau_auto_topup",
      "gau_interim",
      "gau_period_close",
    ]);
    expect(
      invoiceItemSchema.safeParse({ ...item, kind: "checkout" }).success,
    ).toBe(false);
  });

  it("carries money as micro-unit strings and refuses a number or a float string", () => {
    expect(invoiceItemSchema.parse(item)).toEqual(item);
    expect(
      invoiceItemSchema.safeParse({ ...item, amountDueMicros: 25000000 })
        .success,
    ).toBe(false);
    expect(
      invoiceItemSchema.safeParse({ ...item, amountPaidMicros: "25.00" })
        .success,
    ).toBe(false);
  });

  it("admits a null number and a null hosted URL, and refuses a draft", () => {
    const unpublished = { ...item, number: null, hostedInvoiceUrl: null };
    expect(invoiceItemSchema.parse(unpublished)).toEqual(unpublished);
    expect(
      invoiceItemSchema.safeParse({ ...item, status: "draft" }).success,
    ).toBe(false);
  });

  it("refuses an item with an extra key and a page over the limit", () => {
    expect(
      invoiceItemSchema.safeParse({ ...item, amountRemainingMicros: "0" })
        .success,
    ).toBe(false);
    const page = {
      items: Array.from({ length: 101 }, () => item),
      nextCursor: null,
    };
    expect(billingInvoiceList.output.safeParse(page).success).toBe(false);
  });
});
