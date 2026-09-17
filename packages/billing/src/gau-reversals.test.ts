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
  getChargeMetadata: vi.fn(),
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
  "./client",
  () =>
    ({
      billingProvider: () =>
        ({ getChargeMetadata: mocks.getChargeMetadata }) as never,
    }) as never,
);

// A real StripeProvider, so one test can compose the real read-failure
// classifier with the real park decision. Everything else in this file drives
// `getChargeMetadata` directly; that is faster, but it cannot catch a
// classifier that answers `{}` where it should have thrown, because the stub
// IS the classifier's answer.
const stripeCharges = vi.hoisted(() => ({ retrieve: vi.fn() }));
vi.mock("stripe", () => ({
  default: vi.fn(() => ({ charges: stripeCharges })),
}));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_mock",
  })),
}));

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
const { StripeProvider } = await import("./stripe-provider");
const { reconcilePendingGauReversals } = await import("./gau-reversals");

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
    // 10,000 GAU at 5,000 micros = 5,000c subtotal; 10% tax = 5,500c charged.
    chargedCents: 5_500,
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
    // The full tax-inclusive charge: 5,000c subtotal + 10% tax.
    amountRefundedCents: 5_500,
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
    amountCents: 5_500,
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
  mocks.getChargeMetadata.mockResolvedValue({
    oxagen_kind: "gau_purchase",
    org_id: ORG,
  });
});

describe("reversibleGau — the denominator is what was actually paid", () => {
  // 10,000 GAU at 5,000 micros = a 5,000c SUBTOTAL. With 10% automatic tax the
  // customer is charged 5,500c, and Stripe's amount_refunded is against that.
  const taxed = {
    quantityGau: 10_000,
    ratePerGauMicros: 5_000n,
    chargedCents: 5_500,
  };
  const untaxed = { ...taxed, chargedCents: 5_000 };

  it("prorates a partial refund against the tax-inclusive total, not the subtotal", () => {
    // The regression. Half the money back is half the units. Against the
    // 5,000c subtotal this reads as 55% and withdraws 5,500 — a tenth more
    // than was paid back, which is exactly the tax rate.
    expect(reversibleGau(taxed, 2_750)).toBe(5_000);
    expect(reversibleGau(taxed, 550)).toBe(1_000);
  });

  it("an untaxed purchase is unaffected: subtotal and charged total are the same number", () => {
    // The control. A test that only ever ran untaxed would pass against the
    // subtotal denominator and prove nothing about the bug above.
    expect(reversibleGau(untaxed, 2_500)).toBe(5_000);
    expect(reversibleGau(untaxed, 500)).toBe(1_000);
  });

  it("takes every unit for a full refund, taxed or not", () => {
    expect(reversibleGau(taxed, 5_500)).toBe(10_000);
    expect(reversibleGau(untaxed, 5_000)).toBe(10_000);
    // Full refunds saturate either way, which is why the bug was invisible
    // until a partial one.
    expect(reversibleGau({ ...taxed, chargedCents: null }, 5_500)).toBe(10_000);
  });

  it("never withdraws more than the quantity, whatever the amount", () => {
    expect(reversibleGau(taxed, 99_999)).toBe(10_000);
  });

  it("falls back to the subtotal when the settlement predates charged_cents", () => {
    // A row written before the column existed has no tax-inclusive figure to
    // prorate against; the subtotal is the best available and is exact for an
    // untaxed purchase.
    const legacy = { ...taxed, chargedCents: null };
    expect(reversibleGau(legacy, 2_500)).toBe(5_000);
  });

  it("ignores a zero or absent charged total rather than dividing by it", () => {
    expect(reversibleGau({ ...taxed, chargedCents: 0 }, 2_500)).toBe(5_000);
  });

  it("rounds down, so a partial refund never withdraws more than it paid back", () => {
    // 3c of a 5,500c charge is 5.45 units; the floor is 5, never a rounded-up 6.
    expect(reversibleGau(taxed, 3)).toBe(5);
  });

  it("takes nothing for a zero or negative amount", () => {
    expect(reversibleGau(taxed, 0)).toBe(0);
    expect(reversibleGau(taxed, -100)).toBe(0);
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
      amountCents: 5_500,
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

    // Half the money back is half the units — against the tax-inclusive
    // total, not the 5,000c subtotal, which would have taken 5,500.
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });
    expect(store.reversals[0]).toMatchObject({
      requestedGau: 5_000,
      reversedGau: 5_000,
      unrecoveredGau: 0,
      amountCents: 2_750,
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
    seedCheckoutSettlement({ quantityGau: 5_000, chargedCents: 2_750 });

    // The whole charge back: all 5,000 units.
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
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

  it("a dispute after a refund of the same purchase reports the purchase already reversed", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());
    const disputed = await reverseGauPurchaseForDispute(dispute());

    // This test used to assert `requestedGau: 10_000` and read the zero below
    // as "the units were already gone". Both events did ask for the full
    // quantity, and the only reason the second withdrew nothing was that this
    // bucket happened to be empty by then. The describe block beneath seeds a
    // bucket that is not, and the figure the second event reports is the
    // purchase's remaining reversible quantity, which the refund left at zero.
    expect(disputed).toMatchObject({
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals).toHaveLength(2);
  });
});

describe("applyGauReversal — one purchase's units are shared by every event against it", () => {
  /**
   * A bucket is one balance, not a balance per purchase. Nothing in the row a
   * reversal writes stops the next event against the SAME purchase pricing
   * itself against the settlement again and taking units a DIFFERENT purchase
   * paid for. The cap has to come from the settlement's own quantity, measured
   * against the reversal rows already standing for it.
   */
  function seedSecondPurchase() {
    // 8,000 units at 5,000 micros = 4,000c subtotal; 10% tax = 4,400c charged.
    return seedCheckoutSettlement({
      stripePaymentIntentId: "pi_gau_002",
      stripeCheckoutSessionId: "cs_gau_002",
      quantityGau: 8_000,
      chargedCents: 4_400,
    });
  }

  it("a dispute after a full refund of the same purchase takes nothing, leaving another purchase's units spendable", async () => {
    // 18,000 purchased: 10,000 from pi_gau_001 and 8,000 from pi_gau_002.
    seedBucket({ purchasedGau: 18_000 });
    seedCheckoutSettlement();
    seedSecondPurchase();

    const refunded = await reverseGauPurchaseForRefund(refundedCharge());
    const disputed = await reverseGauPurchaseForDispute(dispute());

    expect(refunded).toMatchObject({
      requestedGau: 10_000,
      reversedGau: 10_000,
    });
    // pi_gau_001 granted 10,000 units and the refund withdrew all of them, so
    // the dispute of the same purchase has nothing left to claim.
    expect(disputed).toMatchObject({
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      applied: true,
    });
    // The assertion that pins the finding. Uncapped, the dispute prices itself
    // at the full 10,000 again and eats 8,000 units the customer still owns.
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 8_000 });
  });

  it("caps per purchase, not per bucket: another purchase's own refund still withdraws in full", async () => {
    seedBucket({ purchasedGau: 18_000 });
    seedCheckoutSettlement();
    seedSecondPurchase();

    await reverseGauPurchaseForRefund(refundedCharge());
    const second = await reverseGauPurchaseForRefund(
      refundedCharge({
        id: "ch_gau_002",
        paymentIntentId: "pi_gau_002",
        amountRefundedCents: 4_400,
      }),
    );

    // A cap that counted every reversal in the bucket rather than every
    // reversal of THIS settlement would refuse this one, which is a legitimate
    // refund of a purchase nothing has reversed yet.
    expect(second).toMatchObject({
      requestedGau: 8_000,
      reversedGau: 8_000,
      unrecoveredGau: 0,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
  });

  it("a second partial refund still withdraws the rest of what the purchase granted", async () => {
    seedBucket({ purchasedGau: 18_000 });
    seedCheckoutSettlement();
    seedSecondPurchase();

    // Half the tax-inclusive charge, as a distinct charge id rather than a
    // cumulative redelivery of the first.
    await reverseGauPurchaseForRefund(
      refundedCharge({ id: "ch_half_a", amountRefundedCents: 2_750 }),
    );
    const rest = await reverseGauPurchaseForRefund(
      refundedCharge({ id: "ch_half_b", amountRefundedCents: 5_500 }),
    );

    // The cap is the REMAINDER, not zero: 10,000 granted less the 5,000 the
    // first event took. A cap that refused any second event outright would
    // leave 5,000 refunded units spendable.
    expect(rest).toMatchObject({
      requestedGau: 5_000,
      reversedGau: 5_000,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 8_000 });
  });

  it("a first event that recovered nothing still spends the purchase's entitlement", async () => {
    // The units this purchase granted were spent before the money came back,
    // so the refund recovers nothing and records the shortfall.
    const bucket = seedBucket({ purchasedGau: 0 });
    seedCheckoutSettlement();
    const refunded = await reverseGauPurchaseForRefund(refundedCharge());
    expect(refunded).toMatchObject({
      requestedGau: 10_000,
      reversedGau: 0,
      unrecoveredGau: 10_000,
    });

    // A later, unrelated purchase puts units back in the shared bucket.
    seedSecondPurchase();
    bucket.purchasedGau = 8_000;

    const disputed = await reverseGauPurchaseForDispute(dispute());

    // The refund already claimed all 10,000 even though it collected none of
    // them, so the dispute has no entitlement left. Counting what was actually
    // RECOVERED instead of what was REQUESTED would hand the dispute a fresh
    // 10,000 here and take the 8,000 units the later purchase paid for — the
    // same double debit, reached through the shortfall.
    expect(disputed).toMatchObject({
      requestedGau: 0,
      reversedGau: 0,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 8_000 });
  });

  it("reports nothing left, rather than a negative claim, when existing rows already over-claim the purchase", async () => {
    seedBucket({ purchasedGau: 18_000 });
    seedCheckoutSettlement();
    seedSecondPurchase();

    await reverseGauPurchaseForRefund(refundedCharge());
    // A second row claiming the whole purchase as well — the shape the
    // uncapped code wrote, and the shape any future path that forgets the cap
    // would write. The rows for this settlement now claim 20,000 of a 10,000
    // unit purchase.
    const firstRow = store.reversals[0];
    if (!firstRow) throw new Error("the refund above records a reversal row");
    store.reversals.push({
      ...firstRow,
      id: crypto.randomUUID(),
      providerEventId: "ch_over_claim",
    });

    const disputed = await reverseGauPurchaseForDispute(dispute());

    // Without the zero floor the remainder is -10,000, the row's quantities go
    // negative and gau_reversals_quantities_check refuses the insert. That is
    // not a safe failure: the webhook throws, so Stripe redelivers it forever
    // and the dispute is never recorded at all.
    expect(disputed).toMatchObject({
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      applied: true,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 8_000 });
  });

  it("reconciles a parked refund and a parked dispute of one purchase without withdrawing it twice", async () => {
    // Both events land before the grant, so both park and both are priced by
    // the reconciliation loop against the same settlement.
    await reverseGauPurchaseForRefund(refundedCharge());
    await reverseGauPurchaseForDispute(dispute());
    expect(store.reversals).toHaveLength(2);

    seedBucket({ purchasedGau: 18_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);

    const settled = await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    expect(settled).toHaveLength(2);
    expect(settled[0]).toMatchObject({ requestedGau: 10_000 });
    expect(settled[1]).toMatchObject({ requestedGau: 0 });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 8_000 });
  });
});

describe("applyGauReversal — what it declines to touch", () => {
  it("returns null when the charge did not buy units, so the credit clawback gets it", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement({ stripePaymentIntentId: "pi_something_else" });

    const result = await reverseGauPurchaseForRefund(
      refundedCharge({ metadata: { oxagen_kind: "usage_credits" } }),
    );

    expect(result).toBeNull();
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
    expect(store.reversals).toHaveLength(0);
  });

  it("returns null when a gau charge carries no org, since a pending row has nothing to attribute to", async () => {
    // The residual manual case. Retrying cannot conjure metadata that is not
    // on the charge, so the handler logs a fatal rather than parking a row it
    // could never reconcile.
    const result = await reverseGauPurchaseForRefund(
      refundedCharge({ orgId: null }),
    );

    expect(result).toBeNull();
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

    // An auto top-up is charged through an Invoice, so its charge never
    // carries the Checkout metadata that marks a block purchase.
    const result = await reverseGauPurchaseForRefund(
      refundedCharge({ metadata: {} }),
    );

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

describe("a refund that arrives before its purchase (ADR-085 §5)", () => {
  // Stripe does not order webhook deliveries, and processStripeEvent only
  // re-dispatches an event whose handler THREW — a handler that returns marks
  // the event processed forever. So a refund that finds no settlement and
  // simply returns is a refund that is never seen again, while the retried
  // grant goes on to hand out the full purchase. These tests run the events in
  // that order and assert the bucket, because asserting "a reversal was
  // recorded" passes against a reversal that never reaches the balance.

  it("parks the reversal instead of dropping it", async () => {
    // No settlement yet: the grant has not run.
    const result = await reverseGauPurchaseForRefund(refundedCharge());

    expect(result).toMatchObject({ pending: true, applied: true, orgId: ORG });
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      orgId: ORG,
      settlementId: null,
      bucketId: null,
      stripePaymentIntentId: "pi_gau_001",
      providerEventId: "ch_gau_001",
      amountCents: 5_500,
      // Not knowable yet — the quantity and the rate live on the settlement.
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
    });
  });

  it("the grant then settles it, and the customer is left with no spendable units", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());

    // The grant lands afterwards. It adds 10,000 and the reconciliation takes
    // them straight back out, in the same transaction.
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);
    const settled = await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      pending: false,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
    });
    // The row, which is the whole point: the units did not survive the grant.
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals[0]).toMatchObject({
      settlementId: settlement.id,
      bucketId: bucket.id,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
    });
  });

  it("settles a partial refund pro-rata against the tax-inclusive total it was parked with", async () => {
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);

    await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    // Half the money back, half the units — 5,000 left spendable, not 4,500.
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });
    expect(store.reversals[0]).toMatchObject({
      requestedGau: 5_000,
      reversedGau: 5_000,
    });
  });

  it("a redelivered refund parks nothing a second time", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());
    const second = await reverseGauPurchaseForRefund(refundedCharge());

    expect(second).toMatchObject({ pending: true, applied: false });
    expect(store.reversals).toHaveLength(1);
  });

  it("reconciling twice withdraws nothing twice", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);

    await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });
    const again = await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    // The second pass matches nothing: the row is no longer pending.
    expect(again).toHaveLength(0);
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals).toHaveLength(1);
  });

  it("settles two parked reversals against one purchase without over-withdrawing", async () => {
    await reverseGauPurchaseForRefund(
      refundedCharge({ id: "ch_a", amountRefundedCents: 2_750 }),
    );
    await reverseGauPurchaseForRefund(
      refundedCharge({ id: "ch_b", amountRefundedCents: 2_750 }),
    );
    expect(store.reversals).toHaveLength(2);

    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);
    const settled = await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    expect(settled).toHaveLength(2);
    // 5,000 each, and the bucket lands at zero rather than negative — the
    // clamp still holds across a sequence of reversals.
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
  });

  it("leaves an unrelated PaymentIntent's purchase alone", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement({
      stripePaymentIntentId: "pi_other",
    });
    const tx = makeFakeGauTx(store);

    const settled = await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_other",
      now: NOW,
    });

    expect(settled).toHaveLength(0);
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
    expect(store.reversals[0]).toMatchObject({ settlementId: null });
  });
});

describe("a dispute that arrives before its purchase (ADR-085 §7)", () => {
  // The same defect the refund path had, which survived the first fix because
  // the dispute path supplied no organisation to park with. A dispute carries
  // neither the org nor what was bought — Stripe does not copy charge metadata
  // onto a Dispute — so both come from the charge.

  it("parks the reversal instead of dropping it", async () => {
    const result = await reverseGauPurchaseForDispute(dispute());

    expect(result).toMatchObject({ pending: true, applied: true, orgId: ORG });
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      orgId: ORG,
      settlementId: null,
      bucketId: null,
      stripePaymentIntentId: "pi_gau_001",
      kind: "dispute",
      providerEventId: "dp_gau_001",
      amountCents: 5_500,
    });
  });

  it("the grant then settles it and leaves no spendable units", async () => {
    await reverseGauPurchaseForDispute(dispute());
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    const tx = makeFakeGauTx(store);

    await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    expect(store.reversals[0]).toMatchObject({
      settlementId: settlement.id,
      reversedGau: 10_000,
    });
  });

  it("does not park a dispute against a charge that bought credits", async () => {
    mocks.getChargeMetadata.mockResolvedValue({
      oxagen_kind: "usage_credits",
      org_id: ORG,
    });

    const result = await reverseGauPurchaseForDispute(dispute());

    expect(result).toBeNull();
    expect(store.reversals).toHaveLength(0);
  });

  it("uses charge metadata the caller already read rather than reading again", async () => {
    const result = await reverseGauPurchaseForDispute(dispute(), {
      oxagen_kind: "gau_purchase",
      org_id: ORG,
    });

    expect(result).toMatchObject({ pending: true });
    expect(mocks.getChargeMetadata).not.toHaveBeenCalled();
  });
});

describe("both money paths take the PaymentIntent lock before deciding", () => {
  // A unit test can only prove the statement is ISSUED. That it serialises
  // anything is proved on two real connections in
  // gau-reversals.concurrency.integration.test.ts — a single-threaded store
  // cannot exhibit a write skew between two transactions.

  it("the reversal locks on the PaymentIntent before reading anything", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    const first = store.log[0];
    expect(first).toMatchObject({
      op: "lock",
      lockKey: "gau_purchase:pi_gau_001",
    });
  });

  it("the reconciliation locks on the same key", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    store.log.length = 0;
    const tx = makeFakeGauTx(store);

    await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    expect(store.log[0]).toMatchObject({
      op: "lock",
      lockKey: "gau_purchase:pi_gau_001",
    });
  });
});

describe("a charge read that fails is not an answer (ADR-085 §9)", () => {
  it("propagates a transient failure instead of dropping the dispute", async () => {
    // The whole point: returning {} here would reach the park decision as
    // "no organisation", and the dispute would be dropped and the webhook
    // marked processed for ever. Throwing makes processStripeEvent
    // re-dispatch it.
    mocks.getChargeMetadata.mockRejectedValue(new Error("ETIMEDOUT"));

    await expect(reverseGauPurchaseForDispute(dispute())).rejects.toThrow(
      "ETIMEDOUT",
    );
    expect(store.reversals).toHaveLength(0);
  });

  it("a definitive empty answer still declines, because there is nothing to attribute to", async () => {
    mocks.getChargeMetadata.mockResolvedValue({});

    const result = await reverseGauPurchaseForDispute(dispute());

    expect(result).toBeNull();
    expect(store.reversals).toHaveLength(0);
  });
});

describe("a charge this key may not read is retried, not finalised", () => {
  // Composed on purpose: the real classifier feeding the real park decision.
  // Every other test here stubs `getChargeMetadata`, so it asserts what the
  // park path does with an answer — it cannot see the classifier hand it the
  // WRONG answer. This one can.
  //
  // The chain the finding named: a dispute arrives before its checkout
  // settlement; the configured key temporarily lacks charge-read permission;
  // the classifier calls that definitive; `{}` comes back; there is no org to
  // attribute to, so the reversal is not parked; the handler RETURNS, which
  // marks the event processed for ever; the retried checkout then grants every
  // disputed unit. The webhook succeeds and the money is gone.
  function permissionError(): Error {
    return Object.assign(new Error("key lacks charges:read"), {
      type: "StripePermissionError",
    });
  }

  beforeEach(() => {
    const provider = new StripeProvider();
    mocks.getChargeMetadata.mockImplementation((chargeId: string) =>
      provider.getChargeMetadata(chargeId),
    );
  });

  it("does not park, and does not silently succeed, while the key is unauthorized", async () => {
    stripeCharges.retrieve.mockRejectedValue(permissionError());

    // Throwing is the whole ask: processStripeEvent re-dispatches only an
    // event whose handler threw. Returning null here would be the defect --
    // indistinguishable, to the webhook, from "this charge bought no GAUs".
    await expect(reverseGauPurchaseForDispute(dispute())).rejects.toThrow(
      "key lacks charges:read",
    );
    expect(store.reversals).toHaveLength(0);
  });

  it("parks on the redelivery once an operator grants the permission", async () => {
    // The half that proves the retry RECOVERS rather than merely being asked
    // for. A permission is operator-correctable: the same call, unchanged,
    // returns real metadata once the key is fixed. That is precisely what
    // makes it transient rather than a fact about the charge.
    stripeCharges.retrieve.mockRejectedValueOnce(permissionError());
    await expect(reverseGauPurchaseForDispute(dispute())).rejects.toThrow();

    stripeCharges.retrieve.mockResolvedValue({
      id: "ch_gau_001",
      metadata: { oxagen_kind: "gau_purchase", org_id: ORG },
    });

    const result = await reverseGauPurchaseForDispute(dispute());

    expect(result).toMatchObject({ pending: true, orgId: ORG });
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      orgId: ORG,
      settlementId: null,
      stripePaymentIntentId: "pi_gau_001",
      providerEventId: "dp_gau_001",
      amountCents: 5_500,
    });
  });
});

describe("a second partial refund on one charge (ADR-085 §10)", () => {
  // Stripe's amount_refunded is CUMULATIVE. Keyed on the charge id alone, the
  // second partial refund reads as a redelivery and withdraws nothing: more
  // money back, same units kept.

  it("withdraws the delta when the cumulative amount grows", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    // 2,750c of a 5,500c charge → half the units.
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });

    // The operator refunds the rest. Same charge id, cumulative 5,500c.
    const second = await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );

    expect(second).toMatchObject({
      applied: true,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
    });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
    // One row, carrying the cumulative truth rather than two part-rows.
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      amountCents: 5_500,
      requestedGau: 10_000,
      reversedGau: 10_000,
    });
  });

  it("an identical redelivery is still a no-op", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );
    const again = await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );

    expect(again).toMatchObject({ applied: false });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });
  });

  it("a smaller amount arriving late is ignored rather than refunding units back", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );
    const stale = await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );

    expect(stale).toMatchObject({ applied: false });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
  });

  it("recomputes against the cumulative total rather than summing floored deltas", async () => {
    // Three refunds of 1,834c each = 5,502c, over the 5,500c charge. Prorating
    // each on its own floors three times; recomputing the whole floors once.
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 1_834 }),
    );
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 3_668 }),
    );
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_502 }),
    );

    // The cumulative total exceeds the charge, so every unit goes.
    expect(store.reversals[0]).toMatchObject({ requestedGau: 10_000 });
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
  });

  it("a growing refund on a still-pending reversal only records the larger amount", async () => {
    // No settlement yet, so there is nothing to price against; reconciliation
    // prorates the final figure once.
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );
    const second = await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );

    expect(second).toMatchObject({ pending: true, applied: true });
    expect(store.reversals).toHaveLength(1);
    expect(store.reversals[0]).toMatchObject({
      settlementId: null,
      amountCents: 5_500,
      requestedGau: 0,
    });
  });
});

describe("the park decision reads its mutable input inside the lock", () => {
  // The invariant is "no transaction can commit having added spendable units
  // without having consulted the parked rows", and it only holds if the state
  // the decision depends on is read under the lock. Two inputs decide whether
  // to park:
  //
  //   does a settlement exist?   MUTABLE — another transaction creates it.
  //   is this a gau purchase, and whose?   read from the charge, outside.
  //
  // The first must be read inside the lock, and this asserts the statement
  // order that makes it so. The second is Stripe charge metadata, which is set
  // when the PaymentIntent is created and never changes — so reading it
  // outside is safe *provided a failed read cannot masquerade as an answer*,
  // which is what the ADR-085 §9 tests above enforce.

  it("takes the lock before it looks for the settlement", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    const lockAt = store.log.findIndex((e) => e.op === "lock");
    const settlementReadAt = store.log.findIndex(
      (e) => e.op === "select" && e.table === "settlements",
    );
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(settlementReadAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(settlementReadAt);
  });

  it("takes the lock before it looks for an existing reversal", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    const lockAt = store.log.findIndex((e) => e.op === "lock");
    const reversalReadAt = store.log.findIndex(
      (e) => e.op === "select" && e.table === "reversals",
    );
    expect(lockAt).toBeLessThan(reversalReadAt);
  });

  it("the reconciliation locks before it looks for pending rows", async () => {
    await reverseGauPurchaseForRefund(refundedCharge());
    const bucket = seedBucket({ purchasedGau: 10_000 });
    const settlement = seedCheckoutSettlement();
    store.log.length = 0;
    const tx = makeFakeGauTx(store);

    await reconcilePendingGauReversals(tx, {
      settlement,
      paymentIntentId: "pi_gau_001",
      now: NOW,
    });

    const lockAt = store.log.findIndex((e) => e.op === "lock");
    const pendingReadAt = store.log.findIndex(
      (e) => e.op === "select" && e.table === "reversals",
    );
    expect(lockAt).toBe(0);
    expect(lockAt).toBeLessThan(pendingReadAt);
  });
});

describe("a second partial refund after a period rollover (ADR-085 §11)", () => {
  const AUGUST_START = new Date("2026-08-01T00:00:00.000Z");

  it("debits the CURRENT bucket's carried units, not the bucket the first refund used", async () => {
    // August is where the first refund took its units. The rollover carried
    // what was left into September, which is the only balance the gate reads.
    // `existing.bucketId` still says August — a fact about when the row was
    // written, not about where the units live now. Debiting it would leave
    // September's carried units spendable although more money went back.
    const august = seedBucket({
      periodStart: AUGUST_START,
      periodEnd: PERIOD_START,
      purchasedGau: 5_000,
      carriedGau: 0,
    });
    const september = seedBucket({ purchasedGau: 0, carriedGau: 5_000 });
    const settlement = seedCheckoutSettlement({ bucketId: august.id });

    // The first refund, already recorded against August.
    store.reversals.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      settlementId: settlement.id,
      bucketId: august.id,
      stripePaymentIntentId: "pi_gau_001",
      kind: "refund",
      providerEventId: "ch_gau_001",
      requestedGau: 5_000,
      reversedGau: 5_000,
      unrecoveredGau: 0,
      amountCents: 2_750,
      currency: "usd",
      createdAt: NOW,
    });

    // The operator refunds the rest: cumulative 5,500c of a 5,500c charge.
    const result = await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );

    expect(result).toMatchObject({
      applied: true,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
      bucketId: september.id,
    });
    // The row that matters: September's carried units are gone.
    const septemberAfter = store.buckets.find((b) => b.id === september.id);
    expect(septemberAfter).toMatchObject({ purchasedGau: 0, carriedGau: 0 });
    // And August is untouched — it is history, not a balance.
    const augustAfter = store.buckets.find((b) => b.id === august.id);
    expect(augustAfter).toMatchObject({ purchasedGau: 5_000, carriedGau: 0 });
    // The reversal now points at where the units actually went.
    expect(store.reversals[0]).toMatchObject({ bucketId: september.id });
  });

  it("materialises the current bucket when the rolled month has no row yet", async () => {
    const august = seedBucket({
      periodStart: AUGUST_START,
      periodEnd: PERIOD_START,
      purchasedGau: 10_000,
      usedGau: 0,
    });
    const settlement = seedCheckoutSettlement({ bucketId: august.id });
    store.reversals.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      settlementId: settlement.id,
      bucketId: august.id,
      stripePaymentIntentId: "pi_gau_001",
      kind: "refund",
      providerEventId: "ch_gau_001",
      requestedGau: 5_000,
      reversedGau: 5_000,
      unrecoveredGau: 0,
      amountCents: 2_750,
      currency: "usd",
      createdAt: NOW,
    });

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );

    // September did not exist; it is created with August's carry and debited.
    expect(store.buckets).toHaveLength(2);
    const september = store.buckets.find(
      (b) => (b.periodStart as Date).getTime() === PERIOD_START.getTime(),
    );
    expect(september).toBeDefined();
    expect(september).toMatchObject({ orgId: ORG });
    expect(store.buckets.find((b) => b.id === august.id)).toMatchObject({
      purchasedGau: 10_000,
    });
  });
});

describe("the debit writes only the columns it owns (ADR-085 §11)", () => {
  // `billing.gau_buckets` has eight writers. Seven of them set columns this one
  // never names — overage_invoiced_gau (+q), closed_at, interim_seq, topup_seq,
  // open_topup_settlement_id — and two of those are coupled to used_gau by the
  // CHECK `gau_buckets_overage_invoiced_within_used`.
  //
  // Today the row lock already makes this safe: the read that feeds the write
  // happens inside it (`ensureCurrentBucket` returns the locked row), so the
  // values are never stale and even a whole-object write would be correct —
  // verified against real Postgres, where that mutation stays green.
  //
  // This is asserted anyway, because that safety is a property of where the
  // READ sits, and nothing stops a future edit moving it outside the lock while
  // leaving the write looking identical. Naming only the owned columns is the
  // property that survives that edit. Round six's lesson applied to round six's
  // own fix: a verification that lives only in a reviewer's head is not a
  // mechanism.

  const OWNED = ["purchasedGau", "carriedGau", "updatedAt"].sort();

  it("names exactly purchased, carried and updatedAt — nothing else", async () => {
    seedBucket({ purchasedGau: 10_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    const bucketWrites = store.log.filter(
      (e) => e.op === "update" && e.table === "buckets",
    );
    expect(bucketWrites.length).toBeGreaterThan(0);
    for (const write of bucketWrites) {
      expect(Object.keys(write.set ?? {}).sort()).toEqual(OWNED);
    }
  });

  it("never names usedGau or overageInvoicedGau, the CHECK-coupled pair", async () => {
    seedBucket({ purchasedGau: 10_000, usedGau: 4_000, overageInvoicedGau: 0 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(refundedCharge());

    for (const write of store.log.filter(
      (e) => e.op === "update" && e.table === "buckets",
    )) {
      const keys = Object.keys(write.set ?? {});
      expect(keys).not.toContain("usedGau");
      expect(keys).not.toContain("overageInvoicedGau");
      expect(keys).not.toContain("closedAt");
      expect(keys).not.toContain("openTopupSettlementId");
    }
    // And the row still carries what it carried.
    expect(store.buckets[0]).toMatchObject({
      usedGau: 4_000,
      overageInvoicedGau: 0,
    });
  });

  it("holds on the cumulative-increase path too, which is where the last two defects were", async () => {
    seedBucket({ purchasedGau: 10_000, usedGau: 4_000 });
    seedCheckoutSettlement();

    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 2_750 }),
    );
    store.log.length = 0;
    await reverseGauPurchaseForRefund(
      refundedCharge({ amountRefundedCents: 5_500 }),
    );

    const bucketWrites = store.log.filter(
      (e) => e.op === "update" && e.table === "buckets",
    );
    expect(bucketWrites.length).toBeGreaterThan(0);
    for (const write of bucketWrites) {
      expect(Object.keys(write.set ?? {}).sort()).toEqual(OWNED);
    }
  });
});
