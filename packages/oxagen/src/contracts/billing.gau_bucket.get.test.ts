/**
 * Contract tests for `get_gau_bucket`.
 *
 * Two things are load-bearing here and neither is provable by reading the
 * page: that the bucket read never charges and never writes, and that no
 * money, credit balance or meter mode leaks into an output the billing page
 * prints in governed action units (INV-09, INV-25, §1.4).
 */
import { describe, expect, it } from "vitest";
import { billingGauBucketGet } from "./billing.gau_bucket.get";

const period = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};

const prepaid = {
  mode: "prepaid" as const,
  period,
  includedGau: 5000,
  purchasedGau: 5000,
  carriedGau: 250,
  usedGau: 900,
  remainingGau: 9350,
  invoice: null,
  autoTopup: {
    enabled: true,
    blocks: 1,
    paymentMethod: { brand: "visa", last4: "4242" },
    lastAttempt: { at: "2026-09-12T10:00:00.000Z", status: "paid" as const },
  },
};

const invoiced = {
  mode: "invoice" as const,
  period,
  includedGau: 300_000,
  purchasedGau: 0,
  carriedGau: 0,
  usedGau: 412_000,
  remainingGau: -112_000,
  invoice: {
    gauMax: 100_000,
    uninvoicedGau: 12_000,
    invoicedThisPeriodGau: 100_000,
    pastDue: true,
  },
  autoTopup: null,
};

/** Every key in the output tree, nested objects included. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (value === null || typeof value !== "object") return into;
  for (const [key, child] of Object.entries(value)) {
    into.push(key);
    keysOf(child, into);
  }
  return into;
}

describe("get_gau_bucket contract", () => {
  it("is a read that is never gated on the bucket it reports", () => {
    expect(billingGauBucketGet.mutates).toBe(false);
    expect(billingGauBucketGet.noBillingGate).toBe(true);
    expect(billingGauBucketGet.scoped).toBe(true);
  });

  it("is granted to Owner, Admin and Billing and denied by default", () => {
    expect(billingGauBucketGet.defaultEffect).toBe("deny");
    expect(billingGauBucketGet.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
    });
    expect(billingGauBucketGet.defaultRoles?.workspace).toEqual({});
  });

  it("takes no input and refuses an unknown field", () => {
    expect(billingGauBucketGet.input.parse({})).toEqual({});
    expect(billingGauBucketGet.input.safeParse({ orgId: "o" }).success).toBe(
      false,
    );
  });

  it("carries no money, credit, micro-unit, meter-mode or block-size key", () => {
    for (const output of [prepaid, invoiced]) {
      const parsed = billingGauBucketGet.output.parse(output);
      const offending = keysOf(parsed).filter((k) =>
        /usd|credit|micros|meterMode|blockSize/i.test(k),
      );
      expect(offending).toEqual([]);
    }
  });

  it("accepts a prepaid bucket with auto top-up and no invoice block", () => {
    expect(billingGauBucketGet.output.parse(prepaid)).toEqual(prepaid);
  });

  it("accepts an invoice-billed bucket with thresholds and no auto top-up", () => {
    expect(billingGauBucketGet.output.parse(invoiced)).toEqual(invoiced);
  });

  it("refuses a prepaid bucket that reports an invoice cap", () => {
    const parsed = billingGauBucketGet.output.safeParse({
      ...prepaid,
      invoice: {
        gauMax: 100_000,
        uninvoicedGau: 0,
        invoicedThisPeriodGau: 0,
        pastDue: false,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a prepaid bucket with no auto top-up block", () => {
    expect(
      billingGauBucketGet.output.safeParse({ ...prepaid, autoTopup: null })
        .success,
    ).toBe(false);
  });

  it("refuses an invoice-billed bucket with no invoice block", () => {
    expect(
      billingGauBucketGet.output.safeParse({ ...invoiced, invoice: null })
        .success,
    ).toBe(false);
  });

  it("refuses an invoice-billed bucket that also reports auto top-up", () => {
    const parsed = billingGauBucketGet.output.safeParse({
      ...invoiced,
      autoTopup: {
        enabled: true,
        blocks: 1,
        paymentMethod: null,
        lastAttempt: null,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("reports a negative remaining balance as stored", () => {
    expect(billingGauBucketGet.output.parse(invoiced).remainingGau).toBe(
      -112_000,
    );
  });

  it("refuses a negative count that is not the balance", () => {
    expect(
      billingGauBucketGet.output.safeParse({ ...prepaid, usedGau: -1 }).success,
    ).toBe(false);
  });

  it("refuses an unknown output field", () => {
    expect(
      billingGauBucketGet.output.safeParse({
        ...prepaid,
        creditBalanceCents: 0,
      }).success,
    ).toBe(false);
  });
});
