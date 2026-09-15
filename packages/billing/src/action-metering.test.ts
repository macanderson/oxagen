/**
 * Unit tests for action-metering.ts — the governed-action meter (ADR-052,
 * ADR-055).
 *
 * Each test is anchored to a specific invariant claimed in the source file's
 * JSDoc, so a change that breaks the claim also breaks the test that proves
 * it. The `withTenantDb` seam hands out one composite executor: the in-memory
 * GAU store from test-utils/gau-fake-tx.ts for `billing.gau_buckets` and
 * `billing.gau_settlements`, plus an upsert-add table for the annual counter
 * `get_action_usage` still reads. The recorder's other reads — terms,
 * settings, the default card — are module doubles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { schema } from "@oxagen/database";
import type { Cond } from "./test-utils/gau-conditions";
import {
  fakeGauExecutor,
  makeFakeGauStore,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";

// ---------------------------------------------------------------------------
// The governed_action_counters fake — an in-memory upsert-add table, keyed by
// (orgId, periodStart). Mirrors the ON CONFLICT DO UPDATE ... RETURNING
// semantics of incrementActionCounter's real statement.
// ---------------------------------------------------------------------------

interface CounterRow {
  actionsUsed: bigint;
  actionsCharged: bigint;
}

const state: { counters: Map<string, CounterRow> } = { counters: new Map() };

function counterKey(orgId: string, periodStart: Date): string {
  return `${orgId}::${periodStart.toISOString()}`;
}

function eqValue(cond: Cond, col: unknown): unknown {
  if (cond.op !== "and") throw new Error("expected and()");
  const hit = cond.conds.find((c) => c.op === "eq" && c.col === col);
  if (!hit || hit.op !== "eq") throw new Error("expected eq()");
  return hit.val;
}

function makeCountersTx() {
  return {
    insert: () => ({
      values: (v: {
        orgId: string;
        periodStart: Date;
        actionsUsed: bigint;
        actionsCharged: bigint;
      }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const key = counterKey(v.orgId, v.periodStart);
            const existing = state.counters.get(key) ?? {
              actionsUsed: 0n,
              actionsCharged: 0n,
            };
            const next: CounterRow = {
              actionsUsed: existing.actionsUsed + v.actionsUsed,
              actionsCharged: existing.actionsCharged + v.actionsCharged,
            };
            state.counters.set(key, next);
            return [{ actionsUsed: next.actionsUsed }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: (cond: Cond) => ({
          limit: async () => {
            const orgId = eqValue(
              cond,
              schema.governedActionCounters.orgId,
            ) as string;
            const periodStart = eqValue(
              cond,
              schema.governedActionCounters.periodStart,
            ) as Date;
            const row = state.counters.get(counterKey(orgId, periodStart));
            return row
              ? [
                  {
                    actionsUsed: row.actionsUsed,
                    actionsCharged: row.actionsCharged,
                  },
                ]
              : [];
          },
        }),
      }),
    }),
  };
}

/** One executor: the counter table and the GAU store, routed by table. */
function makeCompositeTx(store: FakeGauStore) {
  const gau = fakeGauExecutor(store);
  const counters = makeCountersTx();
  return {
    marker: "composite-tx",
    insert: (table: unknown) =>
      table === schema.governedActionCounters
        ? counters.insert()
        : gau.insert(table),
    select: () => ({
      from: (table: unknown) =>
        table === schema.governedActionCounters
          ? counters.select().from()
          : gau.select().from(table),
    }),
    update: gau.update,
  };
}

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  resolveGauEntitlement: vi.fn(),
  readOrgBillingSettings: vi.fn(),
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
  "./contract-terms",
  () =>
    ({ resolveGauEntitlement: mocks.resolveGauEntitlement }) satisfies Pick<
      typeof import("./contract-terms"),
      "resolveGauEntitlement"
    >,
);

vi.mock(
  "./billing-settings",
  () =>
    ({ readOrgBillingSettings: mocks.readOrgBillingSettings }) satisfies Pick<
      typeof import("./billing-settings"),
      "readOrgBillingSettings"
    >,
);

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
  ACTION_RATE_BANDS,
  resolveActionBand,
  TIER_ACTION_ALLOWANCES,
  ENTERPRISE_FALLBACK_ALLOWANCE,
  resolveActionAllowance,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  creditsForActions,
  priceAnnualVolumeCredits,
  actionPeriodStart,
  incrementActionCounter,
  readActionCounter,
  recordGovernedAction,
} = await import("./action-metering");
const { logger } = await import("./logger");

const FIRST_1M = ACTION_RATE_BANDS.find((b) => b.id === "first-1m")!;
const M1_5M = ACTION_RATE_BANDS.find((b) => b.id === "1m-5m")!;
const M5_25M = ACTION_RATE_BANDS.find((b) => b.id === "5m-25m")!;
const COMMITTED_25M = ACTION_RATE_BANDS.find(
  (b) => b.id === "committed-25m-plus",
)!;

let store: FakeGauStore;
let txs: ReturnType<typeof makeCompositeTx>[];

beforeEach(() => {
  vi.clearAllMocks();
  state.counters = new Map();
  store = makeFakeGauStore();
  txs = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    const tx = makeCompositeTx(store);
    txs.push(tx);
    return Promise.resolve(fn(tx));
  });
});

// ---------------------------------------------------------------------------
// resolveActionBand — the bands tile [0, ∞) with no gap or overlap.
// ---------------------------------------------------------------------------

describe("resolveActionBand", () => {
  it.each([
    [0, "first-1m"],
    [999_999, "first-1m"],
    [1_000_000, "1m-5m"],
    [4_999_999, "1m-5m"],
    [5_000_000, "5m-25m"],
    [24_999_999, "5m-25m"],
    [25_000_000, "committed-25m-plus"],
    [100_000_000, "committed-25m-plus"],
  ])("resolves %d actions to band %s", (total, bandId) => {
    expect(resolveActionBand(total).id).toBe(bandId);
  });

  it("resolves a negative total to the first band rather than throwing", () => {
    expect(resolveActionBand(-500).id).toBe("first-1m");
  });

  it("resolves NaN to the first band rather than throwing", () => {
    expect(resolveActionBand(Number.NaN).id).toBe("first-1m");
  });

  it("resolves Infinity to the first band rather than throwing (billing at zero is the worse error)", () => {
    expect(resolveActionBand(Number.POSITIVE_INFINITY).id).toBe("first-1m");
    expect(resolveActionBand(Number.NEGATIVE_INFINITY).id).toBe("first-1m");
  });
});

// ---------------------------------------------------------------------------
// resolveActionAllowance — plan figure wins, then tier default, then the
// enterprise fallback (NOT unlimited).
// ---------------------------------------------------------------------------

describe("resolveActionAllowance", () => {
  it("uses the stored plan figure when present, over the tier default", () => {
    expect(resolveActionAllowance("build", 500)).toBe(500);
  });

  it("floors a fractional stored plan figure", () => {
    expect(resolveActionAllowance("build", 500.7)).toBe(500);
  });

  it("falls back to the tier default when planIncluded is undefined", () => {
    expect(resolveActionAllowance("build", undefined)).toBe(
      TIER_ACTION_ALLOWANCES.build,
    );
  });

  it("falls back to the tier default when planIncluded is null", () => {
    expect(resolveActionAllowance("free", null)).toBe(
      TIER_ACTION_ALLOWANCES.free,
    );
  });

  it("falls back to the tier default for a negative stored figure", () => {
    expect(resolveActionAllowance("build", -5)).toBe(
      TIER_ACTION_ALLOWANCES.build,
    );
  });

  it("falls back to the tier default for a non-finite stored figure", () => {
    expect(resolveActionAllowance("scale", Number.NaN)).toBe(
      TIER_ACTION_ALLOWANCES.scale,
    );
  });

  // ── the most important test in the file ──────────────────────────────────
  it("falls back to ENTERPRISE_FALLBACK_ALLOWANCE for enterprise with no stored figure, and does NOT mean unlimited", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const allowance = resolveActionAllowance("enterprise", undefined);
    expect(allowance).toBe(ENTERPRISE_FALLBACK_ALLOWANCE);
    expect(allowance).not.toBe(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(allowance)).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      alert: "billing_enterprise_allowance_missing",
    });
    warnSpy.mockRestore();
  });

  it("falls back to ENTERPRISE_FALLBACK_ALLOWANCE for enterprise with a null stored figure, and logs a warning", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(resolveActionAllowance("enterprise", null)).toBe(
      ENTERPRISE_FALLBACK_ALLOWANCE,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("uses the stored figure for enterprise when present, and does NOT warn", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    expect(resolveActionAllowance("enterprise", 5_000_000)).toBe(5_000_000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// creditsForActions — the display figure, rounded up.
// ---------------------------------------------------------------------------

describe("creditsForActions", () => {
  it("rounds a single action at the $2 band UP to a whole credit for display", () => {
    expect(creditsForActions(1, COMMITTED_25M)).toBe(1n);
  });

  it("prices 50 actions at the $5 band as exactly 25 credits", () => {
    expect(creditsForActions(50, FIRST_1M)).toBe(25n);
  });

  it("returns 0n for a non-positive or non-finite count", () => {
    expect(creditsForActions(0, FIRST_1M)).toBe(0n);
    expect(creditsForActions(-5, FIRST_1M)).toBe(0n);
    expect(creditsForActions(Number.NaN, FIRST_1M)).toBe(0n);
  });

  it("defaults to the first band when none is given", () => {
    expect(creditsForActions(50)).toBe(creditsForActions(50, FIRST_1M));
  });
});

// ---------------------------------------------------------------------------
// The retention constants the rate-card and retention capabilities print.
// ---------------------------------------------------------------------------

describe("retention constants", () => {
  it("RETENTION_INCLUDED_MONTHS is a positive whole number of months", () => {
    expect(Number.isInteger(RETENTION_INCLUDED_MONTHS)).toBe(true);
    expect(RETENTION_INCLUDED_MONTHS).toBeGreaterThan(0);
  });

  it("RETENTION_USD_PER_GB_MONTH is a positive rate", () => {
    expect(RETENTION_USD_PER_GB_MONTH).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// priceAnnualVolumeCredits — total volume, not marginal.
// ---------------------------------------------------------------------------

describe("priceAnnualVolumeCredits", () => {
  it("prices the whole annual total at the single band it lands in", () => {
    // 3M actions land in the 1m-5m ($4) band; the WHOLE 3M prices at $4,
    // not $5 for the first million and $4 after.
    const total = 3_000_000;
    expect(resolveActionBand(total).id).toBe("1m-5m");
    expect(priceAnnualVolumeCredits(total)).toBe(
      creditsForActions(total, M1_5M),
    );
    expect(priceAnnualVolumeCredits(total)).toBe(1_200_000n);
  });

  it("is strictly less than pricing the total at the first band's rate (proves it is not marginal)", () => {
    const total = 3_000_000;
    const marginalWrong = creditsForActions(total, FIRST_1M);
    expect(priceAnnualVolumeCredits(total)).toBeLessThan(marginalWrong);
  });

  it("prices a total landing in the 5m-25m band at that band's rate", () => {
    const total = 10_000_000;
    expect(resolveActionBand(total).id).toBe("5m-25m");
    expect(priceAnnualVolumeCredits(total)).toBe(
      creditsForActions(total, M5_25M),
    );
  });
});

// ---------------------------------------------------------------------------
// actionPeriodStart — first instant of the UTC calendar year.
// ---------------------------------------------------------------------------

describe("actionPeriodStart", () => {
  it("returns the first instant of the UTC calendar year containing `now`", () => {
    const now = new Date("2026-06-15T12:34:56.789Z");
    const start = actionPeriodStart(now);
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("lands on the UTC year even for a local-timezone date near a year boundary", () => {
    // 2025-12-31 23:00 in UTC-05:00 is 2026-01-01 04:00 UTC — a different
    // calendar day locally than in UTC. The period start must follow UTC.
    const now = new Date("2025-12-31T23:00:00-05:00");
    expect(now.getUTCFullYear()).toBe(2026);
    const start = actionPeriodStart(now);
    expect(start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("defaults to the current UTC year when no date is given", () => {
    const start = actionPeriodStart();
    const nowYear = new Date().getUTCFullYear();
    expect(start.getUTCFullYear()).toBe(nowYear);
    expect(start.getUTCMonth()).toBe(0);
    expect(start.getUTCDate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// incrementActionCounter / readActionCounter — the withTenantDb seam.
// ---------------------------------------------------------------------------

describe("incrementActionCounter", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("derives before/after from the RETURNING total on a fresh counter", async () => {
    const result = await incrementActionCounter("org-1", 5, 0, now);
    expect(result).toEqual({ before: 0, after: 5 });
  });

  it("derives before/after from the RETURNING total on an existing counter", async () => {
    await incrementActionCounter("org-1", 5, 0, now);
    const result = await incrementActionCounter("org-1", 3, 1, now);
    expect(result).toEqual({ before: 5, after: 8 });
  });

  it("clamps a negative or fractional actions count before storing", async () => {
    const result = await incrementActionCounter("org-1", -5, -1, now);
    expect(result).toEqual({ before: 0, after: 0 });
  });

  it("floors a fractional actions count", async () => {
    const result = await incrementActionCounter("org-1", 2.9, 0, now);
    expect(result).toEqual({ before: 0, after: 2 });
  });

  it("keeps counters for different orgs independent", async () => {
    await incrementActionCounter("org-1", 5, 0, now);
    const other = await incrementActionCounter("org-2", 1, 0, now);
    expect(other).toEqual({ before: 0, after: 1 });
  });
});

describe("readActionCounter", () => {
  const now = new Date("2026-03-01T00:00:00Z");

  it("returns zeroes when no row exists for the org/period", async () => {
    const result = await readActionCounter("org-never-seen", now);
    expect(result.actionsUsed).toBe(0);
    expect(result.actionsCharged).toBe(0);
    expect(result.periodStart.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("reflects prior increments", async () => {
    await incrementActionCounter("org-1", 10, 4, now);
    const result = await readActionCounter("org-1", now);
    expect(result.actionsUsed).toBe(10);
    expect(result.actionsCharged).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// recordGovernedAction — the GAU debit and the auto top-up claim (ADR-055).
// ---------------------------------------------------------------------------

describe("recordGovernedAction", () => {
  const ORG = "00000000-0000-0000-0000-00000000a0a1";
  const NOW = new Date("2026-09-14T12:00:00.000Z");
  const CAL_SEP = {
    start: new Date("2026-09-01T00:00:00.000Z"),
    end: new Date("2026-10-01T00:00:00.000Z"),
  };
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
  const CARD = { stripePaymentMethodId: "pm_1", brand: "visa", last4: "4242" };
  const SETTINGS = {
    orgId: ORG,
    stripeCustomerId: "cus_1",
    approvedForInvoiceBilling: false,
    invoiceGauMax: 100_000,
    autoTopupEnabled: true,
    autoTopupBlocks: 1,
    dunningState: "active" as const,
  };

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

  const record = (actions = 1) =>
    recordGovernedAction({
      orgId: ORG,
      actions,
      capability: "resolve_approval",
      now: NOW,
    });

  beforeEach(() => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: BUILD_TERMS,
      subscription: null,
    });
    mocks.readOrgBillingSettings.mockResolvedValue(SETTINGS);
    mocks.readDefaultPaymentMethod.mockResolvedValue(null);
  });

  it("debits the month bucket through ensureCurrentBucket and returns the post-debit row", async () => {
    const result = await record(3);
    expect(result.bucket).toMatchObject({
      orgId: ORG,
      periodStart: CAL_SEP.start,
      periodEnd: CAL_SEP.end,
      includedGau: 50_000,
      usedGau: 3,
    });
    expect(result.remainingGau).toBe(49_997);
    expect(result.mode).toBe("prepaid");
    expect(result.autoTopup).toBeNull();
    expect(store.buckets).toHaveLength(1);
    expect(mocks.resolveGauEntitlement).toHaveBeenCalledWith(ORG, NOW);
    expect(mocks.readOrgBillingSettings).toHaveBeenCalledWith(ORG);
  });

  it("runs the debit on the transaction withTenantDb opened for it, as one upsert", async () => {
    await record(1);
    const upsert = store.log.find((s) => s.op === "upsert");
    expect(upsert).toMatchObject({
      table: "buckets",
      values: { orgId: ORG, usedGau: 1, purchasedGau: 0 },
    });
    // The first tenant transaction is the debit; the counter follows in its own.
    expect(txs.length).toBeGreaterThanOrEqual(2);
  });

  it("uses the subscription's period from periodFor, not the calendar month", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: BUILD_TERMS,
      subscription: {
        billingInterval: "month",
        currentPeriodStart: new Date("2026-09-03T08:00:00.000Z"),
        currentPeriodEnd: new Date("2026-10-03T08:00:00.000Z"),
      },
    });
    const result = await record(1);
    expect(result.bucket.periodStart).toEqual(
      new Date("2026-09-03T08:00:00.000Z"),
    );
    expect(result.bucket.periodEnd).toEqual(
      new Date("2026-10-03T08:00:00.000Z"),
    );
  });

  it("debits once per call: two calls add up, and the annual counter counts them too", async () => {
    await record(2);
    const result = await record(5);
    expect(result.bucket.usedGau).toBe(7);
    expect(store.buckets).toHaveLength(1);
    const counter = await readActionCounter(ORG, NOW);
    expect(counter.actionsUsed).toBe(7);
    expect(counter.actionsCharged).toBe(0);
  });

  it("reports the stored negative remaining when the debit overdraws the bucket", async () => {
    seedBucket({ includedGau: 50_000, usedGau: 49_999 });
    const result = await record(3);
    expect(result.remainingGau).toBe(-2);
    expect(result.bucket.usedGau).toBe(50_002);
  });

  it("treats a fractional actions count as at least 1", async () => {
    const result = await record(0.4);
    expect(result.bucket.usedGau).toBe(1);
  });

  // ── item 8c: the auto top-up claim ────────────────────────────────────────

  it("a Free org with no default payment method at remaining ≤ 0 claims no episode, writes no settlement, calls no provider", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(null);
    seedBucket({ includedGau: 5_000, usedGau: 4_999 });

    const result = await record(1);

    expect(result.remainingGau).toBe(0);
    expect(result.autoTopup).toBeNull();
    expect(store.settlements).toHaveLength(0);
    expect(store.buckets[0]).toMatchObject({
      openTopupSettlementId: null,
      topupSeq: 0,
    });
    expect(mocks.readDefaultPaymentMethod).toHaveBeenCalledWith(ORG);
    expect(store.log.filter((s) => s.op === "update")).toHaveLength(0);
    expect(mocks.billingProvider).not.toHaveBeenCalled();
  });

  it("a Free org with a saved default card claims one auto_topup settlement for auto_topup_blocks × block_size_gau at Free's published rate", async () => {
    mocks.resolveGauEntitlement.mockResolvedValue({
      terms: FREE_TERMS,
      subscription: null,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    mocks.readOrgBillingSettings.mockResolvedValue({
      ...SETTINGS,
      autoTopupBlocks: 2,
    });
    const bucket = seedBucket({ includedGau: 5_000, usedGau: 4_999 });

    const result = await record(1);

    expect(store.settlements).toHaveLength(1);
    expect(result.autoTopup).toMatchObject({
      orgId: ORG,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq: 1,
      quantityGau: 10_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "pending",
    });
    expect(store.buckets[0]).toMatchObject({
      openTopupSettlementId: result.autoTopup!.id,
      topupSeq: 1,
    });
    // The claim commits before any provider call; settlement is WL-31's.
    expect(mocks.billingProvider).not.toHaveBeenCalled();
  });

  it("a Build org with a card claims exactly the same way", async () => {
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    const result = await record(1);
    expect(result.autoTopup).toMatchObject({
      kind: "auto_topup",
      quantityGau: 5_000,
    });
  });

  it("the claim commits in its own transaction after the debit's", async () => {
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    await record(1);
    const ops = store.log
      .filter((s) => s.op !== "select")
      .map((s) => `${s.op}:${s.table}`);
    expect(ops).toEqual([
      "upsert:buckets",
      "update:buckets",
      "insert:settlements",
    ]);
    // Three tenant transactions: the debit, the counter, the claim.
    expect(txs).toHaveLength(3);
  });

  it("claims nothing while an episode is already open", async () => {
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    seedBucket({
      includedGau: 50_000,
      usedGau: 50_000,
      openTopupSettlementId: crypto.randomUUID(),
      topupSeq: 1,
    });
    const result = await record(1);
    expect(result.autoTopup).toBeNull();
    expect(store.settlements).toHaveLength(0);
  });

  it("claims nothing when auto top-up is disabled, without reading the card", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      ...SETTINGS,
      autoTopupEnabled: false,
    });
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    const result = await record(1);
    expect(result.autoTopup).toBeNull();
    expect(mocks.readDefaultPaymentMethod).not.toHaveBeenCalled();
    expect(store.settlements).toHaveLength(0);
  });

  it("claims nothing for an invoice-billed org however far past the allowance", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      ...SETTINGS,
      approvedForInvoiceBilling: true,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    seedBucket({ includedGau: 50_000, usedGau: 400_000 });
    const result = await record(1);
    expect(result.mode).toBe("invoice");
    expect(result.autoTopup).toBeNull();
    expect(mocks.readDefaultPaymentMethod).not.toHaveBeenCalled();
  });

  it("claims nothing while remaining > 0", async () => {
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    seedBucket({ includedGau: 50_000, usedGau: 49_998 });
    const result = await record(1);
    expect(result.remainingGau).toBe(1);
    expect(result.autoTopup).toBeNull();
  });

  it("never throws after the debit: a failing claim is logged and the debit stands", async () => {
    mocks.readDefaultPaymentMethod.mockRejectedValue(
      new Error("mirror unavailable"),
    );
    seedBucket({ includedGau: 50_000, usedGau: 50_000 });
    const result = await record(1);
    expect(result.bucket.usedGau).toBe(50_001);
    expect(result.autoTopup).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG, err: "mirror unavailable" }),
      expect.stringMatching(/step after the debit failed/),
    );
  });
});
