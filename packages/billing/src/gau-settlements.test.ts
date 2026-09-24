/**
 * Unit tests for gau-settlements.ts — the claims, the settlement writers, the
 * settlement sequence, the accrual close and the close job's two steps
 * (ADR-055 §6, ARCHITECTURE.md §3.9 items 7, 8c, 8d, 10, 11 and 12; INV-30).
 *
 * Runs against the in-memory executor in test-utils/gau-fake-tx.ts, which
 * mirrors the re-checked claim UPDATE, the session-keyed settlement insert
 * and the payment-method mirror upsert, and records every statement. The
 * terms and the settings are module doubles, each `satisfies Pick<…>` so a
 * rename of the real export fails here at typecheck; the provider is a fake
 * that records the calls the grant, the settlement sequence and the job make.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeGauStore,
  makeFakeGauTx,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";
import type { Tx } from "@oxagen/database";
import type { GauSettlementRow, GauSettlementScope } from "./gau-settlements";
import type { BillingCheckoutSession, BillingProvider } from "./provider";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  realWithTenantDb: null as null | ((fn: (tx: unknown) => unknown) => unknown),
  readGauEntitlement: vi.fn(),
  resolveGauEntitlement: vi.fn(),
  readOrgBillingSettings: vi.fn(),
  assertOrgCanConsume: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  provider: {
    getCheckoutPaymentMethod: vi.fn(),
    getDefaultPaymentMethodId: vi.fn(),
    setDefaultPaymentMethod: vi.fn(),
    createGauInvoice: vi.fn(),
    finalizeAndPayGauInvoice: vi.fn(),
    deleteOrVoidDraftInvoice: vi.fn(),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  mocks.realWithTenantDb = real.withTenantDb as typeof mocks.realWithTenantDb;
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock(
  "./contract-terms",
  () =>
    ({
      readGauEntitlement: mocks.readGauEntitlement,
      resolveGauEntitlement: mocks.resolveGauEntitlement,
    }) satisfies Pick<
      typeof import("./contract-terms"),
      "readGauEntitlement" | "resolveGauEntitlement"
    >,
);

vi.mock(
  "./billing-settings",
  () =>
    ({
      readOrgBillingSettings: mocks.readOrgBillingSettings,
    }) satisfies Pick<
      typeof import("./billing-settings"),
      "readOrgBillingSettings"
    >,
);

vi.mock(
  "./dunning",
  () =>
    ({ assertOrgCanConsume: mocks.assertOrgCanConsume }) satisfies Pick<
      typeof import("./dunning"),
      "assertOrgCanConsume"
    >,
);

vi.mock(
  "./customers",
  () =>
    ({ ensureStripeCustomer: mocks.ensureStripeCustomer }) satisfies Pick<
      typeof import("./customers"),
      "ensureStripeCustomer"
    >,
);

vi.mock(
  "./client",
  () =>
    ({
      billingProvider: () => mocks.provider as unknown as BillingProvider,
    }) satisfies Pick<typeof import("./client"), "billingProvider">,
);

const {
  claimAutoTopup,
  claimInterimInvoice,
  closeEndedGauPeriods,
  closeInvoiceAccrual,
  grantGauPurchaseForCheckout,
  recordGauInvoice,
  resumePendingGauSettlements,
  settleGauFailed,
  settleGauInvoice,
  settleGauOpen,
  settleGauPaid,
} = await import("./gau-settlements");
const { uninvoicedGau, remainingGau } = await import("./gau-bucket");
const { logger } = await import("./logger");
const { assertGauAvailable, GauExhaustedError } = await import("./gau-bucket");

const ORG = "00000000-0000-0000-0000-00000000a0a1";
const FREE_TERMS = {
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};

let store: FakeGauStore;

function seedBucket(overrides: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-01T00:00:00.000Z"),
    includedGau: 5_000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 5_000,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null as string | null,
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.buckets.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  store = makeFakeGauStore();
});

describe("claimAutoTopup", () => {
  it("claims the episode and inserts one pending auto_topup settlement for blocks × block_size at the terms' rate", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);

    const row = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);

    expect(row).toMatchObject({
      orgId: ORG,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq: 1,
      quantityGau: 5_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "pending",
    });
    expect(store.settlements).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      openTopupSettlementId: row!.id,
      topupSeq: 1,
    });
  });

  it("charges auto_topup_blocks blocks", async () => {
    const bucket = seedBucket({});
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      3,
    );
    expect(row?.quantityGau).toBe(15_000);
  });

  it("records the rate in force at claim time, so a later terms change does not reprice it", async () => {
    const bucket = seedBucket({});
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      { ...FREE_TERMS, ratePerGauMicros: 4_000n, blockSizeGau: 10_000 },
      1,
    );
    expect(row).toMatchObject({
      ratePerGauMicros: 4_000n,
      quantityGau: 10_000,
    });
  });

  it("claims nothing while an episode is already open, and writes no row", async () => {
    const bucket = seedBucket({
      openTopupSettlementId: crypto.randomUUID(),
      topupSeq: 1,
    });
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      1,
    );
    expect(row).toBeNull();
    expect(store.settlements).toHaveLength(0);
    expect(store.buckets[0]!.topupSeq).toBe(1);
  });

  it("claims nothing when the bucket is no longer exhausted (the re-checked WHERE)", async () => {
    const bucket = seedBucket({ usedGau: 4_999 });
    const row = await claimAutoTopup(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      1,
    );
    expect(row).toBeNull();
    expect(store.settlements).toHaveLength(0);
  });

  it("of 20 concurrent claims on one exhausted bucket exactly one gets a row", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimAutoTopup(tx, bucket, FREE_TERMS, 1),
      ),
    );
    expect(rows.filter((r) => r !== null)).toHaveLength(1);
    expect(store.settlements).toHaveLength(1);
    expect(store.buckets[0]!.topupSeq).toBe(1);
  });

  it("a second episode after the first is cleared gets seq 2", async () => {
    const bucket = seedBucket({});
    const tx = makeFakeGauTx(store);
    const first = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    store.buckets[0]!.openTopupSettlementId = null;
    const second = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
  });

  it("runs the claim and the insert on the executor it is passed, in that order, and opens no transaction", async () => {
    const bucket = seedBucket({});
    await claimAutoTopup(makeFakeGauTx(store), bucket, FREE_TERMS, 1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(store.log.map((s) => `${s.op}:${s.table}`)).toEqual([
      "update:buckets",
      "insert:settlements",
    ]);
  });
});

// ── grantGauPurchaseForCheckout ─────────────────────────────────────────────

const NOW = new Date("2026-09-15T12:00:00.000Z");
const SEPTEMBER = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};

/** The Free published terms, resolved for an org with no subscription. */
const FREE_ENTITLEMENT = {
  terms: {
    source: "published_tier" as const,
    tier: "free" as const,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveTo: null,
    ...FREE_TERMS,
  },
  subscription: null,
};

const CARD = {
  id: "pm_checkout_001",
  type: "card",
  brand: "visa",
  last4: "4242",
  expMonth: 12,
  expYear: 2030,
};

function paidSession(
  overrides: Partial<BillingCheckoutSession> = {},
): BillingCheckoutSession {
  return {
    id: "cs_gau_001",
    mode: "payment",
    paymentStatus: "paid",
    customerId: "cus_gau_001",
    metadata: {
      oxagen_kind: "gau_purchase",
      org_id: ORG,
      gau_quantity: "10000",
      block_size_gau: "5000",
      rate_per_gau_micros: "5000",
      currency: "usd",
    },
    subscriptionId: null,
    invoiceId: "in_gau_001",
    paymentIntentId: "pi_gau_001",
    amountTotalCents: 5_000,
    ...overrides,
  };
}

describe("grantGauPurchaseForCheckout", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const tx = makeFakeGauTx(store);
    mocks.withSystemDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    mocks.withTenantDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    mocks.readGauEntitlement.mockResolvedValue(FREE_ENTITLEMENT);
    mocks.resolveGauEntitlement.mockResolvedValue(FREE_ENTITLEMENT);
    mocks.readOrgBillingSettings.mockResolvedValue({
      orgId: ORG,
      stripeCustomerId: "cus_gau_001",
      approvedForInvoiceBilling: false,
      invoiceGauMax: 100_000,
      autoTopupEnabled: true,
      autoTopupBlocks: 1,
      dunningState: "active",
    });
    mocks.assertOrgCanConsume.mockResolvedValue(undefined);
    mocks.provider.getCheckoutPaymentMethod.mockResolvedValue(CARD);
    mocks.provider.getDefaultPaymentMethodId.mockResolvedValue(null);
    mocks.provider.setDefaultPaymentMethod.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lands the grant with no prior row: a paid checkout settlement keyed on the session, and the quantity on the month's purchased_gau", async () => {
    await grantGauPurchaseForCheckout(paidSession());

    expect(store.settlements).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      orgId: ORG,
      kind: "checkout",
      seq: null,
      quantityGau: 10_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "paid",
      stripeCheckoutSessionId: "cs_gau_001",
      stripeInvoiceId: "in_gau_001",
      // ADR-085: the PaymentIntent is the only identifier a later
      // charge.refunded or charge.dispute.created carries that reaches back
      // to this row, so a grant that did not record it would leave the
      // purchase unreversible.
      stripePaymentIntentId: "pi_gau_001",
      settledAt: NOW,
    });
    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      orgId: ORG,
      periodStart: SEPTEMBER.start,
      periodEnd: SEPTEMBER.end,
      includedGau: 5_000,
      purchasedGau: 10_000,
      usedGau: 0,
    });
    expect(store.settlements[0]!.bucketId).toBe(store.buckets[0]!.id);
  });

  it("grants nothing on a second delivery of the same session", async () => {
    await grantGauPurchaseForCheckout(paidSession());
    await grantGauPurchaseForCheckout(paidSession());

    expect(store.settlements).toHaveLength(1);
    expect(store.buckets[0]!.purchasedGau).toBe(10_000);
  });

  it("adds to an existing month bucket and clears its open auto top-up episode", async () => {
    const open = crypto.randomUUID();
    seedBucket({
      usedGau: 5_000,
      openTopupSettlementId: open,
      topupSeq: 1,
    });

    await grantGauPurchaseForCheckout(paidSession());

    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      purchasedGau: 10_000,
      usedGau: 5_000,
      openTopupSettlementId: null,
      topupSeq: 1,
    });
  });

  it("makes the collected card the customer default when none existed, and mirrors it as the default row", async () => {
    await grantGauPurchaseForCheckout(paidSession());

    expect(mocks.provider.getCheckoutPaymentMethod).toHaveBeenCalledWith(
      "cs_gau_001",
    );
    expect(mocks.provider.setDefaultPaymentMethod).toHaveBeenCalledWith(
      "cus_gau_001",
      "pm_checkout_001",
    );
    expect(store.paymentMethods).toHaveLength(1);
    expect(store.paymentMethods[0]).toMatchObject({
      orgId: ORG,
      stripeCustomerId: "cus_gau_001",
      stripePaymentMethodId: "pm_checkout_001",
      type: "card",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
  });

  it("leaves an existing default alone: the new card is mirrored as a non-default row", async () => {
    store.paymentMethods.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      stripeCustomerId: "cus_gau_001",
      stripePaymentMethodId: "pm_existing",
      type: "card",
      brand: "amex",
      last4: "0005",
      expMonth: 1,
      expYear: 2029,
      isDefault: true,
      deletedAt: null,
    });
    mocks.provider.getDefaultPaymentMethodId.mockResolvedValue("pm_existing");

    await grantGauPurchaseForCheckout(paidSession());

    expect(mocks.provider.setDefaultPaymentMethod).not.toHaveBeenCalled();
    const byId = Object.fromEntries(
      store.paymentMethods.map((r) => [r.stripePaymentMethodId, r.isDefault]),
    );
    expect(byId).toEqual({ pm_existing: true, pm_checkout_001: false });
  });

  it("saves the card again on a redelivery without demoting it", async () => {
    await grantGauPurchaseForCheckout(paidSession());
    mocks.provider.getDefaultPaymentMethodId.mockResolvedValue(
      "pm_checkout_001",
    );
    await grantGauPurchaseForCheckout(paidSession());

    expect(mocks.provider.setDefaultPaymentMethod).toHaveBeenCalledOnce();
    expect(store.paymentMethods).toHaveLength(1);
    expect(store.paymentMethods[0]!.isDefault).toBe(true);
  });

  it("marks the card default on a redelivery after the Stripe update committed and the mirror write failed", async () => {
    // First delivery: the grant commits, Stripe takes the card as default,
    // then the mirror transaction fails.
    const tx = makeFakeGauTx(store);
    mocks.withSystemDb
      .mockImplementationOnce(async (fn: (t: unknown) => unknown) => fn(tx))
      .mockRejectedValueOnce(new Error("connection reset"));
    await expect(grantGauPurchaseForCheckout(paidSession())).rejects.toThrow(
      "connection reset",
    );
    expect(mocks.provider.setDefaultPaymentMethod).toHaveBeenCalledOnce();
    expect(store.settlements).toHaveLength(1);
    expect(store.paymentMethods).toHaveLength(0);

    // Redelivery: the customer's default is already this card.
    mocks.withSystemDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );
    mocks.provider.getDefaultPaymentMethodId.mockResolvedValue(
      "pm_checkout_001",
    );
    await grantGauPurchaseForCheckout(paidSession());

    expect(mocks.provider.setDefaultPaymentMethod).toHaveBeenCalledOnce();
    expect(store.settlements).toHaveLength(1);
    expect(store.paymentMethods).toHaveLength(1);
    expect(store.paymentMethods[0]!.isDefault).toBe(true);
  });

  it("a Free org's first purchase leaves it with a default card, so its next exhaustion is refused with no free_no_payment_method reason", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    // Before the purchase: exhausted, no card — the add-a-card refusal.
    await expect(assertGauAvailable(ORG, NOW)).rejects.toMatchObject({
      code: "gau_exhausted",
      reason: "free_no_payment_method",
    });

    await grantGauPurchaseForCheckout(paidSession());
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();

    // The purchased units are spent: the prepaid path, as for Build.
    bucket.usedGau = 15_000;
    const err = await assertGauAvailable(ORG, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GauExhaustedError);
    expect((err as InstanceType<typeof GauExhaustedError>).reason).toBeNull();
  });

  it("grants nothing for a session that completed unpaid", async () => {
    await grantGauPurchaseForCheckout(paidSession({ paymentStatus: "unpaid" }));
    expect(store.settlements).toHaveLength(0);
    expect(store.buckets).toHaveLength(0);
    expect(mocks.provider.getCheckoutPaymentMethod).not.toHaveBeenCalled();
  });

  it.each([
    ["no org", { org_id: "" }],
    ["a non-uuid org", { org_id: "org-1" }],
    ["a zero quantity", { gau_quantity: "0" }],
    ["a fractional quantity", { gau_quantity: "2500.5" }],
    ["a quantity off the block", { gau_quantity: "7000" }],
    ["a missing block size", { block_size_gau: "" }],
    ["a rate that is not digits", { rate_per_gau_micros: "5e3" }],
    ["a currency that is not a code", { currency: "dollars" }],
  ])(
    "refuses a gau_purchase session with %s and writes nothing",
    async (_n, meta) => {
      const session = paidSession();
      session.metadata = { ...session.metadata, ...meta };
      await expect(grantGauPurchaseForCheckout(session)).rejects.toThrow(
        "no valid purchase metadata",
      );
      expect(store.settlements).toHaveLength(0);
      expect(store.buckets).toHaveLength(0);
    },
  );

  it("skips the card step for a session with no customer or no saved card", async () => {
    await grantGauPurchaseForCheckout(paidSession({ customerId: null }));
    expect(mocks.provider.getCheckoutPaymentMethod).not.toHaveBeenCalled();

    mocks.provider.getCheckoutPaymentMethod.mockResolvedValue(null);
    await grantGauPurchaseForCheckout(paidSession({ id: "cs_gau_002" }));
    expect(mocks.provider.getDefaultPaymentMethodId).not.toHaveBeenCalled();
    expect(store.paymentMethods).toHaveLength(0);
  });

  it("runs with no active tenant scope: the entitlement read and every write are on the withSystemDb transaction", async () => {
    // The real withTenantDb refuses before it touches a database when no
    // scope is entered, which is the webhook's situation. The tenant-scoped
    // entitlement read goes through that seam here, so a grant that reached
    // for it would throw.
    mocks.withTenantDb.mockImplementation(mocks.realWithTenantDb!);
    mocks.resolveGauEntitlement.mockImplementation((orgId: string, now: Date) =>
      mocks.realWithTenantDb!((t) => mocks.readGauEntitlement(t, orgId, now)),
    );
    const tx = makeFakeGauTx(store);
    mocks.withSystemDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn(tx),
    );

    await grantGauPurchaseForCheckout(paidSession());

    expect(mocks.readGauEntitlement).toHaveBeenCalledWith(tx, ORG, NOW);
    expect(mocks.resolveGauEntitlement).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(store.settlements).toHaveLength(1);
    expect(store.paymentMethods).toHaveLength(1);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
    await expect(
      mocks.realWithTenantDb!(async () => undefined),
    ).rejects.toThrow("No active tenant scope");
  });

  it("commits the grant before the first provider call", async () => {
    const order: string[] = [];
    mocks.withSystemDb.mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        const out = await fn(makeFakeGauTx(store));
        order.push("commit");
        return out;
      },
    );
    mocks.provider.getCheckoutPaymentMethod.mockImplementation(async () => {
      order.push("provider");
      return CARD;
    });

    await grantGauPurchaseForCheckout(paidSession());

    expect(order.slice(0, 2)).toEqual(["commit", "provider"]);
  });

  // ── The refund that arrived first (ADR-085 §5) ────────────────────────────
  //
  // These go through grantGauPurchaseForCheckout itself, not through
  // reconcilePendingGauReversals directly. That distinction is the whole point:
  // the reconciliation function was already covered in gau-reversals.test.ts,
  // and deleting the grant's CALL to it left all of those tests green. A test
  // that exercises the helper proves the helper; only a test that goes through
  // the real entry point proves the wiring.

  /** A refund parked against this purchase's PaymentIntent before it existed. */
  function parkPendingReversal(amountCents = 5_000) {
    store.reversals.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      settlementId: null,
      bucketId: null,
      stripePaymentIntentId: "pi_gau_001",
      kind: "refund",
      providerEventId: "ch_gau_001",
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      amountCents,
      currency: "usd",
      createdAt: NOW,
    });
  }

  it("grants a purchase whose money already came back and leaves no spendable units", async () => {
    parkPendingReversal();

    await grantGauPurchaseForCheckout(paidSession());

    // The settlement is recorded — the sale happened and the ledger says so.
    expect(store.settlements).toHaveLength(1);
    // The units are not spendable. This is the assertion that matters: the
    // grant added 10,000 and the reconciliation took them back out inside the
    // same transaction, so the customer never had them.
    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({
      orgId: ORG,
      purchasedGau: 0,
      carriedGau: 0,
    });
    expect(remainingGau(store.buckets[0] as never)).toBe(5_000); // the included allowance only
    // And the parked row is now linked to what it reversed.
    expect(store.reversals[0]).toMatchObject({
      settlementId: store.settlements[0]!.id,
      bucketId: store.buckets[0]!.id,
      requestedGau: 10_000,
      reversedGau: 10_000,
      unrecoveredGau: 0,
    });
  });

  it("nets out a partial refund that arrived first, leaving exactly the unrefunded units", async () => {
    // Half the tax-inclusive charge came back before the purchase landed.
    parkPendingReversal(2_500);

    await grantGauPurchaseForCheckout(paidSession());

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 5_000 });
    expect(store.reversals[0]).toMatchObject({
      requestedGau: 5_000,
      reversedGau: 5_000,
      unrecoveredGau: 0,
    });
  });

  it("grants normally when no refund is waiting", async () => {
    // The control. Without it the two tests above would also pass against an
    // implementation that simply never granted anything.
    await grantGauPurchaseForCheckout(paidSession());

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
    expect(store.reversals).toHaveLength(0);
  });

  it("a redelivered checkout does not reconcile a second time", async () => {
    parkPendingReversal();

    await grantGauPurchaseForCheckout(paidSession());
    await grantGauPurchaseForCheckout(paidSession());

    // The second delivery inserts no settlement and so never reaches
    // reconciliation; the row is no longer pending either way.
    expect(store.settlements).toHaveLength(1);
    expect(store.reversals).toHaveLength(1);
    expect(store.buckets[0]).toMatchObject({ purchasedGau: 0 });
  });

  it("leaves a pending reversal for a different PaymentIntent alone", async () => {
    store.reversals.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      settlementId: null,
      bucketId: null,
      stripePaymentIntentId: "pi_someone_else",
      kind: "refund",
      providerEventId: "ch_other",
      requestedGau: 0,
      reversedGau: 0,
      unrecoveredGau: 0,
      amountCents: 5_000,
      currency: "usd",
      createdAt: NOW,
    });

    await grantGauPurchaseForCheckout(paidSession());

    expect(store.buckets[0]).toMatchObject({ purchasedGau: 10_000 });
    expect(store.reversals[0]).toMatchObject({ settlementId: null });
  });
});

// ── Settlements in motion ───────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const AUGUST = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};

/** Settings as readOrgBillingSettings answers them. */
function settingsWith(over: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    stripeCustomerId: "cus_gau_001",
    approvedForInvoiceBilling: false,
    invoiceGauMax: 100_000,
    autoTopupEnabled: true,
    autoTopupBlocks: 1,
    dunningState: "active",
    ...over,
  };
}

function seedSettlement(overrides: Record<string, unknown>): GauSettlementRow {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    bucketId: crypto.randomUUID(),
    kind: "auto_topup",
    seq: 1,
    quantityGau: 5_000,
    ratePerGauMicros: 5_000n,
    currency: "usd",
    status: "pending",
    stripeCheckoutSessionId: null,
    stripeInvoiceId: null,
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    settledAt: null,
    ...overrides,
  };
  store.settlements.push(row);
  return row as unknown as GauSettlementRow;
}

/** The settlement row as the store holds it now. */
const settlement = (id: string) => store.settlements.find((r) => r.id === id)!;

/** Every provider call and every committed system transaction, in order. */
let events: string[];

/**
 * The world these tests run in: `now` is 15 September, the org is on the
 * Free published terms with no subscription, every system transaction runs
 * on the fake store and logs its commit, and the real withTenantDb refuses —
 * nothing on these paths may reach for a tenant scope. The fake provider
 * creates an invoice per settlement, pays it, and deletes a draft.
 */
function inMotion() {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    events = [];
    const tx = makeFakeGauTx(store);
    mocks.withSystemDb.mockImplementation(
      async (fn: (t: unknown) => unknown) => {
        const out = await fn(tx);
        events.push("commit");
        return out;
      },
    );
    mocks.withTenantDb.mockImplementation(mocks.realWithTenantDb!);
    mocks.readGauEntitlement.mockResolvedValue(FREE_ENTITLEMENT);
    mocks.readOrgBillingSettings.mockResolvedValue(settingsWith());
    mocks.ensureStripeCustomer.mockResolvedValue("cus_gau_001");
    mocks.provider.getCheckoutPaymentMethod.mockResolvedValue(null);
    mocks.provider.createGauInvoice.mockImplementation(
      async (input: { settlementId: string }) => {
        events.push(`create:${input.settlementId}`);
        return { invoiceId: `in_${input.settlementId}` };
      },
    );
    mocks.provider.finalizeAndPayGauInvoice.mockImplementation(
      async (ref: { invoiceId: string }) => {
        events.push(`finalize:${ref.invoiceId}`);
        return { status: "paid", amountCents: 2_500, hostedInvoiceUrl: null };
      },
    );
    mocks.provider.deleteOrVoidDraftInvoice.mockImplementation(
      async (ref: { invoiceId: string }) => {
        events.push(`deleteOrVoid:${ref.invoiceId}`);
        return { outcome: "deleted" };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

/** A scope on the fake store, the way the recorder and the job build theirs. */
function scopeWith(paymentMethodId: string | null): GauSettlementScope {
  return {
    run: ((fn: (tx: Tx) => Promise<unknown>) =>
      mocks.withSystemDb(fn)) as GauSettlementScope["run"],
    customerId: async () => "cus_gau_001",
    defaultPaymentMethodId: async () => paymentMethodId,
  };
}

/** Provider calls only, without the commits. */
const providerCalls = () => events.filter((e) => e !== "commit");

describe("claimInterimInvoice", () => {
  it("claims exactly the quantity as one pending interim_invoice at the terms' rate, and uninvoiced restarts", async () => {
    const bucket = seedBucket({ usedGau: 5_000 + 100_250 });

    const row = await claimInterimInvoice(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      100_000,
    );

    expect(row).toMatchObject({
      orgId: ORG,
      bucketId: bucket.id,
      kind: "interim_invoice",
      seq: 1,
      quantityGau: 100_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "pending",
      stripeInvoiceId: null,
    });
    expect(store.buckets[0]).toMatchObject({
      overageInvoicedGau: 100_000,
      interimSeq: 1,
      purchasedGau: 0,
    });
    // GAU #100,001 of overage opens the next accrual.
    expect(uninvoicedGau(bucket)).toBe(250);
  });

  it("gives a second crossing in the same month seq 2", async () => {
    const bucket = seedBucket({ usedGau: 5_000 + 100_000 });
    const tx = makeFakeGauTx(store);
    const first = await claimInterimInvoice(tx, bucket, FREE_TERMS, 100_000);
    bucket.usedGau += 100_000;
    const second = await claimInterimInvoice(tx, bucket, FREE_TERMS, 100_000);

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(store.buckets[0]!.overageInvoicedGau).toBe(200_000);
  });

  it("claims nothing below the quantity (the re-checked WHERE) and writes no row", async () => {
    const bucket = seedBucket({ usedGau: 5_000 + 99_999 });
    const row = await claimInterimInvoice(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      100_000,
    );
    expect(row).toBeNull();
    expect(store.settlements).toHaveLength(0);
    expect(store.buckets[0]).toMatchObject({
      overageInvoicedGau: 0,
      interimSeq: 0,
    });
  });

  it("of 20 concurrent claims at the threshold exactly one gets a row", async () => {
    const bucket = seedBucket({ usedGau: 5_000 + 100_000 });
    const tx = makeFakeGauTx(store);
    const rows = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimInterimInvoice(tx, bucket, FREE_TERMS, 100_000),
      ),
    );
    expect(rows.filter((r) => r !== null)).toHaveLength(1);
    expect(store.settlements).toHaveLength(1);
  });
});

describe("recordGauInvoice", () => {
  it("records the invoice id on a row that holds none", async () => {
    const row = seedSettlement({});
    await recordGauInvoice(makeFakeGauTx(store), row.id, "in_001");
    expect(settlement(row.id).stripeInvoiceId).toBe("in_001");
  });

  it("never overwrites an id already recorded", async () => {
    const row = seedSettlement({ stripeInvoiceId: "in_first" });
    await recordGauInvoice(makeFakeGauTx(store), row.id, "in_second");
    expect(settlement(row.id).stripeInvoiceId).toBe("in_first");
  });
});

describe("settleGauPaid", () => {
  inMotion();

  /** An exhausted September bucket whose auto top-up episode is the row. */
  function openEpisode(status: string) {
    const bucket = seedBucket({ usedGau: 5_000, topupSeq: 1 });
    const row = seedSettlement({ bucketId: bucket.id, status });
    bucket.openTopupSettlementId = row.id;
    return { bucket, row };
  }

  it("marks an open auto top-up paid, grants its quantity and clears the episode", async () => {
    const { bucket, row } = openEpisode("open");

    const paid = await settleGauPaid(makeFakeGauTx(store), row.id, NOW);

    expect(paid).toMatchObject({ id: row.id, status: "paid" });
    expect(settlement(row.id).settledAt).toBeInstanceOf(Date);
    expect(bucket).toMatchObject({
      purchasedGau: 5_000,
      openTopupSettlementId: null,
    });
  });

  it("grants once when called twice", async () => {
    const { bucket, row } = openEpisode("pending");
    const tx = makeFakeGauTx(store);

    await settleGauPaid(tx, row.id, NOW);
    const again = await settleGauPaid(tx, row.id, NOW);

    expect(again).toBeNull();
    expect(bucket.purchasedGau).toBe(5_000);
  });

  it("changes nothing on a row already paid", async () => {
    const { bucket, row } = openEpisode("paid");

    expect(await settleGauPaid(makeFakeGauTx(store), row.id, NOW)).toBeNull();

    expect(bucket).toMatchObject({
      purchasedGau: 0,
      openTopupSettlementId: row.id,
    });
    expect(store.log.filter((s) => s.table === "buckets")).toEqual([]);
  });

  it("grants a failed row whose invoice is paid after all", async () => {
    const { bucket, row } = openEpisode("failed");
    await settleGauPaid(makeFakeGauTx(store), row.id, NOW);
    expect(settlement(row.id).status).toBe("paid");
    expect(bucket.purchasedGau).toBe(5_000);
  });

  it("after rollover grants to the current month's bucket and leaves the settlement's own bucket as it was", async () => {
    const august = seedBucket({
      periodStart: AUGUST.start,
      periodEnd: AUGUST.end,
      usedGau: 5_000,
      topupSeq: 1,
    });
    const row = seedSettlement({ bucketId: august.id, status: "open" });
    august.openTopupSettlementId = row.id;

    await settleGauPaid(makeFakeGauTx(store), row.id, NOW);

    const september = store.buckets.find(
      (b) => (b.periodStart as Date).getTime() === SEPTEMBER.start.getTime(),
    );
    expect(september).toMatchObject({ purchasedGau: 5_000, usedGau: 0 });
    expect(august).toMatchObject({
      purchasedGau: 0,
      openTopupSettlementId: null,
    });
  });

  it("grants nothing for an invoice-kind settlement: overage is never purchased units", async () => {
    const bucket = seedBucket({ usedGau: 200_000 });
    const row = seedSettlement({
      bucketId: bucket.id,
      kind: "interim_invoice",
      quantityGau: 100_000,
      status: "open",
    });

    await settleGauPaid(makeFakeGauTx(store), row.id, NOW);

    expect(settlement(row.id).status).toBe("paid");
    expect(bucket.purchasedGau).toBe(0);
    expect(mocks.readGauEntitlement).not.toHaveBeenCalled();
  });
});

describe("settleGauOpen and settleGauFailed", () => {
  inMotion();

  it("move a pending row and nothing else", async () => {
    const tx = makeFakeGauTx(store);
    const pending = seedSettlement({ status: "pending" });
    const open = seedSettlement({ status: "open" });
    const paid = seedSettlement({ status: "paid" });

    expect(await settleGauOpen(tx, pending.id)).toMatchObject({
      status: "open",
    });
    expect(await settleGauFailed(tx, open.id)).toBeNull();
    expect(await settleGauOpen(tx, paid.id)).toBeNull();
    expect(await settleGauFailed(tx, paid.id)).toBeNull();

    expect(store.settlements.map((r) => r.status)).toEqual([
      "open",
      "open",
      "paid",
    ]);
  });

  it("a top-up that ends open leaves the episode set, and a second exhaustion in the month claims nothing", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    const tx = makeFakeGauTx(store);
    const row = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    await settleGauOpen(tx, row!.id);

    bucket.usedGau += 1_000;
    expect(await claimAutoTopup(tx, bucket, FREE_TERMS, 1)).toBeNull();

    expect(bucket.openTopupSettlementId).toBe(row!.id);
    expect(store.settlements).toHaveLength(1);
  });

  it("a top-up that ends failed clears its episode, and the next exhaustion in the month claims again", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    const tx = makeFakeGauTx(store);
    const first = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);

    expect(await settleGauFailed(tx, first!.id)).toMatchObject({
      status: "failed",
    });
    expect(bucket.openTopupSettlementId).toBeNull();

    const second = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    expect(second).toMatchObject({ seq: 2, status: "pending" });
  });

  it("a failed row leaves an episode another settlement holds, and a failed interim row writes no bucket", async () => {
    const held = crypto.randomUUID();
    const bucket = seedBucket({ openTopupSettlementId: held, topupSeq: 2 });
    const tx = makeFakeGauTx(store);
    const stale = seedSettlement({ bucketId: bucket.id, seq: 1 });
    const interim = seedSettlement({
      bucketId: bucket.id,
      kind: "interim_invoice",
    });

    await settleGauFailed(tx, stale.id);
    await settleGauFailed(tx, interim.id);

    expect(bucket.openTopupSettlementId).toBe(held);
    expect(
      store.log.filter((s) => s.op === "update" && s.table === "buckets"),
    ).toHaveLength(1);
  });

  it("a paid Checkout clears the open episode, and the next exhaustion claims again", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    const tx = makeFakeGauTx(store);
    const first = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    await settleGauOpen(tx, first!.id);

    await grantGauPurchaseForCheckout(paidSession());
    expect(bucket.openTopupSettlementId).toBeNull();

    bucket.usedGau = 15_000;
    const second = await claimAutoTopup(tx, bucket, FREE_TERMS, 1);
    expect(second).toMatchObject({ seq: 2, status: "pending" });
  });
});

describe("settleGauInvoice", () => {
  inMotion();

  function claimedTopup() {
    const bucket = seedBucket({ usedGau: 5_000, topupSeq: 1 });
    const row = seedSettlement({ bucketId: bucket.id });
    bucket.openTopupSettlementId = row.id;
    return { bucket, row };
  }

  it("creates the invoice, records its id, finalizes and pays it, then grants and clears the episode", async () => {
    const { bucket, row } = claimedTopup();

    const outcome = await settleGauInvoice(row, scopeWith("pm_checkout_001"));

    expect(outcome).toBe("paid");
    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith({
      customerId: "cus_gau_001",
      orgId: ORG,
      settlementId: row.id,
      kind: "gau_auto_topup",
      quantityGau: 5_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      // The line names the bucket month it bills; FREE_ENTITLEMENT carries no
      // negotiated agreement, so no reference follows it.
      description: "Governed action units, auto top-up: 1 Sep to 30 Sep 2026",
      period: { start: SEPTEMBER.start, end: SEPTEMBER.end },
      collection: {
        method: "charge_automatically",
        defaultPaymentMethodId: "pm_checkout_001",
      },
    });
    // The line's month and agreement are read first, the id is committed
    // before finalizing, and the grant after the answer.
    expect(events).toEqual([
      "commit",
      `create:${row.id}`,
      "commit",
      `finalize:in_${row.id}`,
      "commit",
    ]);
    expect(settlement(row.id)).toMatchObject({
      status: "paid",
      stripeInvoiceId: `in_${row.id}`,
    });
    expect(bucket).toMatchObject({
      purchasedGau: 5_000,
      openTopupSettlementId: null,
    });
  });

  it("an org with no default card gets a send_invoice invoice due in 30 days, ends open with the id and no failed row, and a later invoice.paid marks it paid", async () => {
    const bucket = seedBucket({ usedGau: 105_000 });
    const row = await claimInterimInvoice(
      makeFakeGauTx(store),
      bucket,
      FREE_TERMS,
      100_000,
    );
    mocks.provider.finalizeAndPayGauInvoice.mockResolvedValueOnce({
      status: "open",
      amountCents: 50_000,
      hostedInvoiceUrl: "https://invoice.stripe.com/i/interim",
    });

    expect(await settleGauInvoice(row!, scopeWith(null))).toBe("open");

    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gau_interim",
        quantityGau: 100_000,
        collection: { method: "send_invoice", daysUntilDue: 30 },
      }),
    );
    expect(settlement(row!.id)).toMatchObject({
      status: "open",
      stripeInvoiceId: `in_${row!.id}`,
    });
    expect(store.settlements.filter((r) => r.status === "failed")).toEqual([]);

    // invoice.paid, whenever the customer pays the hosted invoice.
    await settleGauPaid(makeFakeGauTx(store), row!.id, NOW);
    // get_gau_bucket's pastDue: an open interim_invoice or period_close row.
    const pastDue = store.settlements.some(
      (r) =>
        (r.kind === "interim_invoice" || r.kind === "period_close") &&
        r.status === "open",
    );
    expect(settlement(row!.id).status).toBe("paid");
    expect(pastDue).toBe(false);
  });

  it("names the bucket's month and the negotiated agreement on a month-end line, read on the scope's executor", async () => {
    const august = {
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z"),
    };
    const bucket = seedBucket({
      periodStart: august.start,
      periodEnd: august.end,
    });
    const row = seedSettlement({
      bucketId: bucket.id,
      kind: "period_close",
      seq: 0,
    });
    mocks.readGauEntitlement.mockResolvedValue({
      terms: {
        ...FREE_ENTITLEMENT.terms,
        source: "negotiated" as const,
        tier: "enterprise" as const,
        agreementRef: "MSA-2026-014",
      },
      subscription: null,
    });

    await settleGauInvoice(row, scopeWith(null));

    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "gau_period_close",
        description:
          "Governed action units, month-end overage: 1 Aug to 31 Aug 2026 (agreement MSA-2026-014)",
        period: august,
      }),
    );
    // The terms are read on the scope's executor, not a fresh tenant scope.
    expect(mocks.readGauEntitlement).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
    );
  });

  it("refuses to invoice a settlement whose bucket is missing, and leaves it pending", async () => {
    const row = seedSettlement({ bucketId: crypto.randomUUID() });

    expect(await settleGauInvoice(row, scopeWith("pm_1"))).toBe("pending");

    expect(mocks.provider.createGauInvoice).not.toHaveBeenCalled();
    expect(settlement(row.id)).toMatchObject({
      status: "pending",
      stripeInvoiceId: null,
    });
  });

  it("leaves the row pending with no invoice id when the provider rejects the create, and does not throw", async () => {
    const { row } = claimedTopup();
    mocks.provider.createGauInvoice.mockRejectedValueOnce(
      new Error("stripe unreachable"),
    );

    expect(await settleGauInvoice(row, scopeWith("pm_1"))).toBe("pending");

    expect(settlement(row.id)).toMatchObject({
      status: "pending",
      stripeInvoiceId: null,
    });
    expect(mocks.provider.finalizeAndPayGauInvoice).not.toHaveBeenCalled();
  });

  it("leaves the row pending with its invoice id when the provider rejects the finalize", async () => {
    const { bucket, row } = claimedTopup();
    mocks.provider.finalizeAndPayGauInvoice.mockRejectedValueOnce(
      new Error("stripe unreachable"),
    );

    expect(await settleGauInvoice(row, scopeWith("pm_1"))).toBe("pending");

    expect(settlement(row.id)).toMatchObject({
      status: "pending",
      stripeInvoiceId: `in_${row.id}`,
    });
    expect(bucket.purchasedGau).toBe(0);
  });

  it("sends a row that already holds an invoice id straight to finalizeAndPayGauInvoice", async () => {
    const { row } = claimedTopup();
    settlement(row.id).stripeInvoiceId = "in_held";

    await settleGauInvoice(
      { ...row, stripeInvoiceId: "in_held" },
      scopeWith("pm_1"),
    );

    expect(mocks.provider.createGauInvoice).not.toHaveBeenCalled();
    expect(mocks.provider.finalizeAndPayGauInvoice).toHaveBeenCalledWith({
      settlementId: row.id,
      invoiceId: "in_held",
    });
  });

  it("grants once when the webhook's invoice.paid follows a synchronous paid", async () => {
    const { bucket, row } = claimedTopup();
    await settleGauInvoice(row, scopeWith("pm_1"));
    await settleGauPaid(makeFakeGauTx(store), row.id, NOW);
    expect(bucket.purchasedGau).toBe(5_000);
  });

  it("invoices no checkout row: it is logged and left, with no provider call", async () => {
    const row = seedSettlement({ kind: "checkout", seq: null });
    expect(await settleGauInvoice(row, scopeWith("pm_1"))).toBe("pending");
    expect(mocks.provider.createGauInvoice).not.toHaveBeenCalled();
  });
});

describe("closeInvoiceAccrual", () => {
  inMotion();

  it("claims every uninvoiced GAU of the current bucket as one interim_invoice and leaves uninvoiced at 0", async () => {
    const bucket = seedBucket({ usedGau: 5_000 + 7_321 });
    mocks.provider.finalizeAndPayGauInvoice.mockResolvedValueOnce({
      status: "open",
      amountCents: 3_661,
      hostedInvoiceUrl: null,
    });

    const row = await closeInvoiceAccrual(ORG, NOW);

    expect(row).toMatchObject({ kind: "interim_invoice", quantityGau: 7_321 });
    expect(store.settlements).toHaveLength(1);
    expect(settlement(row!.id)).toMatchObject({
      status: "open",
      stripeInvoiceId: `in_${row!.id}`,
    });
    expect(uninvoicedGau(bucket)).toBe(0);
    expect(mocks.ensureStripeCustomer).toHaveBeenCalledWith(ORG, {
      system: true,
    });
    // No card saved: the invoice is emailed.
    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: { method: "send_invoice", daysUntilDue: 30 },
      }),
    );
  });

  it("collects from the org's default card when one is saved", async () => {
    seedBucket({ usedGau: 6_000 });
    store.paymentMethods.push({
      id: crypto.randomUUID(),
      orgId: ORG,
      stripePaymentMethodId: "pm_default",
      isDefault: true,
      deletedAt: null,
    });
    await closeInvoiceAccrual(ORG, NOW);
    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: {
          method: "charge_automatically",
          defaultPaymentMethodId: "pm_default",
        },
      }),
    );
  });

  it("claims nothing and calls no provider when nothing is uninvoiced", async () => {
    seedBucket({ usedGau: 4_000 });
    expect(await closeInvoiceAccrual(ORG, NOW)).toBeNull();
    expect(store.settlements).toHaveLength(0);
    expect(providerCalls()).toEqual([]);
  });

  it("claims nothing for an org with no bucket this month", async () => {
    expect(await closeInvoiceAccrual(ORG, NOW)).toBeNull();
    expect(store.settlements).toHaveLength(0);
  });

  it("invoices an ended month the close job has not closed yet as one period_close, and a later job run changes nothing", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue(
      settingsWith({ approvedForInvoiceBilling: true }),
    );
    const august = seedBucket({
      periodStart: AUGUST.start,
      periodEnd: AUGUST.end,
      usedGau: 5_000 + 7_321,
    });

    expect(await closeInvoiceAccrual(ORG, NOW)).toBeNull();

    expect(store.settlements).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      bucketId: august.id,
      kind: "period_close",
      seq: 0,
      quantityGau: 7_321,
    });
    expect(august.closedAt).toBeInstanceOf(Date);
    expect(uninvoicedGau(august)).toBe(0);

    // The switch has landed: the job now sees a prepaid org.
    mocks.readOrgBillingSettings.mockResolvedValue(settingsWith());
    const before = structuredClone({
      buckets: store.buckets,
      settlements: store.settlements,
    });
    expect(await closeEndedGauPeriods(null, NOW)).toEqual({
      processed: 0,
      nextCursor: null,
    });
    expect({
      buckets: store.buckets,
      settlements: store.settlements,
    }).toEqual(before);
  });
});

describe("closeEndedGauPeriods", () => {
  inMotion();

  const endedAugust = (over: Record<string, unknown>) =>
    seedBucket({ periodStart: AUGUST.start, periodEnd: AUGUST.end, ...over });

  it("invoices an ended invoice-billed month's uninvoiced overage as one period_close settlement (seq 0) and closes it", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue(
      settingsWith({ approvedForInvoiceBilling: true }),
    );
    const bucket = endedAugust({ usedGau: 5_000 + 12_345 });

    const page = await closeEndedGauPeriods(null, NOW);

    expect(page).toEqual({ processed: 1, nextCursor: null });
    expect(store.settlements).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({
      bucketId: bucket.id,
      kind: "period_close",
      seq: 0,
      quantityGau: 12_345,
      status: "paid",
    });
    expect(bucket.closedAt).toBeInstanceOf(Date);
    expect(uninvoicedGau(bucket)).toBe(0);
    expect(mocks.readOrgBillingSettings).toHaveBeenCalledWith(ORG, {
      system: true,
    });
    expect(mocks.ensureStripeCustomer).toHaveBeenCalledWith(ORG, {
      system: true,
    });
    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gau_period_close" }),
    );
  });

  it("prices the settlement at the terms in force at close, after a mid-month change", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue(
      settingsWith({ approvedForInvoiceBilling: true }),
    );
    mocks.readGauEntitlement.mockResolvedValue({
      ...FREE_ENTITLEMENT,
      terms: { ...FREE_ENTITLEMENT.terms, ratePerGauMicros: 4_000n },
    });
    endedAugust({ usedGau: 6_000 });

    await closeEndedGauPeriods(null, NOW);

    expect(store.settlements[0]).toMatchObject({ ratePerGauMicros: 4_000n });
  });

  it("closes an ended prepaid month with closed_at only, whatever it overdrew", async () => {
    const bucket = endedAugust({ usedGau: 9_000 });
    await closeEndedGauPeriods(null, NOW);
    expect(bucket.closedAt).toBeInstanceOf(Date);
    expect(bucket.overageInvoicedGau).toBe(0);
    expect(store.settlements).toHaveLength(0);
    expect(providerCalls()).toEqual([]);
  });

  it("closes an ended invoice-billed month with nothing uninvoiced with closed_at only", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue(
      settingsWith({ approvedForInvoiceBilling: true }),
    );
    const bucket = endedAugust({ usedGau: 4_000 });
    await closeEndedGauPeriods(null, NOW);
    expect(bucket.closedAt).toBeInstanceOf(Date);
    expect(store.settlements).toHaveLength(0);
  });

  it("leaves a month that has not ended untouched", async () => {
    const bucket = seedBucket({ usedGau: 9_000 });
    expect(await closeEndedGauPeriods(null, NOW)).toEqual({
      processed: 0,
      nextCursor: null,
    });
    expect(bucket.closedAt).toBeNull();
  });

  it("pages by bucket id", async () => {
    for (let i = 0; i < 101; i++) endedAugust({ usedGau: 0 });

    const first = await closeEndedGauPeriods(null, NOW);
    const second = await closeEndedGauPeriods(first.nextCursor, NOW);

    expect(first.processed).toBe(100);
    expect(first.nextCursor).not.toBeNull();
    expect(second).toEqual({ processed: 1, nextCursor: null });
    expect(store.buckets.every((b) => b.closedAt instanceof Date)).toBe(true);
  });

  it("logs a bucket it could not close and carries on with the page", async () => {
    endedAugust({ usedGau: 0 });
    endedAugust({ usedGau: 0 });
    mocks.readOrgBillingSettings.mockRejectedValueOnce(
      new Error("settings unavailable"),
    );
    const error = vi.spyOn(logger, "error");

    const page = await closeEndedGauPeriods(null, NOW);

    expect(page.processed).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "settings unavailable" }),
      expect.stringMatching(/period close failed/),
    );
    expect(store.buckets.map((b) => b.closedAt === null).sort()).toEqual([
      false,
      true,
    ]);
  });
});

describe("resumePendingGauSettlements", () => {
  inMotion();

  it("supersedes an auto top-up whose bucket a Checkout refilled: deletes its draft first, marks it failed, and calls nothing else", async () => {
    const bucket = seedBucket({ usedGau: 5_000, purchasedGau: 10_000 });
    const row = seedSettlement({
      bucketId: bucket.id,
      stripeInvoiceId: "in_draft",
    });
    let statusAtDelete: unknown;
    mocks.provider.deleteOrVoidDraftInvoice.mockImplementationOnce(async () => {
      statusAtDelete = settlement(row.id).status;
      return { outcome: "deleted" };
    });
    const warn = vi.spyOn(logger, "warn");

    await resumePendingGauSettlements(null, NOW);

    expect(mocks.provider.deleteOrVoidDraftInvoice).toHaveBeenCalledOnce();
    expect(mocks.provider.deleteOrVoidDraftInvoice).toHaveBeenCalledWith({
      settlementId: row.id,
      invoiceId: "in_draft",
    });
    expect(statusAtDelete).toBe("pending");
    expect(mocks.provider.finalizeAndPayGauInvoice).not.toHaveBeenCalled();
    expect(mocks.provider.createGauInvoice).not.toHaveBeenCalled();
    expect(settlement(row.id).status).toBe("failed");
    expect(bucket.purchasedGau).toBe(10_000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: row.id, reason: "superseded" }),
      expect.any(String),
    );
  });

  it("settles a superseded top-up paid and grants it when Stripe reports its invoice paid", async () => {
    const bucket = seedBucket({
      usedGau: 5_000,
      purchasedGau: 10_000,
      topupSeq: 1,
    });
    const row = seedSettlement({
      bucketId: bucket.id,
      stripeInvoiceId: "in_paid",
    });
    bucket.openTopupSettlementId = row.id;
    mocks.provider.deleteOrVoidDraftInvoice.mockResolvedValueOnce({
      outcome: "paid",
    });

    await resumePendingGauSettlements(null, NOW);

    expect(settlement(row.id).status).toBe("paid");
    expect(bucket).toMatchObject({
      purchasedGau: 15_000,
      openTopupSettlementId: null,
    });
  });

  it("marks a superseded top-up with no invoice id failed with no provider call", async () => {
    const bucket = seedBucket({ usedGau: 5_000, purchasedGau: 10_000 });
    const row = seedSettlement({ bucketId: bucket.id });

    await resumePendingGauSettlements(null, NOW);

    expect(settlement(row.id).status).toBe("failed");
    expect(providerCalls()).toEqual([]);
  });

  it("re-issues the create with the same settlement keys for a row that never got an invoice id, inside 24 hours", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    const row = seedSettlement({
      bucketId: bucket.id,
      createdAt: new Date(NOW.getTime() - 23 * HOUR),
    });

    await resumePendingGauSettlements(null, NOW);

    expect(mocks.provider.createGauInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: row.id }),
    );
    expect(mocks.ensureStripeCustomer).toHaveBeenCalledWith(ORG, {
      system: true,
    });
    expect(settlement(row.id)).toMatchObject({
      status: "paid",
      stripeInvoiceId: `in_${row.id}`,
    });
  });

  it("marks a row with no invoice id older than 24 hours failed, ends its episode and raises the stale alert, with no provider call", async () => {
    const bucket = seedBucket({ usedGau: 5_000, topupSeq: 1 });
    const row = seedSettlement({
      bucketId: bucket.id,
      createdAt: new Date(NOW.getTime() - 25 * HOUR),
    });
    bucket.openTopupSettlementId = row.id;
    const error = vi.spyOn(logger, "error");

    await resumePendingGauSettlements(null, NOW);

    expect(settlement(row.id).status).toBe("failed");
    expect(bucket.openTopupSettlementId).toBeNull();
    expect(providerCalls()).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementId: row.id,
        alert: "billing_gau_settlement_stale",
        reason: "idempotency_key_expired",
      }),
      expect.any(String),
    );
  });

  it("only finalizes a row that holds an invoice id", async () => {
    const bucket = seedBucket({ usedGau: 105_000 });
    const row = seedSettlement({
      bucketId: bucket.id,
      kind: "interim_invoice",
      quantityGau: 100_000,
      stripeInvoiceId: "in_interim",
      createdAt: new Date(NOW.getTime() - 30 * HOUR),
    });

    await resumePendingGauSettlements(null, NOW);

    expect(mocks.provider.createGauInvoice).not.toHaveBeenCalled();
    expect(mocks.provider.deleteOrVoidDraftInvoice).not.toHaveBeenCalled();
    expect(mocks.provider.finalizeAndPayGauInvoice).toHaveBeenCalledWith({
      settlementId: row.id,
      invoiceId: "in_interim",
    });
    expect(settlement(row.id).status).toBe("paid");
  });

  it("leaves a row younger than an hour and every settled row alone", async () => {
    const bucket = seedBucket({ usedGau: 5_000 });
    seedSettlement({
      bucketId: bucket.id,
      createdAt: new Date(NOW.getTime() - HOUR / 2),
    });
    for (const status of ["open", "paid", "failed"]) {
      seedSettlement({ bucketId: bucket.id, status });
    }
    const before = structuredClone(store.settlements);

    expect(await resumePendingGauSettlements(null, NOW)).toEqual({
      processed: 0,
      nextCursor: null,
    });
    expect(store.settlements).toEqual(before);
    expect(providerCalls()).toEqual([]);
  });

  it("logs a row it could not resume and carries on with the page", async () => {
    const bucket = seedBucket({ usedGau: 5_000, purchasedGau: 10_000 });
    const rows = [
      seedSettlement({ bucketId: bucket.id, stripeInvoiceId: "in_a" }),
      seedSettlement({ bucketId: bucket.id, stripeInvoiceId: "in_b" }),
    ];
    mocks.provider.deleteOrVoidDraftInvoice.mockRejectedValueOnce(
      new Error("timeout"),
    );
    const error = vi.spyOn(logger, "error");

    await resumePendingGauSettlements(null, NOW);

    expect(rows.map((r) => settlement(r.id).status).sort()).toEqual([
      "failed",
      "pending",
    ]);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "timeout" }),
      expect.stringMatching(/resume failed/),
    );
  });
});

describe("the close job's steps together", () => {
  inMotion();

  function seedEverything() {
    mocks.readOrgBillingSettings.mockResolvedValue(
      settingsWith({ approvedForInvoiceBilling: true }),
    );
    seedBucket({
      periodStart: AUGUST.start,
      periodEnd: AUGUST.end,
      usedGau: 8_000,
    });
    const september = seedBucket({ usedGau: 5_000, purchasedGau: 10_000 });
    seedSettlement({ bucketId: september.id, stripeInvoiceId: "in_draft" });
    seedSettlement({ bucketId: september.id, kind: "interim_invoice" });
  }

  async function runJob() {
    await closeEndedGauPeriods(null, NOW);
    await resumePendingGauSettlements(null, NOW);
  }

  it("changes nothing when run a second time", async () => {
    seedEverything();
    await runJob();
    const buckets = structuredClone(store.buckets);
    const settlements = structuredClone(store.settlements);
    const calls = providerCalls().length;

    await runJob();

    expect(store.buckets).toEqual(buckets);
    expect(store.settlements).toEqual(settlements);
    expect(providerCalls()).toHaveLength(calls);
  });

  it("makes every write with no active tenant scope", async () => {
    seedEverything();
    await runJob();
    // Every row moved, so every write ran, and none of it through the real
    // withTenantDb, which refuses outside a scope.
    expect(store.settlements.map((r) => r.status)).not.toContain("pending");
    expect(
      store.buckets.every(
        (b) => b.closedAt !== null || (b.periodEnd as Date) > NOW,
      ),
    ).toBe(true);
    await expect(
      mocks.realWithTenantDb!(async () => undefined),
    ).rejects.toThrow("No active tenant scope");
  });
});
