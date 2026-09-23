// The period statement (statement.ts): how the governed-action line is priced
// in each billing mode, the plan line from the subscription's own invoices in
// the bucket month, tokens and retention at zero, and a total rounded once,
// half to even, or null when a line is not recorded.
import { describe, expect, it } from "vitest";
import {
  contractRate,
  evidenceRetention,
  invoiceBucket,
  invoiceRow,
  prepaidBucket,
  PUBLISHED_BUILD,
  SUBSCRIPTION,
} from "./billing.builders";
import { statementFor } from "./statement";

const usd = (micros: string) => ({ micros, currency: "USD" });

/** 159 blocks of 10,000 at $32.10 a block, past a 250,000 allowance. */
const blocksBucket = prepaidBucket({
  includedGau: 250_000,
  purchasedGau: 1_590_000,
  carriedGau: 0,
  usedGau: 1_837_838,
  remainingGau: 2_162,
});

describe("statementFor", () => {
  it("prices whole blocks bought this period at the block price", () => {
    const s = statementFor({
      plan: { subscription: null },
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(s.aboveIncluded).toBe(1_587_838);
    expect(s.charge).toEqual({
      kind: "blocks",
      blocks: 159,
      blockPrice: usd("32100000"),
    });
    expect(s.governedAmount).toEqual(usd("5103900000"));
    expect(s.plan).toBeNull();
    expect(s.tokensAmount).toEqual(usd("0"));
    expect(s.retentionAmount).toEqual(usd("0"));
    expect(s.total).toEqual(usd("5103900000"));
    expect(s.currency).toBe("USD");
  });

  it("prices a purchase that is not whole blocks at the per-action rate", () => {
    const s = statementFor({
      plan: { subscription: null },
      bucket: prepaidBucket({ purchasedGau: 5_000 }),
      rate: contractRate(),
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(s.charge).toEqual({
      kind: "bought",
      count: 5_000,
      rate: usd("3210"),
    });
    expect(s.governedAmount).toEqual(usd("16050000"));
  });

  it("prices invoice-billed overage past the allowance and what was carried", () => {
    const s = statementFor({
      plan: { subscription: null },
      bucket: invoiceBucket(),
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(s.charge).toEqual({
      kind: "overage",
      count: 112_500,
      rate: usd("5000"),
    });
    expect(s.governedAmount).toEqual(usd("562500000"));
    expect(s.aboveIncluded).toBe(112_500);
  });

  it("never reports a negative count under the allowance (negative)", () => {
    const s = statementFor({
      plan: { subscription: null },
      bucket: invoiceBucket({}),
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      invoices: [],
    });
    const under = statementFor({
      plan: { subscription: null },
      bucket: { ...invoiceBucket(), usedGau: 10, remainingGau: 299_990 },
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(s.aboveIncluded).toBeGreaterThan(0);
    expect(under.aboveIncluded).toBe(0);
    expect(under.charge).toMatchObject({ kind: "overage", count: 0 });
    expect(under.governedAmount).toEqual(usd("0"));
  });

  it("sums the subscription's own invoices in the bucket month into the plan line", () => {
    const s = statementFor({
      plan: { subscription: SUBSCRIPTION },
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      invoices: [
        invoiceRow({
          kind: "subscription",
          amountDue: usd("199000000"),
        }),
        // A block purchase is on the governed-action line, not the plan's.
        invoiceRow({ kind: "gau_purchase" }),
        // August's subscription invoice is not this period's.
        invoiceRow({
          kind: "subscription",
          periodStart: "2026-08-01T00:00:00.000Z",
          periodEnd: "2026-08-31T00:00:00.000Z",
        }),
      ],
    });
    expect(s.plan).toEqual({
      subscription: SUBSCRIPTION,
      tier: "enterprise",
      invoices: 1,
      amount: usd("199000000"),
    });
    expect(s.total).toEqual(usd("5302900000"));
  });

  it("prints a plan line of zero when Stripe has not invoiced the plan this period", () => {
    const s = statementFor({
      plan: { subscription: SUBSCRIPTION },
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(s.plan).toMatchObject({ invoices: 0, amount: usd("0") });
  });

  it("leaves the total unrecorded when a plan invoice is in another currency (negative)", () => {
    const s = statementFor({
      plan: { subscription: SUBSCRIPTION },
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      invoices: [
        invoiceRow({
          kind: "subscription",
          amountDue: { micros: "199000000", currency: "EUR" },
        }),
      ],
    });
    expect(s.total).toBeNull();
  });

  it("leaves retention and the total unrecorded once extended retention is on (negative)", () => {
    const s = statementFor({
      plan: { subscription: null },
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention({ extendedRetentionEnabled: true }),
      invoices: [],
    });
    expect(s.retentionAmount).toBeNull();
    expect(s.total).toBeNull();
  });

  it("rounds the total to cents once, half to even", () => {
    // 1,001 actions at $0.000005 is $0.005005: rounds up past the half.
    const up = statementFor({
      plan: { subscription: null },
      bucket: { ...invoiceBucket(), usedGau: 300_000 + 1_001 },
      rate: contractRate({ ratePerGau: usd("5") }),
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(up.governedAmount).toEqual(usd("5005"));
    expect(up.total).toEqual(usd("10000"));
    // 1,000 actions at $0.000005 is exactly half a cent: rounds to the even 0.
    const even = statementFor({
      plan: { subscription: null },
      bucket: { ...invoiceBucket(), usedGau: 300_000 + 1_000 },
      rate: contractRate({ ratePerGau: usd("5") }),
      retention: evidenceRetention(),
      invoices: [],
    });
    expect(even.total).toEqual(usd("0"));
  });
});
