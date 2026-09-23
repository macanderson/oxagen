/**
 * Unit tests for action-metering.ts — the governed-action meter (ADR-052,
 * ADR-055).
 *
 * Each test is anchored to a specific invariant claimed in the source file's
 * JSDoc, so a change that breaks the claim also breaks the test that proves
 * it. The `withTenantDb` seam hands out the in-memory GAU store from
 * test-utils/gau-fake-tx.ts, which runs the real statements against
 * `billing.gau_buckets` and `billing.gau_settlements`. The recorder's other
 * reads — terms, settings, the default card — are module doubles.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fakeGauExecutor,
  makeFakeGauStore,
  type FakeGauStore,
} from "./test-utils/gau-fake-tx";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  resolveGauEntitlement: vi.fn(),
  readGauEntitlement: vi.fn(),
  ensureStripeCustomer: vi.fn(),
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock(
  "./contract-terms",
  () =>
    ({
      resolveGauEntitlement: mocks.resolveGauEntitlement,
      readGauEntitlement: mocks.readGauEntitlement,
    }) satisfies Pick<
      typeof import("./contract-terms"),
      "resolveGauEntitlement" | "readGauEntitlement"
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
  resolveActionBand,
  TIER_ACTION_ALLOWANCES,
  ENTERPRISE_FALLBACK_ALLOWANCE,
  resolveActionAllowance,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  actionPeriodStart,
  recordGovernedAction,
  recordGovernedActions,
} = await import("./action-metering");
const { governedActionEntry } = await import("./gau-ledger");
const { logger } = await import("./logger");

let store: FakeGauStore;
let txs: ReturnType<typeof fakeGauExecutor>[];

beforeEach(() => {
  vi.clearAllMocks();
  store = makeFakeGauStore();
  txs = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    const tx = fakeGauExecutor(store);
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

  it("runs the debit on the transaction withTenantDb opened for it: the bucket lock, the ledger row, the debit", async () => {
    await record(1);
    const writes = store.log
      .filter((s) => s.op !== "select")
      .map((s) => `${s.op}:${s.table}`);
    expect(writes).toEqual([
      "upsert:buckets",
      "insert:ledger",
      "update:buckets",
    ]);
    // The upsert only creates or locks the row; the debit is the UPDATE that
    // adds exactly the units that landed on the ledger.
    expect(store.log.find((s) => s.op === "upsert")).toMatchObject({
      table: "buckets",
      values: { orgId: ORG, usedGau: 0, purchasedGau: 0 },
    });
    // The debit is the one tenant transaction a prepaid org inside its
    // allowance opens; nothing else on the recorder path writes.
    expect(txs).toHaveLength(1);
  });

  // ── ADR-158: the ledger ──────────────────────────────────────────────────

  it("writes one ledger row per action, on the bucket it debited, with the entry's attribution", async () => {
    const result = await recordGovernedAction({
      orgId: ORG,
      actions: 2,
      capability: "resolve_approval",
      runId: "arun_1",
      entry: governedActionEntry({
        idempotencyKey: "kernel:tool:arun_1:call_1",
        source: "kernel",
        units: 2,
        occurredAt: NOW,
        capability: "resolve_approval",
        surface: "agent",
        workspaceId: "00000000-0000-0000-0000-0000000000b1",
        agentId: "agt_1",
        operatorUserId: "usr_1",
        runId: "arun_1",
        toolCallId: "call_1",
      }),
      now: NOW,
    });
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({
      orgId: ORG,
      bucketId: result.bucket.id,
      idempotencyKey: "kernel:tool:arun_1:call_1",
      source: "kernel",
      capability: "resolve_approval",
      attributedWorkspaceId: "00000000-0000-0000-0000-0000000000b1",
      agentId: "agt_1",
      operatorUserId: "usr_1",
      runId: "arun_1",
      toolCallId: "call_1",
      units: 2,
      billedAt: NOW,
    });
    expect(result.billedUnits).toBe(2);
    expect(result.bucket.usedGau).toBe(2);
  });

  it("bills a retried action once: the second call finds its key and debits nothing", async () => {
    const entry = governedActionEntry({
      idempotencyKey: "kernel:tool:arun_1:call_1",
      source: "kernel",
      units: 1,
      occurredAt: NOW,
      capability: "resolve_approval",
    });
    const args = {
      orgId: ORG,
      actions: 1,
      capability: "resolve_approval",
      entry,
      now: NOW,
    };
    await recordGovernedAction(args);
    const retry = await recordGovernedAction(args);
    expect(retry.billedUnits).toBe(0);
    expect(retry.duplicates).toBe(1);
    expect(retry.bucket.usedGau).toBe(1);
    expect(store.ledger).toHaveLength(1);
  });

  it("the bucket's used_gau equals the sum of its ledger rows across a batch with a duplicate", async () => {
    const at = (key: string, units: number) =>
      governedActionEntry({
        idempotencyKey: key,
        source: "tacho",
        units,
        occurredAt: NOW,
        toolName: "Bash",
      });
    await recordGovernedActions({
      orgId: ORG,
      entries: [at("tacho:s1:t1", 1), at("tacho:s1:t2", 1)],
      label: "tacho:tool_calls",
      now: NOW,
    });
    const second = await recordGovernedActions({
      orgId: ORG,
      // t2 is a re-sent tool call; t3 is new; t3 twice in one batch is one.
      entries: [
        at("tacho:s1:t2", 1),
        at("tacho:s1:t3", 1),
        at("tacho:s1:t3", 1),
      ],
      label: "tacho:tool_calls",
      now: NOW,
    });
    expect(second.billedUnits).toBe(1);
    expect(second.duplicates).toBe(2);
    const sum = store.ledger.reduce((n, r) => n + (r.units as number), 0);
    expect(sum).toBe(3);
    expect(store.buckets[0]?.usedGau).toBe(sum);
  });

  it("a call with no entry still writes a ledger row, with a key unique to the call", async () => {
    await record(1);
    await record(1);
    expect(store.ledger).toHaveLength(2);
    expect(store.ledger[0]?.idempotencyKey).not.toBe(
      store.ledger[1]?.idempotencyKey,
    );
    expect(store.ledger[0]).toMatchObject({
      source: "kernel",
      capability: "resolve_approval",
    });
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

  it("debits once per call: two calls add up on the one bucket", async () => {
    await record(2);
    const result = await record(5);
    expect(result.bucket.usedGau).toBe(7);
    expect(store.buckets).toHaveLength(1);
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
    // The one UPDATE is the debit itself; no claim touched the bucket.
    expect(store.log.filter((s) => s.op === "update")).toHaveLength(1);
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
    expect(store.buckets[0]).toMatchObject({ topupSeq: 1 });
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
    expect(ops.slice(0, 5)).toEqual([
      "upsert:buckets",
      "insert:ledger",
      "update:buckets",
      "update:buckets",
      "insert:settlements",
    ]);
    // The debit and the claim are the first two tenant transactions.
    expect(store.log.indexOf(store.log.find((s) => s.op === "update")!)).toBe(
      store.log.findIndex((s) => s.op === "update"),
    );
    expect(txs.length).toBeGreaterThanOrEqual(2);
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

  it("claims no auto top-up for an invoice-billed org however far past the allowance", async () => {
    mocks.readOrgBillingSettings.mockResolvedValue({
      ...SETTINGS,
      approvedForInvoiceBilling: true,
    });
    mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
    const bucket = seedBucket({ includedGau: 50_000, usedGau: 400_000 });
    const result = await record(1);
    expect(result.mode).toBe("invoice");
    expect(result.autoTopup).toBeNull();
    expect(store.settlements.map((r) => r.kind)).not.toContain("auto_topup");
    expect(bucket.topupSeq).toBe(0);
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

  // ── items 8c–8e: the settlement sequence after a claim ────────────────────

  describe("settlement", () => {
    /** Every committed tenant transaction and every provider call, in order. */
    let order: string[];
    const provider = {
      createGauInvoice: vi.fn(),
      finalizeAndPayGauInvoice: vi.fn(),
    };
    const settlementRow = () => store.settlements[0]!;
    const invoiceMode = (over: Record<string, unknown> = {}) =>
      mocks.readOrgBillingSettings.mockResolvedValue({
        ...SETTINGS,
        approvedForInvoiceBilling: true,
        invoiceGauMax: 1_000,
        ...over,
      });

    beforeEach(() => {
      order = [];
      mocks.withTenantDb.mockImplementation(
        async (fn: (tx: unknown) => unknown) => {
          const tx = fakeGauExecutor(store);
          txs.push(tx);
          const out = await fn(tx);
          order.push("commit");
          return out;
        },
      );
      mocks.readGauEntitlement.mockResolvedValue({
        terms: BUILD_TERMS,
        subscription: null,
      });
      mocks.ensureStripeCustomer.mockResolvedValue("cus_ensured");
      provider.createGauInvoice.mockImplementation(
        async (input: { settlementId: string }) => {
          order.push("createGauInvoice");
          return { invoiceId: `in_${input.settlementId}` };
        },
      );
      provider.finalizeAndPayGauInvoice.mockImplementation(async () => {
        order.push("finalizeAndPayGauInvoice");
        return { status: "paid", amountCents: 2_500, hostedInvoiceUrl: null };
      });
      mocks.billingProvider.mockReturnValue(provider);
    });

    it("prepaid: commits the claim before the first provider call, charges the saved card for the settings' customer, and the paid top-up grants and clears the episode", async () => {
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      const bucket = seedBucket({ includedGau: 50_000, usedGau: 50_000 });

      const result = await record(1);

      expect(order).toEqual([
        "commit", // the debit
        "commit", // the claim
        "createGauInvoice",
        "commit", // recordGauInvoice
        "finalizeAndPayGauInvoice",
        "commit", // settleGauPaid
      ]);
      expect(provider.createGauInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cus_1",
          settlementId: result.autoTopup!.id,
          kind: "gau_auto_topup",
          quantityGau: 5_000,
          collection: {
            method: "charge_automatically",
            defaultPaymentMethodId: "pm_1",
          },
        }),
      );
      expect(mocks.ensureStripeCustomer).not.toHaveBeenCalled();
      expect(settlementRow()).toMatchObject({
        status: "paid",
        stripeInvoiceId: `in_${result.autoTopup!.id}`,
      });
      expect(bucket).toMatchObject({
        purchasedGau: 5_000,
        openTopupSettlementId: null,
      });
    });

    it("prepaid: a top-up that ends open leaves the episode set, and a second exhaustion in the month claims nothing", async () => {
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      provider.finalizeAndPayGauInvoice.mockResolvedValue({
        status: "open",
        amountCents: 2_500,
        hostedInvoiceUrl: null,
      });
      const bucket = seedBucket({ includedGau: 50_000, usedGau: 50_000 });

      const first = await record(1);
      const second = await record(1);

      expect(second.autoTopup).toBeNull();
      expect(store.settlements).toHaveLength(1);
      expect(settlementRow().status).toBe("open");
      expect(bucket.openTopupSettlementId).toBe(first.autoTopup!.id);
      expect(provider.createGauInvoice).toHaveBeenCalledOnce();
    });

    it("prepaid: a provider that rejects the create leaves the claim pending with no invoice id, and the recorder returns", async () => {
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      provider.createGauInvoice.mockRejectedValue(new Error("stripe down"));
      seedBucket({ includedGau: 50_000, usedGau: 50_000 });

      const result = await record(1);

      expect(result.bucket.usedGau).toBe(50_001);
      expect(settlementRow()).toMatchObject({
        status: "pending",
        stripeInvoiceId: null,
      });
    });

    it("prepaid: a provider that rejects the finalize leaves the claim pending with its invoice id, and the recorder returns", async () => {
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      provider.finalizeAndPayGauInvoice.mockRejectedValue(
        new Error("stripe down"),
      );
      seedBucket({ includedGau: 50_000, usedGau: 50_000 });

      const result = await record(1);

      expect(settlementRow()).toMatchObject({
        status: "pending",
        stripeInvoiceId: `in_${result.autoTopup!.id}`,
      });
      expect(store.buckets[0]!.purchasedGau).toBe(0);
    });

    it("prepaid: an org with a card and no stripe_customer_id leaves the claim pending and calls no provider", async () => {
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      mocks.readOrgBillingSettings.mockResolvedValue({
        ...SETTINGS,
        stripeCustomerId: null,
      });
      seedBucket({ includedGau: 50_000, usedGau: 50_000 });

      await record(1);

      expect(settlementRow().status).toBe("pending");
      expect(provider.createGauInvoice).not.toHaveBeenCalled();
    });

    it.each([
      ["prepaid inside the allowance", {}, 49_000, CARD, null],
      [
        "prepaid exhausted with auto top-up off",
        { autoTopupEnabled: false },
        50_000,
        CARD,
        null,
      ],
      ["prepaid exhausted with no card", {}, 50_000, null, null],
      ["prepaid exhausted with a card", {}, 50_000, CARD, "auto_topup"],
      [
        "invoice-billed below invoice_gau_max",
        { approvedForInvoiceBilling: true, invoiceGauMax: 1_000 },
        50_000 + 998,
        CARD,
        null,
      ],
      [
        "invoice-billed reaching invoice_gau_max",
        { approvedForInvoiceBilling: true, invoiceGauMax: 1_000 },
        50_000 + 999,
        CARD,
        "interim_invoice",
      ],
      [
        "an unapproved org past its stored invoice_gau_max, with no card",
        { approvedForInvoiceBilling: false, invoiceGauMax: 1 },
        60_000,
        null,
        null,
      ],
    ])("mode matrix: %s", async (_name, over, usedGau, card, settledKind) => {
      mocks.readOrgBillingSettings.mockResolvedValue({
        ...SETTINGS,
        ...over,
      });
      mocks.readDefaultPaymentMethod.mockResolvedValue(card);
      seedBucket({ includedGau: 50_000, usedGau });

      await expect(record(1)).resolves.toBeDefined();

      expect(store.settlements.map((r) => r.kind)).toEqual(
        settledKind === null ? [] : [settledKind],
      );
      expect(
        store.settlements.filter((r) => r.kind === "interim_invoice"),
      ).toHaveLength(settledKind === "interim_invoice" ? 1 : 0);
    });

    it("invoice: crossing invoice_gau_max claims exactly the max for the customer ensureStripeCustomer resolves, collected from the default card, and accrual restarts", async () => {
      invoiceMode();
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      const bucket = seedBucket({ includedGau: 50_000, usedGau: 50_999 });

      const result = await record(1);

      expect(result.interimInvoice).toMatchObject({
        kind: "interim_invoice",
        seq: 1,
        quantityGau: 1_000,
      });
      expect(order.slice(0, 3)).toEqual([
        "commit",
        "commit",
        "createGauInvoice",
      ]);
      expect(mocks.ensureStripeCustomer).toHaveBeenCalledWith(ORG);
      expect(provider.createGauInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cus_ensured",
          kind: "gau_interim",
          quantityGau: 1_000,
          collection: {
            method: "charge_automatically",
            defaultPaymentMethodId: "pm_1",
          },
        }),
      );
      expect(settlementRow().status).toBe("paid");
      expect(bucket).toMatchObject({
        overageInvoicedGau: 1_000,
        interimSeq: 1,
        purchasedGau: 0,
      });

      // GAU #1,001 of overage opens the next accrual; its crossing is seq 2.
      expect((await record(1)).interimInvoice).toBeNull();
      const again = await record(999);
      expect(again.interimInvoice).toMatchObject({
        seq: 2,
        quantityGau: 1_000,
      });
    });

    it("invoice: an org with no default payment method gets a send_invoice invoice and ends open with an invoice id and no failed row", async () => {
      invoiceMode();
      mocks.readDefaultPaymentMethod.mockResolvedValue(null);
      provider.finalizeAndPayGauInvoice.mockResolvedValue({
        status: "open",
        amountCents: 500,
        hostedInvoiceUrl: "https://invoice.stripe.com/i/interim",
      });
      seedBucket({ includedGau: 50_000, usedGau: 50_999 });

      const result = await record(1);

      expect(provider.createGauInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          collection: { method: "send_invoice", daysUntilDue: 30 },
        }),
      );
      expect(settlementRow()).toMatchObject({
        status: "open",
        stripeInvoiceId: `in_${result.interimInvoice!.id}`,
      });
      expect(store.settlements.map((r) => r.status)).not.toContain("failed");
    });

    it("invoice: a terms change mid-month prices the next settlement at the new rate", async () => {
      invoiceMode();
      mocks.readDefaultPaymentMethod.mockResolvedValue(CARD);
      seedBucket({ includedGau: 50_000, usedGau: 50_999 });
      await record(1);

      mocks.resolveGauEntitlement.mockResolvedValue({
        terms: { ...BUILD_TERMS, ratePerGauMicros: 4_000n },
        subscription: null,
      });
      await record(1_000);

      expect(store.settlements.map((r) => r.ratePerGauMicros)).toEqual([
        5_000n,
        4_000n,
      ]);
      expect(provider.createGauInvoice).toHaveBeenLastCalledWith(
        expect.objectContaining({ ratePerGauMicros: 4_000n }),
      );
    });
  });
});
