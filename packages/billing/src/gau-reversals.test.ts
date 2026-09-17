/**
 * Unit tests for gau-reversals.ts — what a refunded or disputed GAU block
 * purchase withdraws (ADR-085).
 *
 * Runs against the in-memory executor in test-utils/gau-fake-tx.ts, which
 * enforces the table CHECK constraints Postgres enforces. That matters here
 * more than anywhere else in this package: `gau_buckets_counts_non_negative`
 * is what turns the reversal's clamp from a nicety into the difference between
 * a webhook that succeeds and one that errors on every redelivery, and a fake
 * that quietly stored -3000 would let a wrong implementation pass.
 *
 * Every test asserts the bucket row and the gau_reversals row that resulted,
 * never that a function was called: a reversal that debits the wrong column,
 * the wrong bucket or the wrong org calls exactly the same functions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeGauStore,
  makeFakeGauTx,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";
import type { BillingDispute, BillingRefundedCharge } from "./provider";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  readGauEntitlement: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock(
  "./contract-terms",
  () =>
    ({
      readGauEntitlement: mocks.readGauEntitlement,
    }) satisfies Pick<typeof import("./contract-terms"), "readGauEntitlement">,
);

const { applyGauReversal, reversibleGau } = await import("./gau-reversals");
const { reverseGauPurchaseForDispute, reverseGauPurchaseForRefund } =
  await import("./gau-reversals");

const ORG = "00000000-0000-0000-0000-00000000a0a1";
const OTHER_ORG = "00000000-0000-0000-0000-00000000b0b2";
const NOW = new Date("2026-09-17T12:00:00.000Z");
const PERIOD_START = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-10-01T00:00:00.000Z");

const TERMS = {
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};

let store: FakeGauStore;

function seedBucket(overrides: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    includedGau: 5_000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 0,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null as string | null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  store.buckets.push(row);
  return row;
}

function seedCheckoutSettlement(overrides: Record<string, unknown> = {}) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    bucketId: store.buckets[0]?.id ?? crypto.randomUUID(),
    kind: "checkout",
    seq: null,
    // 10,000 units at 5,000 micros each = $50.00 = 5,000 cents.
    quantityGau: 10_000,
    ratePerGauMicros: 5_000n,
    currency: "usd",
    status: "paid",
    stripeCheckoutSessionId: "cs_gau_001",
    stripeInvoiceId: "in_gau_001",
    stripePaymentIntentId: "pi_gau_001",
    createdAt: NOW,
    settledAt: NOW,
    ...overrides,
  };
  store.settlements.push(row);
  return row;
}

function refundedCharge(
  overrides: Partial<BillingRefundedCharge> = {},
): BillingRefundedCharge {
  return {
    id: "ch_gau_001",
    paymentIntentId: "pi_gau_001",
    amountRefundedCents: 5_000,
    currency: "usd",
    orgId: ORG,
    metadata: { oxagen_kind: "gau_purchase", org_id: ORG },
    ...overrides,
  };
}

function dispute(overrides: Partial<BillingDispute> = {}): BillingDispute {
  return {
    id: "dp_gau_001",
    chargeId: "ch_gau_001",
    paymentIntentId: "pi_gau_001",
    amountCents: 5_000,
    currency: "usd",
    reason: "fraudulent",
    status: "needs_response",
    orgId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  store = makeFakeGauStore();
  const tx = makeFakeGauTx(store);
  mocks.withSystemDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn(tx),
  );
  mocks.readGauEntitlement.mockResolvedValue({
    terms: TERMS,
    subscription: null,
  });
});

describe("reversibleGau", () => {
  const settlement = { quantityGau: 10_000, ratePerGauMicros: 5_000n };

  it("takes every unit when the amount refunded equals the settlement's gross", () => {
    expect(reversibleGau(settlement, 5_000)).toBe(10_000);
  });

  it("takes every unit and no more when tax pushes the refund above the gross", () => {
    expect(reversibleGau(settlement, 5_450)).toBe(10_000);
  });

  it("takes units pro-rata for a partial refund", () => {
    expect(reversibleGau(settlement, 2_500)).toBe(5_000);
    expect(reversibleGau(settlement, 1_000)).toBe(2_000);
  });

  it("rounds down, so a partial refund never withdraws more than it paid back", () => {
    // 1 cent of a 5,000-cent purchase is 2 units exactly; 1.5 cents is not
    // expressible, so 2 cents buys back 4 and 3 cents 6 — never a rounded-up 7.
    expect(reversibleGau(settlement, 3)).toBe(6);
  });

  it("takes nothing for a zero or negative amount", () => {
    expect(reversibleGau(settlement, 0)).toBe(0);
    expect(reversibleGau(settlement, -100)).toBe(0);
  });
});

describe("applyGauReversal — a purchase whose units are still there", () => {
  it("takes the units off purchased_gau and records what it recovered", async () => {
    const bucket = seedBucket({ purchasedGau: 10_000, usedGau: 1_000 });
    const settlement = seedCheckoutSettlement();

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toMatchObject({
      orgId: ORG,
      settlementId: settlement.id,
      bucketId: bucket.id,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
      applied: true,
    });
    // The row, not the call: purchased is gone, nothing else moved.
    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      id: bucket.id,
      orgId: ORG,
      purchasedGau: 0,
      carriedGau: 0,
      includedGau: 5_000,
      usedGau: 1_000,
    });
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      orgId: ORG,
      settlementId: settlement.id,
      bucketId: bucket.id,
      kind: "refund",
      providerEventId: "ch_gau_001",
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
      amountCents: 5_000,
      currency: "usd",
    });
  });

  it("a dispute withdraws the same units and records itself as a dispute", async () => {
    const bucket = seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    const result = await reverseGauPurchaseForDispute(dispute());

    expect(result).toMatchObject({ reversedGau: 10_000, applied: true });
    expect(store.buckets[0]).toMatchObject({
      id: bucket.id,
      purchasedGau: 0,
    });
    expect(store.reversals[0]).toMatchObject({
      kind: "dispute",
      providerEventId: "dp_gau_001",
      reversedGau: 10_000,
    });
  });

  it("a partial refund takes pro-rata units and leaves the rest purchased", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_500 }),
    );

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });
    expect(store.reversals[0]).toMatchObject({
      requestedGau: 5_000,
      reversedGau: 5_000,
      unrecoveredGau: 0,
      amountCents: 2_500,
    });
  });
});

describe("applyGauReversal — units the customer already spent", () => {
  it("takes what is left, records the shortfall, and does not drive purchased_gau negative", async () => {
    // The bucket rolled: 2,000 of the purchase are still `purchased`, 3,000
    // came across as `carried`, and the other 5,000 were consumed in a period
    // that has closed. `gau_buckets_counts_non_negative` refuses a negative,
    // so an implementation without the clamp raises here rather than storing
    // -5,000 — which is the whole reason the fake enforces the constraint.
    const bucket = seedBucket({
      purchasedGau: 2_000,
      carriedGau: 3_000,
      usedGau: 9_000,
    });
    seedCheckoutSettlement();

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toMatchObject({
      requestedGau: 10_000,
      reversedGau: 5_000,
      unrecoveredGau: 5_000,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({
      id: bucket.id,
      purchasedGau: 0,
      carriedGau: 0,
      usedGau: 9_000,
    });
    expect(store.reversals[0]).toMatchObject({
      reversedGau: 5_000,
      unrecoveredGau: 5_000,
    });
  });

  it("takes from purchased before carried", async () => {
    seedBucket({ purchasedGau: 4_000, carriedGau: 4_000 });
    seedCheckoutSettlement({ quantityGau: 5_000 });

    // 5,000 units at 5,000 micros = 2,500 cents; the refund is that gross.
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_500 }),
    );

    // 4,000 out of purchased, 1,000 out of carried — not 5,000 out of carried
    // and not split evenly.
    expect(store.buckets[0]).toMatchObject({
      purchasedGau: 0,
      carriedGau: 3_000,
    });
  });

  it("recovers nothing, and says so, when the balance is already empty", async () => {
    seedBucket({ purchasedGau: 0, carriedGau: 0, usedGau: 12_000 });
    seedCheckoutSettlement();

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toMatchObject({
      requestedGau: 10_000,
      reversedGau: 0,
      unrecoveredGau: 10_000,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0, carriedGau: 0 });
    expect(store.reversals).toHaveLength(1);
  });
});

describe("applyGauReversal — which bucket is debited", () => {
  it("debits the org's current bucket, not the one the grant landed on", async () => {
    // August's bucket is where the purchase was granted; September's is where
    // its units now live, as `carried`, and is the only balance the gate
    // reads. Debiting the grant's own bucket would leave every refunded unit
    // spendable.
    const august = seedBucket({
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: PERIOD_START,
      purchasedGau: 10_000,
    });
    const september = seedBucket({ carriedGau: 10_000 });
    seedCheckoutSettlement({ bucketId: august.id });

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toMatchObject({
      bucketId: september.id,
      reversedGau: 10_000,
    });
    const augustAfter = store.buckets.find((b) => b.id === august.id);
    const septemberAfter = store.buckets.find((b) => b.id === september.id);
    expect(augustAfter).toMatchObject({ purchasedGau: 10_000 });
    expect(septemberAfter).toMatchObject({ carriedGau: 0 });
  });

  it("never touches another organisation's bucket", async () => {
    const theirs = seedBucket({ orgId: OTHER_ORG, purchasedGau: 10_000 });
    const ours = seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    expect(store.buckets.find((b) => b.id === theirs.id)).toMatchObject({
      orgId: OTHER_ORG,
      purchasedGau: 10_000,
    });
    expect(store.buckets.find((b) => b.id === ours.id)).toMatchObject({
      purchasedGau: 0,
    });
  });

  it("materialises the current bucket when the month rolled with no activity, and takes the carried units off it", async () => {
    // Nothing yet exists for September; the carried units are virtual until
    // the row is created. The reversal has to create it the way the grant
    // does, or the units stay spendable the moment anything else writes it.
    seedBucket({
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      periodEnd: PERIOD_START,
      purchasedGau: 10_000,
      usedGau: 0,
    });
    seedCheckoutSettlement();

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(store.buckets).toHaveLength(2);
    const september = store.buckets.find(
      (b) => (b.periodStart as Date).getTime() === PERIOD_START.getTime(),
    );
    expect(september).toMatchObject({
      orgId: ORG,
      includedGau: 5_000,
      carriedGau: 0,
      purchasedGau: 0,
    });
    expect(result).toMatchObject({
      bucketId: september!.id as string,
      reversedGau: 10_000,
      unrecoveredGau: 0,
    });
  });
});

describe("applyGauReversal — idempotency", () => {
  it("a redelivered charge.refunded withdraws nothing a second time", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    const first = await reverseGauPurchaseForRefund(refundedCharge());
    const second = await reverseGauPurchaseForRefund(refundedCharge());

    expect(first).toMatchObject({ reversedGau: 10_000, applied: true });
    expect(second).toMatchObject({ reversedGau: 10_000, applied: false });
    // The row is what proves it: a second debit would show here as -10,000,
    // which the bucket's CHECK would have refused outright.
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals).toHaveLength(1);
  });

  it("a redelivered dispute withdraws nothing a second time", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForDispute(dispute());
    const second = await reverseGauPurchaseForDispute(dispute());

    expect(second).toMatchObject({ applied: false });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals).toHaveLength(1);
  });

  it("a dispute after a refund of the same purchase is a separate reversal and finds nothing left", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());
    const disputed = await reverseGauPurchaseForDispute(dispute());

    expect(disputed).toMatchObject({
      requestedGau: 10_000,
      reversedGau: 0,
      unrecoveredGau: 10_000,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals).toHaveLength(2);
  });
});

describe("applyGauReversal — what it declines to touch", () => {
  it("returns null when no settlement claims the PaymentIntent", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement({ stripePaymentIntentId: "pi_something_else" });

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toBeNull();
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
    expect(store.reversals).toHaveLength(0);
  });

  it("returns null when the charge names no PaymentIntent", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    const result = await reverseGauPurchaseForRefund(
      refundedCharge({ paymentIntentId: null }),
    );

    expect(result).toBeNull();
    expect(store.reversals).toHaveLength(0);
  });

  it("ignores an invoice-charged settlement: an auto_topup refund is an invoicing correction, not a purchase to unwind", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement({
      kind: "auto_topup",
      seq: 1,
      stripeCheckoutSessionId: null,
    });

    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toBeNull();
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
  });

  it("records a zero-unit reversal for a zero-amount refund rather than guessing", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    const result = await applyGauReversal({
      kind: "refund",
      providerEventId: "ch_gau_zero",
      paymentIntentId: "pi_gau_001",
      amountCents: 0,
      currency: "usd",
    });

    expect(result).toMatchObject({
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
  });
});
