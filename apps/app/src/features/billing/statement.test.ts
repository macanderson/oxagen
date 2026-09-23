// The period statement (statement.ts): how the governed-action line is priced
// in each billing mode and the count it is labelled with, tokens and
// retention at zero, the onboarding discount, and a total rounded once, half
// to even, after the discount, or null while any line is not recorded.
import { describe, expect, it } from "vitest";
import type { Money } from "@/data/contracts/money";
import {
  contractRate,
  evidenceRetention,
  invoiceBucket,
  prepaidBucket,
  PUBLISHED_BUILD,
} from "./billing.builders";
import { statementFor } from "./statement";

const usd = (micros: string) => ({ micros, currency: "USD" });
const ZERO: Money = usd("0");

/** 159 blocks of 10,000 at $32.10 a block, past a 250,000 allowance. */
const blocksBucket = prepaidBucket({
  includedGau: 250_000,
  purchasedGau: 1_590_000,
  carriedGau: 0,
  usedGau: 1_837_838,
  remainingGau: 2_162,
});

describe("statementFor", () => {
  it("prices whole blocks bought this period at the block price, and labels the line with the actions it priced", () => {
    const s = statementFor({
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(s.pricedCount).toBe(1_590_000);
    expect(s.charge).toEqual({
      kind: "blocks",
      blocks: 159,
      blockPrice: usd("32100000"),
    });
    expect(s.governedAmount).toEqual(usd("5103900000"));
    expect(s.tokensAmount).toEqual(ZERO);
    expect(s.retentionAmount).toEqual(ZERO);
    expect(s.discountAmount).toEqual(ZERO);
    expect(s.total).toEqual(usd("5103900000"));
    expect(s.currency).toBe("USD");
  });

  it("prices a purchase that is not whole blocks at the per-action rate", () => {
    const s = statementFor({
      bucket: prepaidBucket({ purchasedGau: 5_000 }),
      rate: contractRate(),
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(s.charge).toEqual({
      kind: "bought",
      count: 5_000,
      rate: usd("3210"),
    });
    expect(s.pricedCount).toBe(5_000);
    expect(s.governedAmount).toEqual(usd("16050000"));
  });

  it("prices invoice-billed overage past the allowance and what was carried", () => {
    const s = statementFor({
      bucket: invoiceBucket(),
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(s.charge).toEqual({
      kind: "overage",
      count: 112_500,
      rate: usd("5000"),
    });
    expect(s.pricedCount).toBe(112_500);
    expect(s.governedAmount).toEqual(usd("562500000"));
  });

  it("labels invoice-billed overage with the priced count, less what was carried in", () => {
    const s = statementFor({
      bucket: { ...invoiceBucket(), carriedGau: 10_000 },
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(s.pricedCount).toBe(102_500);
  });

  it("never reports a negative count under the allowance (negative)", () => {
    const under = statementFor({
      bucket: { ...invoiceBucket(), usedGau: 10, remainingGau: 299_990 },
      rate: PUBLISHED_BUILD,
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(under.pricedCount).toBe(0);
    expect(under.charge).toMatchObject({ kind: "overage", count: 0 });
    expect(under.governedAmount).toEqual(ZERO);
  });

  it("subtracts the onboarding discount before the total", () => {
    const s = statementFor({
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      discount: usd("-1020780000"),
    });
    expect(s.discountAmount).toEqual(usd("-1020780000"));
    expect(s.total).toEqual(usd("4083120000"));
  });

  it("leaves the total unrecorded while the onboarding discount is not recorded (negative)", () => {
    const s = statementFor({
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      discount: null,
    });
    expect(s.discountAmount).toBeNull();
    expect(s.governedAmount).toEqual(usd("5103900000"));
    expect(s.total).toBeNull();
  });

  it("leaves the total unrecorded when the discount is in another currency (negative)", () => {
    const s = statementFor({
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention(),
      discount: { micros: "-1000000", currency: "EUR" },
    });
    expect(s.total).toBeNull();
  });

  it("leaves retention and the total unrecorded once extended retention is on (negative)", () => {
    const s = statementFor({
      bucket: blocksBucket,
      rate: contractRate(),
      retention: evidenceRetention({ extendedRetentionEnabled: true }),
      discount: ZERO,
    });
    expect(s.retentionAmount).toBeNull();
    expect(s.total).toBeNull();
  });

  it("rounds the total to cents once, half to even", () => {
    // 1,001 actions at $0.000005 is $0.005005: rounds up past the half.
    const up = statementFor({
      bucket: { ...invoiceBucket(), usedGau: 300_000 + 1_001 },
      rate: contractRate({ ratePerGau: usd("5") }),
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(up.governedAmount).toEqual(usd("5005"));
    expect(up.total).toEqual(usd("10000"));
    // 1,000 actions at $0.000005 is exactly half a cent: rounds to the even 0.
    const even = statementFor({
      bucket: { ...invoiceBucket(), usedGau: 300_000 + 1_000 },
      rate: contractRate({ ratePerGau: usd("5") }),
      retention: evidenceRetention(),
      discount: ZERO,
    });
    expect(even.total).toEqual(ZERO);
  });
});
