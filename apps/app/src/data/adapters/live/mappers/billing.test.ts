// Contract tests for the billing mappers: representative rows typed from the
// drizzle schema ($inferSelect) and the get_subscription contract output,
// parsed through the Billing view models.
import type { schema } from "@oxagen/database";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { describe, expect, it } from "vitest";
import { BillingPlan, Invoice } from "@/data/contracts";
import { NO_GAP } from "@/data/not-backed";
import {
  centsToMicros,
  type InvoiceRow,
  isIssued,
  latestGap,
  readInvoices,
  RecordedInvoice,
  type SubscriptionRead,
  toBillingPlan,
  toInvoiceMapping,
} from "./billing";

const NOT_RECORDED_YET = {
  ok: false,
  reason: "not_backed",
  milestone: "M0",
  gap: NO_GAP,
} as const;

/** A get_subscription output as the handler returns it, parsed by the contract. */
function subscriptionRead(
  over: Partial<SubscriptionRead> = {},
): SubscriptionRead {
  const output = billingSubscriptionRead.output.parse({
    subscription: {
      publicId: "sub_2kQ9v7XbT1c4Lm8Nw3Pq5R",
      status: "active",
      planSlug: "scale-v2",
      billingInterval: "month",
      currentPeriodStart: "2026-09-01T00:00:00.000Z",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      seatCount: 25,
      ...over,
    },
    creditBalanceCents: 13_200,
    periodUsage: null,
  });
  if (!output.subscription) throw new Error("fixture has a subscription");
  return output.subscription;
}

/** A billing.invoices row exactly as drizzle selects it. */
function invoiceRow(
  over: Partial<typeof schema.invoices.$inferSelect> = {},
): typeof schema.invoices.$inferSelect {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000001a1",
    publicId: "inv_8fJ2kL0pQ4sT6vX9zB1dF3",
    createdAt: new Date("2026-09-01T00:04:11.000Z"),
    updatedAt: new Date("2026-09-01T00:09:30.000Z"),
    createdByUserId: null,
    updatedByUserId: null,
    orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
    subscriptionId: "0192d4a8-7c1e-7a00-8000-0000000005b1",
    stripeInvoiceId: "in_1Q2w3E4r5T6y7U8i",
    number: "8F2A1C3D-0007",
    status: "paid",
    amountDueCents: 71_520,
    amountPaidCents: 71_520,
    amountRemainingCents: 0,
    currency: "usd",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
    dueAt: null,
    paidAt: new Date("2026-09-01T00:09:28.000Z"),
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1/test_1",
    invoicePdfUrl: "https://pay.stripe.com/invoice/acct_1/test_1/pdf",
    ...over,
  };
}

describe("toBillingPlan", () => {
  it("maps an active Scale subscription onto the view model, parsed", () => {
    const read = toBillingPlan({
      subscription: subscriptionRead(),
      tier: "scale",
    });
    expect(read).toEqual({
      ok: true,
      value: {
        plan: "team",
        status: "active",
        nextInvoiceOn: "2026-10-01",
        discount: null,
      },
    });
    if (read.ok) expect(BillingPlan.parse(read.value)).toEqual(read.value);
  });

  it.each([
    ["free", "free"],
    ["build", "team"],
    ["scale", "team"],
    ["enterprise", "enterprise"],
  ] as const)("plans.tier %s is plan %s", (tier, plan) => {
    const read = toBillingPlan({ subscription: subscriptionRead(), tier });
    expect(read.ok && read.value.plan).toBe(plan);
  });

  it.each([
    ["active", "active"],
    ["past_due", "past_due"],
    ["canceled", "cancelled"],
  ] as const)("subscriptions.status %s is status %s", (status, expected) => {
    const read = toBillingPlan({
      subscription: subscriptionRead({ status }),
      tier: "build",
    });
    expect(read.ok && read.value.status).toBe(expected);
  });

  it("takes the next invoice day from current_period_end in UTC", () => {
    const read = toBillingPlan({
      subscription: subscriptionRead({
        currentPeriodEnd: "2026-10-01T02:30:00+05:00",
      }),
      tier: "build",
    });
    expect(read.ok && read.value.nextInvoiceOn).toBe("2026-09-30");
  });

  it("an organization with no subscription is not recorded yet, never a free plan with a made-up invoice day", () => {
    expect(toBillingPlan({ subscription: null, tier: null })).toEqual(
      NOT_RECORDED_YET,
    );
  });

  it.each(["trialing", "paused", "incomplete", "constructor"])(
    "status %s has no view-model value, so the plan is not recorded yet",
    (status) => {
      expect(
        toBillingPlan({
          subscription: subscriptionRead({ status }),
          tier: "scale",
        }),
      ).toEqual(NOT_RECORDED_YET);
    },
  );

  it.each([null, "platinum", "toString", "__proto__"])(
    "tier %s maps to no plan, so the plan is not recorded yet",
    (tier) => {
      expect(toBillingPlan({ subscription: subscriptionRead(), tier })).toEqual(
        NOT_RECORDED_YET,
      );
    },
  );

  it("a subscription cancelling at period end has no next invoice to show", () => {
    expect(
      toBillingPlan({
        subscription: subscriptionRead({ cancelAtPeriodEnd: true }),
        tier: "scale",
      }),
    ).toEqual(NOT_RECORDED_YET);
  });
});

describe("toInvoiceMapping", () => {
  it("parses the recorded columns of a real row through the view model", () => {
    const row: InvoiceRow = invoiceRow();
    const mapping = toInvoiceMapping(row);
    expect(mapping.recorded).toEqual({
      number: "8F2A1C3D-0007",
      period: "2026-08",
      amount: { micros: "715200000", currency: "USD" },
      status: "paid",
    });
    expect(RecordedInvoice.parse(mapping.recorded)).toEqual(mapping.recorded);
  });

  it("names runs (G13) and the issue day as unrecorded on every row, never zero", () => {
    const { unrecorded } = toInvoiceMapping(invoiceRow());
    expect(unrecorded).toEqual([
      { field: "runs", milestone: "M2", gap: "G13" },
      { field: "issuedOn", milestone: "M0", gap: NO_GAP },
    ]);
    // What a whole Invoice would need that no column supplies.
    expect(
      Invoice.safeParse(toInvoiceMapping(invoiceRow()).recorded).success,
    ).toBe(false);
  });

  it.each(["open", "void"])("keeps status %s as recorded", (status) => {
    expect(toInvoiceMapping(invoiceRow({ status })).recorded?.status).toBe(
      status,
    );
  });

  it("an uncollectible invoice has no view-model status", () => {
    const mapping = toInvoiceMapping(invoiceRow({ status: "uncollectible" }));
    expect(mapping.recorded).toBeNull();
    expect(mapping.unrecorded).toContainEqual({
      field: "status",
      milestone: "M0",
      gap: NO_GAP,
    });
  });

  it("an invoice without a number is not shown with an invented one", () => {
    const mapping = toInvoiceMapping(invoiceRow({ number: null }));
    expect(mapping.recorded).toBeNull();
    expect(mapping.unrecorded.map((u) => u.field)).toContain("number");
  });

  it("dates the period by period_start in UTC", () => {
    const mapping = toInvoiceMapping(
      invoiceRow({ periodStart: new Date("2026-06-30T23:30:00-02:00") }),
    );
    expect(mapping.recorded?.period).toBe("2026-07");
  });
});

describe("readInvoices", () => {
  it("an organization with no invoices has an honest empty list", () => {
    expect(readInvoices([])).toEqual({ ok: true, value: [] });
  });

  it("drafts are not issued invoices", () => {
    expect(isIssued({ status: "draft" })).toBe(false);
    expect(isIssued({ status: "open" })).toBe(true);
    expect(
      readInvoices([invoiceRow({ status: "draft", number: null })]),
    ).toEqual({
      ok: true,
      value: [],
    });
  });

  it("any issued invoice reads as not backed on G13, never with a run count of zero", () => {
    expect(
      readInvoices([invoiceRow(), invoiceRow({ status: "uncollectible" })]),
    ).toEqual({ ok: false, reason: "not_backed", milestone: "M2", gap: "G13" });
  });
});

describe("centsToMicros", () => {
  it("is exact for amounts a float would round", () => {
    expect(centsToMicros(0)).toBe("0");
    expect(centsToMicros(1)).toBe("10000");
    expect(centsToMicros(-19_308)).toBe("-193080000");
    expect(centsToMicros(Number.MAX_SAFE_INTEGER)).toBe("90071992547409910000");
  });

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s cents",
    (cents) => {
      expect(() => centsToMicros(cents)).toThrow(RangeError);
    },
  );
});

describe("latestGap", () => {
  it("reports the latest milestone among the unrecorded fields", () => {
    expect(
      latestGap([
        { field: "issuedOn", milestone: "M0", gap: NO_GAP },
        { field: "runs", milestone: "M2", gap: "G13" },
        { field: "status", milestone: "M0", gap: NO_GAP },
      ]),
    ).toEqual({ ok: false, reason: "not_backed", milestone: "M2", gap: "G13" });
  });

  it("refuses to invent a gap for nothing", () => {
    expect(() => latestGap([])).toThrow();
  });
});
