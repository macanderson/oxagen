/**
 * Unit tests for gau-bucket.ts — periodFor, ensureCurrentBucket, readBucket
 * and the assertGauAvailable gate (ADR-055 §4, §6; ARCHITECTURE.md §3.9).
 *
 * The bucket writer and reader run against the in-memory executor in
 * test-utils/gau-fake-tx.ts, which mirrors the upsert-add statement and
 * records every statement. The gate's other reads — terms, settings, dunning,
 * the default card — are module doubles, each `satisfies Pick<…>` so a rename
 * of the real export fails here at typecheck.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeFakeGauStore,
  makeFakeGauTx,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readOrgBillingSettings: vi.fn(),
  getOrgBillingSettings: vi.fn(),
  resolveGauEntitlement: vi.fn(),
  assertOrgCanConsume: vi.fn(),
  readDefaultPaymentMethod: vi.fn(),
  billingProvider: vi.fn(),
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock(
  "./billing-settings",
  () =>
    ({
      readOrgBillingSettings: mocks.readOrgBillingSettings,
      getOrgBillingSettings: mocks.getOrgBillingSettings,
    }) satisfies Pick<
      typeof import("./billing-settings"),
      "readOrgBillingSettings" | "getOrgBillingSettings"
    >,
);

vi.mock(
  "./contract-terms",
  () =>
    ({ resolveGauEntitlement: mocks.resolveGauEntitlement }) satisfies Pick<
      typeof import("./contract-terms"),
      "resolveGauEntitlement"
    >,
);

vi.mock("./dunning", async (importOriginal) => {
  const real = await importOriginal<typeof import("./dunning")>();
  return {
    ...real,
    assertOrgCanConsume: mocks.assertOrgCanConsume,
  } satisfies Pick<
    typeof import("./dunning"),
    "assertOrgCanConsume" | "BillingSuspendedError"
  >;
});

vi.mock(
  "./payment-methods",
  () =>
    ({
      readDefaultPaymentMethod: mocks.readDefaultPaymentMethod,
    }) satisfies Pick<
      typeof import("./payment-methods"),
      "readDefaultPaymentMethod"
    >,
);

vi.mock(
  "./client",
  () =>
    ({ billingProvider: mocks.billingProvider }) satisfies Pick<
      typeof import("./client"),
      "billingProvider"
    >,
);

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  addMonths,
  periodFor,
  ensureCurrentBucket,
  readBucket,
  remainingGau,
  carriedFrom,
  uninvoicedGau,
  assertGauAvailable,
  GauExhaustedError,
} = await import("./gau-bucket");
const { BillingSuspendedError } = await import("./dunning");
const { withTenantDb } = await import("@oxagen/database");

// ── fixtures ──────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-00000000a0a1";
const NOW = new Date("2026-09-14T12:00:00.000Z");

const FREE_TERMS = {
  source: "published_tier" as const,
  tier: "free" as const,
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};
const BUILD_TERMS = {
  ...FREE_TERMS,
  tier: "build" as const,
  includedGauPerMonth: 50_000,
};
const SCALE_TERMS = {
  ...FREE_TERMS,
  tier: "scale" as const,
  includedGauPerMonth: 300_000,
};

const MONTH_SUB = {
  billingInterval: "month" as const,
  currentPeriodStart: new Date("2026-09-03T08:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-03T08:00:00.000Z"),
};
const YEAR_SUB_JAN31 = {
  billingInterval: "year" as const,
  currentPeriodStart: new Date("2026-01-31T00:00:00.000Z"),
  currentPeriodEnd: new Date("2027-01-31T00:00:00.000Z"),
};

const CAL_SEP = {
  start: new Date("2026-09-01T00:00:00.000Z"),
  end: new Date("2026-10-01T00:00:00.000Z"),
};
const CAL_AUG = {
  start: new Date("2026-08-01T00:00:00.000Z"),
  end: new Date("2026-09-01T00:00:00.000Z"),
};

let store: FakeGauStore;

function seedBucket(overrides: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    periodStart: CAL_SEP.start,
    periodEnd: CAL_SEP.end,
    includedGau: 5_000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 0,
    overageInvoicedGau: 0,
    interimSeq: 0,
    topupSeq: 0,
    openTopupSettlementId: null,
    closedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  store.buckets.push(row);
  return row;
}

const writes = () =>
  store.log.filter((s) => s.op !== "select").map((s) => `${s.op}:${s.table}`);

beforeEach(() => {
  vi.clearAllMocks();
  store = makeFakeGauStore();
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeFakeGauTx(store))),
  );
  mocks.assertOrgCanConsume.mockResolvedValue(undefined);
  mocks.readOrgBillingSettings.mockResolvedValue({
    orgId: ORG,
    stripeCustomerId: null,
    approvedForInvoiceBilling: false,
    invoiceGauMax: 100_000,
    autoTopupEnabled: true,
    autoTopupBlocks: 1,
    dunningState: "active",
  });
  mocks.resolveGauEntitlement.mockResolvedValue({
    terms: BUILD_TERMS,
    subscription: null,
  });
  mocks.readDefaultPaymentMethod.mockResolvedValue(null);
});

// ── addMonths ─────────────────────────────────────────────────────────────────

describe("addMonths", () => {
  it("clamps the anchor's day to the last day of a shorter month, from the anchor each time", () => {
    const jan31 = new Date("2026-01-31T00:00:00.000Z");
    expect(addMonths(jan31, 1)).toEqual(new Date("2026-02-28T00:00:00.000Z"));
    expect(addMonths(jan31, 2)).toEqual(new Date("2026-03-31T00:00:00.000Z"));
    expect(addMonths(jan31, 3)).toEqual(new Date("2026-04-30T00:00:00.000Z"));
    expect(addMonths(jan31, 12)).toEqual(new Date("2027-01-31T00:00:00.000Z"));
  });

  it("keeps the anchor's time of day and crosses a year boundary", () => {
    const nov15 = new Date("2026-11-15T09:30:00.000Z");
    expect(addMonths(nov15, 2)).toEqual(new Date("2027-01-15T09:30:00.000Z"));
    expect(addMonths(nov15, -11)).toEqual(new Date("2025-12-15T09:30:00.000Z"));
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(addMonths(new Date("2028-01-31T00:00:00.000Z"), 1)).toEqual(
      new Date("2028-02-29T00:00:00.000Z"),
    );
  });
});

// ── periodFor ─────────────────────────────────────────────────────────────────

describe("periodFor", () => {
  it("a month subscription is its own current_period_start/end", () => {
    expect(periodFor(MONTH_SUB, NOW)).toEqual({
      start: MONTH_SUB.currentPeriodStart,
      end: MONTH_SUB.currentPeriodEnd,
    });
  });

  it.each([
    ["2026-02-10", "2026-01-31", "2026-02-28"],
    ["2026-02-28", "2026-02-28", "2026-03-31"],
    ["2026-03-05", "2026-02-28", "2026-03-31"],
    ["2026-04-15", "2026-03-31", "2026-04-30"],
    ["2026-01-31", "2026-01-31", "2026-02-28"],
    ["2026-12-31", "2026-12-31", "2027-01-31"],
  ])(
    "a year subscription anchored on Jan 31 slices %s into [%s, %s)",
    (now, start, end) => {
      expect(
        periodFor(YEAR_SUB_JAN31, new Date(`${now}T12:00:00.000Z`)),
      ).toEqual({
        start: new Date(`${start}T00:00:00.000Z`),
        end: new Date(`${end}T00:00:00.000Z`),
      });
    },
  );

  it("a year subscription whose renewal webhook has not landed keeps slicing on its anniversary day", () => {
    // Fourteen months after the anchor: the renewed cycle's second month.
    expect(
      periodFor(YEAR_SUB_JAN31, new Date("2027-03-10T00:00:00.000Z")),
    ).toEqual({
      start: new Date("2027-02-28T00:00:00.000Z"),
      end: new Date("2027-03-31T00:00:00.000Z"),
    });
  });

  it("no subscription is the UTC calendar month containing now", () => {
    expect(periodFor(null, NOW)).toEqual(CAL_SEP);
    expect(periodFor(null, new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      start: new Date("2026-12-01T00:00:00.000Z"),
      end: new Date("2027-01-01T00:00:00.000Z"),
    });
  });
});

// ── the balance arithmetic ────────────────────────────────────────────────────

describe("remainingGau and carriedFrom", () => {
  it("remaining is included + purchased + carried − used and goes negative", () => {
    expect(
      remainingGau({
        includedGau: 5,
        purchasedGau: 2,
        carriedGau: 1,
        usedGau: 10,
      }),
    ).toBe(-2);
  });

  it("carries bought units that survived the month, never included ones", () => {
    // 5,000 included, 5,000 bought, 3,000 used: 7,000 remain, but only the
    // 5,000 bought ones carry.
    expect(
      carriedFrom({
        includedGau: 5_000,
        purchasedGau: 5_000,
        carriedGau: 0,
        usedGau: 3_000,
      }),
    ).toBe(5_000);
    // Bought and carried units both count as bought for the next carry.
    expect(
      carriedFrom({
        includedGau: 100,
        purchasedGau: 50,
        carriedGau: 10,
        usedGau: 120,
      }),
    ).toBe(40);
  });

  it("carries nothing from an overdrawn month or from no month", () => {
    expect(
      carriedFrom({
        includedGau: 100,
        purchasedGau: 50,
        carriedGau: 0,
        usedGau: 200,
      }),
    ).toBe(0);
    expect(carriedFrom(null)).toBe(0);
  });
});

// ── ensureCurrentBucket ───────────────────────────────────────────────────────

describe("ensureCurrentBucket", () => {
  it("lazily creates the month's bucket with included_gau from the terms and debits it", async () => {
    const tx = makeFakeGauTx(store);
    const row = await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 3,
      purchasedDelta: 0,
    });
    expect(row).toMatchObject({
      orgId: ORG,
      periodStart: CAL_SEP.start,
      periodEnd: CAL_SEP.end,
      includedGau: 50_000,
      purchasedGau: 0,
      carriedGau: 0,
      usedGau: 3,
    });
    expect(remainingGau(row)).toBe(49_997);
  });

  it("a yearly and a monthly subscription on the same terms get the same included_gau", async () => {
    const tx = makeFakeGauTx(store);
    const monthly = await ensureCurrentBucket(tx, ORG, {
      period: periodFor(MONTH_SUB, NOW),
      terms: SCALE_TERMS,
      usedDelta: 1,
      purchasedDelta: 0,
    });
    const yearly = await ensureCurrentBucket(
      tx,
      "00000000-0000-0000-0000-00000000a0a2",
      {
        period: periodFor(YEAR_SUB_JAN31, NOW),
        terms: SCALE_TERMS,
        usedDelta: 1,
        purchasedDelta: 0,
      },
    );
    expect(monthly.includedGau).toBe(300_000);
    expect(yearly.includedGau).toBe(300_000);
  });

  it("the second call lands in the conflict branch and adds to used_gau", async () => {
    const tx = makeFakeGauTx(store);
    const args = {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 2,
      purchasedDelta: 0,
    };
    await ensureCurrentBucket(tx, ORG, args);
    const row = await ensureCurrentBucket(tx, ORG, args);
    expect(row.usedGau).toBe(4);
    expect(store.buckets).toHaveLength(1);
  });

  it("a grant adds to purchased_gau with usedDelta 0 through the same writer", async () => {
    const tx = makeFakeGauTx(store);
    await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 1,
      purchasedDelta: 0,
    });
    const row = await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 0,
      purchasedDelta: 5_000,
    });
    expect(row.purchasedGau).toBe(5_000);
    expect(row.usedGau).toBe(1);
  });

  it("on rollover the new bucket carries min(prev.purchased + prev.carried, max(0, prev.remaining))", async () => {
    seedBucket({
      ...CAL_AUG,
      periodStart: CAL_AUG.start,
      periodEnd: CAL_AUG.end,
      includedGau: 50_000,
      purchasedGau: 10_000,
      carriedGau: 2_000,
      usedGau: 55_000,
    });
    const tx = makeFakeGauTx(store);
    const row = await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 1,
      purchasedDelta: 0,
    });
    // prev remaining = 50,000 + 10,000 + 2,000 − 55,000 = 7,000; bought = 12,000.
    expect(row.carriedGau).toBe(7_000);
    expect(row.includedGau).toBe(50_000);
  });

  it("carries from the LATEST previous bucket, not the first", async () => {
    seedBucket({
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-01T00:00:00.000Z"),
      includedGau: 50_000,
      purchasedGau: 40_000,
      carriedGau: 0,
      usedGau: 0,
    });
    seedBucket({
      periodStart: CAL_AUG.start,
      periodEnd: CAL_AUG.end,
      includedGau: 50_000,
      purchasedGau: 1_000,
      carriedGau: 40_000,
      usedGau: 60_000,
    });
    const tx = makeFakeGauTx(store);
    const row = await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 1,
      purchasedDelta: 0,
    });
    // August: remaining 31,000, bought 41,000 → 31,000.
    expect(row.carriedGau).toBe(31_000);
  });

  it("20 concurrent increments on one bucket sum exactly", async () => {
    const tx = makeFakeGauTx(store);
    const rows = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        ensureCurrentBucket(tx, ORG, {
          period: CAL_SEP,
          terms: BUILD_TERMS,
          usedDelta: i + 1,
          purchasedDelta: 0,
        }),
      ),
    );
    expect(store.buckets).toHaveLength(1);
    expect(store.buckets[0]!.usedGau).toBe(210);
    // Every caller read a post-write total; the largest is the final one.
    expect(Math.max(...rows.map((r) => r.usedGau))).toBe(210);
  });

  it("remaining goes negative when the gate admitted concurrent actions and is never clamped", async () => {
    const tx = makeFakeGauTx(store);
    const args = {
      period: CAL_SEP,
      terms: FREE_TERMS,
      usedDelta: 3_000,
      purchasedDelta: 0,
    };
    const rows = await Promise.all([
      ensureCurrentBucket(tx, ORG, args),
      ensureCurrentBucket(tx, ORG, args),
    ]);
    const last = rows.find((r) => r.usedGau === 6_000)!;
    expect(remainingGau(last)).toBe(-1_000);
    expect(store.buckets[0]!.usedGau).toBe(6_000);
  });

  it("runs on the executor it is passed and opens no transaction of its own", async () => {
    const tx = makeFakeGauTx(store);
    await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 1,
      purchasedDelta: 0,
    });
    expect(withTenantDb).not.toHaveBeenCalled();
    expect(writes()).toEqual(["upsert:buckets"]);
    expect(store.log.find((s) => s.op === "upsert")?.values).toMatchObject({
      orgId: ORG,
      usedGau: 1,
      purchasedGau: 0,
      includedGau: 50_000,
    });
  });

  it("floors and clamps a fractional or negative delta", async () => {
    const tx = makeFakeGauTx(store);
    const row = await ensureCurrentBucket(tx, ORG, {
      period: CAL_SEP,
      terms: BUILD_TERMS,
      usedDelta: 2.9,
      purchasedDelta: -4,
    });
    expect(row.usedGau).toBe(2);
    expect(row.purchasedGau).toBe(0);
  });
});

// ── readBucket ────────────────────────────────────────────────────────────────

describe("readBucket", () => {
  it("returns the stored row with its remaining", async () => {
    const seeded = seedBucket({
      includedGau: 50_000,
      purchasedGau: 5_000,
      usedGau: 60_000,
    });
    const view = await readBucket(ORG, { period: CAL_SEP, terms: BUILD_TERMS });
    expect(view.id).toBe(seeded.id);
    expect(view.remainingGau).toBe(-5_000);
    expect(writes()).toEqual([]);
  });

  it("answers with a virtual bucket carrying the previous month's bought units, and never inserts", async () => {
    seedBucket({
      periodStart: CAL_AUG.start,
      periodEnd: CAL_AUG.end,
      includedGau: 5_000,
      purchasedGau: 5_000,
      carriedGau: 0,
      usedGau: 5_000,
    });
    const view = await readBucket(ORG, { period: CAL_SEP, terms: FREE_TERMS });
    expect(view).toMatchObject({
      id: null,
      periodStart: CAL_SEP.start,
      periodEnd: CAL_SEP.end,
      includedGau: 5_000,
      purchasedGau: 0,
      carriedGau: 5_000,
      usedGau: 0,
      openTopupSettlementId: null,
      remainingGau: 10_000,
    });
    expect(writes()).toEqual([]);
    expect(store.buckets).toHaveLength(1);
    expect(withTenantDb).toHaveBeenCalledTimes(1);
  });

  it("a virtual bucket with no previous month carries nothing", async () => {
    const view = await readBucket(ORG, { period: CAL_SEP, terms: BUILD_TERMS });
    expect(view.carriedGau).toBe(0);
    expect(view.remainingGau).toBe(50_000);
  });
});

// ── assertGauAvailable ────────────────────────────────────────────────────────

describe("assertGauAvailable", () => {
  const exhausted = (reason: string | null) => (e: unknown) =>
    e instanceof GauExhaustedError &&
    e.code === "gau_exhausted" &&
    e.reason === reason;

  it("refuses a suspended org in prepaid mode before reading anything else", async () => {
    mocks.assertOrgCanConsume.mockRejectedValue(
      new BillingSuspendedError(null),
    );
    await expect(assertGauAvailable(ORG, NOW)).rejects.toBeInstanceOf(
      BillingSuspendedError,
    );
    expect(mocks.readOrgBillingSettings).not.toHaveBeenCalled();
  });

  it("refuses a suspended org in invoice billing too", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      approvedForInvoiceBilling: true,
    });
    mocks.assertOrgCanConsume.mockRejectedValue(
      new BillingSuspendedError(null),
    );
    await expect(assertGauAvailable(ORG, NOW)).rejects.toBeInstanceOf(
      BillingSuspendedError,
    );
  });

  it("never refuses an invoice-billed org for lack of GAUs", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      approvedForInvoiceBilling: true,
    });
    seedBucket({ includedGau: 50_000, usedGau: 400_000 });
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();
    expect(mocks.resolveGauEntitlement).not.toHaveBeenCalled();
  });

  it("admits a prepaid org with remaining > 0", async () => {
    seedBucket({ includedGau: 50_000, usedGau: 49_999 });
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();
  });

  it("refuses a prepaid org at remaining = 0 with gau_exhausted and no reason", async () => {
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    await expect(assertGauAvailable(ORG, NOW)).rejects.toSatisfy(
      exhausted(null),
    );
  });

  it("refuses an overdrawn prepaid org and reports the stored negative figure", async () => {
    seedBucket({ includedGau: 50_000, usedGau: 50_007 });
    const err = await assertGauAvailable(ORG, NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GauExhaustedError);
    expect((err as InstanceType<typeof GauExhaustedError>).remainingGau).toBe(
      -7,
    );
    expect((err as InstanceType<typeof GauExhaustedError>).periodEnd).toEqual(
      CAL_SEP.end,
    );
  });

  it("Free with no default payment method at remaining ≤ 0 → reason free_no_payment_method", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(null);
    seedBucket({ includedGau: 5_000, usedGau: 5_000 });
    await expect(assertGauAvailable(ORG, NOW)).rejects.toSatisfy(
      exhausted("free_no_payment_method"),
    );
    expect(mocks.readDefaultPaymentMethod).toHaveBeenCalledWith(ORG);
  });

  it("Free with a saved default card at remaining ≤ 0 → gau_exhausted with no reason (the prepaid path)", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue({
      stripePaymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
    });
    seedBucket({ includedGau: 5_000, usedGau: 5_000 });
    await expect(assertGauAvailable(ORG, NOW)).rejects.toSatisfy(
      exhausted(null),
    );
  });

  it("Free with a card and remaining > 0 → admitted", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue({
      stripePaymentMethodId: "pm_1",
      brand: "visa",
      last4: "4242",
    });
    seedBucket({ includedGau: 5_000, usedGau: 4_000 });
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();
    expect(mocks.readDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it("the reason comes from the resolved terms: a negotiated agreement on a free-tier org is not the published Free tier", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: {
        ...FREE_TERMS,
        source: "negotiated",
        agreementRef: "MSA-1",
        effectiveFrom: NOW,
        effectiveTo: null,
      },
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(null);
    seedBucket({ includedGau: 5_000, usedGau: 5_000 });
    await expect(assertGauAvailable(ORG, NOW)).rejects.toSatisfy(
      exhausted(null),
    );
  });

  it("a Build org with no card at remaining ≤ 0 carries no reason", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: BUILD_TERMS,
      subscription: null,
    });
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    await expect(assertGauAvailable(ORG, NOW)).rejects.toSatisfy(
      exhausted(null),
    );
  });

  it("with no bucket row it reads the virtual bucket with the previous month's carry and admits on it", async () => {
    seedBucket({
      periodStart: CAL_AUG.start,
      periodEnd: CAL_AUG.end,
      includedGau: 50_000,
      purchasedGau: 5_000,
      carriedGau: 0,
      usedGau: 52_000,
    });
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: { ...BUILD_TERMS, includedGauPerMonth: 0 },
      subscription: null,
    });
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();
    expect(store.buckets).toHaveLength(1);
  });

  it("uses the subscription's period, not the calendar month", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: SCALE_TERMS,
      subscription: MONTH_SUB,
    });
    // A row for the calendar month is not this org's bucket; its period is
    // the subscription's, and no row exists for it yet.
    seedBucket({ includedGau: 300_000, usedGau: 300_000 });
    await expect(assertGauAvailable(ORG, NOW)).resolves.toBeUndefined();
  });

  it("never writes to gau_buckets or org_billing_settings and never calls the provider", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    await assertGauAvailable(ORG, NOW).catch(() => undefined);
    expect(writes()).toEqual([]);
    expect(store.buckets).toHaveLength(0);
    expect(mocks.readOrgBillingSettings).toHaveBeenCalledWith(ORG);
    expect(mocks.getOrgBillingSettings).not.toHaveBeenCalled();
    expect(mocks.billingProvider).not.toHaveBeenCalled();
  });

  it("GauExhaustedError carries the code the API and the app classify by", () => {
    const err = new GauExhaustedError({
      reason: null,
      remainingGau: 0,
      periodEnd: CAL_SEP.end,
    });
    expect(err.code).toBe("gau_exhausted");
    expect(err.name).toBe("GauExhaustedError");
    const withReason = new GauExhaustedError({
      reason: "free_no_payment_method",
      remainingGau: 0,
      periodEnd: CAL_SEP.end,
    });
    expect(withReason.message).toMatch(/add a payment method/i);
  });
});

// ── uninvoicedGau ─────────────────────────────────────────────────────────────

describe("uninvoicedGau", () => {
  const counts = (over: Partial<Parameters<typeof uninvoicedGau>[0]>) => ({
    includedGau: 100,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 0,
    overageInvoicedGau: 0,
    ...over,
  });

  it("is zero while consumption is inside the allowance", () => {
    expect(uninvoicedGau(counts({ usedGau: 40 }))).toBe(0);
  });

  it("subtracts what interim and period-close settlements already claimed", () => {
    expect(
      uninvoicedGau(counts({ usedGau: 350, overageInvoicedGau: 200 })),
    ).toBe(50);
  });

  it("counts purchased and carried units against the overage", () => {
    expect(
      uninvoicedGau(counts({ purchasedGau: 30, carriedGau: 20, usedGau: 350 })),
    ).toBe(200);
  });

  it("floors at zero when a settlement claimed more than the current overage", () => {
    // Possible after a grant lands between the claim and this read: purchased
    // units move the overage down while overage_invoiced_gau stays put.
    expect(
      uninvoicedGau(
        counts({ purchasedGau: 300, usedGau: 350, overageInvoicedGau: 200 }),
      ),
    ).toBe(0);
  });
});
