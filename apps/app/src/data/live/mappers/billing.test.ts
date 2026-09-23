// The billing mappers over contract-output samples: the contracted rate the
// page prints is the contract's figure, never a published band's; the plan
// card carries the subscription alone; the bucket is copied as stored; the
// invoices carry their kind and their amounts as Money.
import { ACTION_RATE_BANDS } from "@oxagen/billing";
import { describe, expect, it } from "vitest";
import {
  contractRateOutput,
  evidenceRetentionOutput,
  invoiceBucketOutput,
  invoiceItemOutput,
  prepaidBucketOutput,
  subscriptionOutput,
} from "@/test/billing-outputs";
import {
  toContractRate,
  toEvidenceRetention,
  toGauBucket,
  toInvoicePage,
  toPlanCard,
  toUsageCredits,
} from "./billing";

/** The micros per GAU of every ACTION_RATE_BANDS band: $N per 1,000 is N × 1,000 micros per GAU. */
const BAND_MICROS = ACTION_RATE_BANDS.map((band) =>
  String(band.usdPer1000 * 1000),
);

describe("toContractRate", () => {
  it("prints the negotiated agreement's rate, which no published band carries", () => {
    const out = contractRateOutput();
    const view = toContractRate(out);
    expect(view.ratePerGau).toEqual({
      micros: out.ratePerGauMicros,
      currency: "USD",
    });
    expect(BAND_MICROS).not.toContain(view.ratePerGau.micros);
    expect(view).toMatchObject({
      source: "negotiated",
      agreementRef: "MSA-2026-014",
      tier: "enterprise",
      blockSizeGau: 10000,
      includedGauPerMonth: 250000,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2027-01-01T00:00:00.000Z",
    });
  });

  it("prints a published tier's rate from the contract, not from a band", () => {
    const view = toContractRate(
      contractRateOutput({
        source: "published_tier",
        agreementRef: null,
        tier: "build",
        ratePerGauMicros: "4500",
        blockSizeGau: 5000,
        effectiveTo: null,
      }),
    );
    expect(view.ratePerGau.micros).toBe("4500");
    expect(BAND_MICROS).not.toContain("4500");
    expect(view).toMatchObject({
      source: "published_tier",
      agreementRef: null,
      tier: "build",
      effectiveTo: null,
    });
  });

  it("prices the block as rate × block size, exactly", () => {
    expect(toContractRate(contractRateOutput()).blockPrice).toEqual({
      micros: "32100000",
      currency: "USD",
    });
  });
});

describe("toPlanCard", () => {
  it("carries the subscription's plan, status, interval and period and nothing else", () => {
    expect(toPlanCard(subscriptionOutput())).toEqual({
      subscription: {
        plan: "build",
        status: "active",
        billingInterval: "month",
        currentPeriodStart: "2026-09-01T00:00:00.000Z",
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      },
    });
  });

  it("maps an organization with no subscription to a null card", () => {
    expect(toPlanCard(subscriptionOutput({ subscription: null }))).toEqual({
      subscription: null,
    });
  });
});

describe("toUsageCredits", () => {
  // One credit is $0.01, which is 10,000 micro-dollars. The balance and its
  // face value are the same figure in the page's two units, so the conversion
  // is the whole of this mapper.
  it("prices the balance at face value: micros are the credits times 10,000", () => {
    const out = subscriptionOutput();
    const view = toUsageCredits(out);
    expect(view.balanceCredits).toBe(out.creditBalanceCents);
    expect(view.balance).toEqual({
      micros: String(out.creditBalanceCents * 10_000),
      currency: "USD",
    });
    expect(view.balance.micros).toBe("42000000");
  });

  it("carries a balance spent to zero as zero", () => {
    expect(toUsageCredits({ creditBalanceCents: 0 })).toEqual({
      balanceCredits: 0,
      balance: { micros: "0", currency: "USD" },
    });
  });

  it("carries an overdrawn balance as stored, not clamped", () => {
    expect(toUsageCredits({ creditBalanceCents: -150 })).toEqual({
      balanceCredits: -150,
      balance: { micros: "-1500000", currency: "USD" },
    });
  });

  it("carries the balance and nothing else: no token usage reaches the page", () => {
    expect(Object.keys(toUsageCredits(subscriptionOutput())).sort()).toEqual([
      "balance",
      "balanceCredits",
    ]);
  });
});

describe("toGauBucket", () => {
  it("copies a prepaid bucket as stored, an overdrawn remainder included", () => {
    const out = prepaidBucketOutput();
    expect(toGauBucket(out)).toEqual(out);
    expect(toGauBucket(out).remainingGau).toBe(-2250);
  });

  it("copies an invoice-billed bucket with its thresholds and no auto top-up", () => {
    const out = invoiceBucketOutput();
    expect(toGauBucket(out)).toEqual(out);
  });

  it("keeps a missing card and a month with no top-up as null", () => {
    const out = prepaidBucketOutput({
      autoTopup: {
        enabled: true,
        blocks: 1,
        paymentMethod: null,
        lastAttempt: null,
      },
    });
    expect(toGauBucket(out).autoTopup).toEqual({
      enabled: true,
      blocks: 1,
      paymentMethod: null,
      lastAttempt: null,
    });
  });
});

describe("toInvoicePage", () => {
  it("carries each invoice's public id, kind, status and amounts as Money", () => {
    expect(
      toInvoicePage({ items: [invoiceItemOutput()], nextCursor: "c2" }),
    ).toEqual({
      items: [
        {
          id: "inv_7Hc2",
          number: "OXA-0042",
          status: "paid",
          kind: "gau_auto_topup",
          amountDue: { micros: "50000000", currency: "USD" },
          amountPaid: { micros: "50000000", currency: "USD" },
          periodStart: "2026-09-01T00:00:00.000Z",
          periodEnd: "2026-10-01T00:00:00.000Z",
          hostedInvoiceUrl:
            "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x",
        },
      ],
      nextCursor: "c2",
    });
  });

  it("keeps an unnumbered, unpublished open interim invoice as it was recorded", () => {
    const [row] = toInvoicePage({
      items: [
        invoiceItemOutput({
          number: null,
          status: "open",
          kind: "gau_interim",
          amountPaidMicros: "0",
          hostedInvoiceUrl: null,
        }),
      ],
      nextCursor: null,
    }).items;
    expect(row).toMatchObject({
      number: null,
      status: "open",
      kind: "gau_interim",
      amountPaid: { micros: "0", currency: "USD" },
      hostedInvoiceUrl: null,
    });
  });
});

describe("toEvidenceRetention", () => {
  it("copies the window and the opt-in, and reads the dollar price into micros through its text", () => {
    expect(toEvidenceRetention(evidenceRetentionOutput())).toEqual({
      includedMonths: 12,
      perGbMonth: { micros: "80000", currency: "USD" },
      extendedRetentionEnabled: false,
    });
  });

  it("maps no stored volume, even a measured one: it is the volume beyond the window, not the volume held (negative)", () => {
    const view = toEvidenceRetention(
      evidenceRetentionOutput({
        storedGbBeyondIncluded: 41.2,
        storedGbMeasured: true,
        extendedRetentionEnabled: true,
      }),
    );
    expect(view).not.toHaveProperty("storedGb");
    expect(view.extendedRetentionEnabled).toBe(true);
  });

  it("leaves a price the decimal text cannot hold as micros unparseable (negative)", () => {
    expect(
      toEvidenceRetention(evidenceRetentionOutput({ usdPerGbMonth: 1e-7 }))
        .perGbMonth.micros,
    ).toBe("");
  });
});
