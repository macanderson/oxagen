/**
 * Unit tests for gau-settlements.ts — claimAutoTopup (ADR-055 §6,
 * ARCHITECTURE.md §3.9 item 8c) and grantGauPurchaseForCheckout (item 11).
 *
 * Runs against the in-memory executor in test-utils/gau-fake-tx.ts, which
 * mirrors the re-checked claim UPDATE, the session-keyed settlement insert
 * and the payment-method mirror upsert, and records every statement. The
 * terms and the settings are module doubles, each `satisfies Pick<…>` so a
 * rename of the real export fails here at typecheck; the provider is a fake
 * with the four methods the grant calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeGauStore,
  makeFakeGauTx,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";
import type { BillingCheckoutSession, BillingProvider } from "./provider";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  realWithTenantDb: null as null | ((fn: (tx: unknown) => unknown) => unknown),
  readGauEntitlement: vi.fn(),
  resolveGauEntitlement: vi.fn(),
  readOrgBillingSettings: vi.fn(),
  assertOrgCanConsume: vi.fn(),
  provider: {
    getCheckoutPaymentMethod: vi.fn(),
    getDefaultPaymentMethodId: vi.fn(),
    setDefaultPaymentMethod: vi.fn(),
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
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
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
  "./client",
  () =>
    ({
      billingProvider: () => mocks.provider as unknown as BillingProvider,
    }) satisfies Pick<typeof import("./client"), "billingProvider">,
);

const { claimAutoTopup, grantGauPurchaseForCheckout } = await import(
  "./gau-settlements"
);
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
    openTopupSettlementId: null,
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
});
