/**
 * Unit tests for action-metering.ts — the governed-action meter (ADR-052).
 *
 * Each test is anchored to a specific invariant claimed in the source file's
 * JSDoc, so a change that breaks the claim also breaks the test that proves
 * it. Mocks the `withTenantDb` seam (following consume-credits.test.ts /
 * tier.test.ts) and the `./credits` module — no live Postgres needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The governed_action_counters mock — an in-memory upsert-add table, keyed by
// (orgId, periodStart). Mirrors the ON CONFLICT DO UPDATE ... RETURNING
// semantics of incrementActionCounter's real statement.
// ---------------------------------------------------------------------------

interface CounterRow {
  actionsUsed: bigint;
  actionsCharged: bigint;
}

const state: {
  counters: Map<string, CounterRow>;
} = { counters: new Map() };

function counterKey(orgId: string, periodStart: Date): string {
  return `${orgId}::${periodStart.toISOString()}`;
}

// Distinguishable placeholder schema — values are never inspected for
// anything beyond identity/round-tripping through our mocked eq()/and().
const SCHEMA = {
  governedActionCounters: {
    orgId: "gac.orgId",
    periodStart: "gac.periodStart",
    actionsUsed: "gac.actionsUsed",
    actionsCharged: "gac.actionsCharged",
  },
} as const;

interface EqCond {
  _eq: [unknown, unknown];
}
interface AndCond {
  _and: EqCond[];
}

function makeTx() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(
        (v: {
          orgId: string;
          periodStart: Date;
          actionsUsed: bigint;
          actionsCharged: bigint;
        }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => {
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
            }),
          })),
        }),
      ),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: AndCond) => ({
          limit: vi.fn(async () => {
            const orgId = cond._and[0]?._eq[1] as string;
            const periodStart = cond._and[1]?._eq[1] as Date;
            const row = state.counters.get(counterKey(orgId, periodStart));
            return row
              ? [
                  {
                    actionsUsed: row.actionsUsed,
                    actionsCharged: row.actionsCharged,
                  },
                ]
              : [];
          }),
        })),
      })),
    })),
  };
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }) as EqCond,
    and: (...conds: EqCond[]) => ({ _and: conds }) as AndCond,
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    schema: SCHEMA,
  };
});

// ---------------------------------------------------------------------------
// consumeCredits mock — action-metering.ts's only billing dependency.
// ---------------------------------------------------------------------------

const consumeCreditsMock = vi.fn(
  async (_args: {
    orgId: string;
    requestedMicroCents?: bigint;
    requestedCents?: bigint;
    reason: string;
    referenceType?: string;
    referenceId?: string;
  }) => ({
    chargedCents: 0n,
    shortfallCents: 0n,
    balanceCents: 0n,
    carryMicroCents: 0n,
  }),
);

vi.mock("./credits", () => ({
  consumeCredits: (...args: Parameters<typeof consumeCreditsMock>) =>
    consumeCreditsMock(...args),
}));

const {
  ACTION_RATE_BANDS,
  resolveActionBand,
  TIER_ACTION_ALLOWANCES,
  ENTERPRISE_FALLBACK_ALLOWANCE,
  resolveActionAllowance,
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
  retentionCreditsForGbMonths,
  microCreditsForActions,
  creditsForActions,
  priceAnnualVolumeCredits,
  resolveActionMeterMode,
  resetActionMeterModeForTests,
  actionPeriodStart,
  incrementActionCounter,
  readActionCounter,
  billableActionCount,
  recordGovernedAction,
  chargeEvidenceRetention,
} = await import("./action-metering");
const { MICRO_CREDITS_PER_CREDIT } = await import("./pricing");
const { CREDIT_REASONS } = await import("./constants");
const { logger } = await import("./logger");

const FIRST_1M = ACTION_RATE_BANDS.find((b) => b.id === "first-1m")!;
const M1_5M = ACTION_RATE_BANDS.find((b) => b.id === "1m-5m")!;
const M5_25M = ACTION_RATE_BANDS.find((b) => b.id === "5m-25m")!;
const COMMITTED_25M = ACTION_RATE_BANDS.find(
  (b) => b.id === "committed-25m-plus",
)!;

beforeEach(() => {
  state.counters = new Map();
  consumeCreditsMock.mockReset();
  consumeCreditsMock.mockResolvedValue({
    chargedCents: 0n,
    shortfallCents: 0n,
    balanceCents: 0n,
    carryMicroCents: 0n,
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
// billableActionCount — the straddle case, and never negative.
// ---------------------------------------------------------------------------

describe("billableActionCount", () => {
  it("splits a call that straddles the allowance boundary", () => {
    expect(billableActionCount(9, 12, 10)).toBe(2);
  });

  it("returns 0 when the whole call is inside the allowance", () => {
    expect(billableActionCount(0, 5, 10)).toBe(0);
  });

  it("returns the full delta when the whole call is past the allowance", () => {
    expect(billableActionCount(15, 20, 10)).toBe(5);
  });

  it("never returns negative, even for a non-increasing before/after pair", () => {
    expect(billableActionCount(20, 15, 10)).toBe(0);
    expect(billableActionCount(5, 5, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// microCreditsForActions vs creditsForActions — exact vs display upper bound.
// ---------------------------------------------------------------------------

describe("microCreditsForActions vs creditsForActions", () => {
  it("prices one action at the $6 band as 0.6 of a credit in micro-credits, not 1", () => {
    const micro = microCreditsForActions(1, COMMITTED_25M);
    expect(micro).toBe(600_000n); // 0.6 credit exactly
    expect(micro).toBeLessThan(MICRO_CREDITS_PER_CREDIT);
  });

  it("rounds the same single action UP to a whole credit for display", () => {
    expect(creditsForActions(1, COMMITTED_25M)).toBe(1n);
  });

  it("does NOT price 1000 actions at the $6 band as 1000 credits", () => {
    // The exact failure this file exists to prevent: rounding every action up
    // to a whole credit would charge 1000 credits for $6 of work.
    const micro = microCreditsForActions(1000, COMMITTED_25M);
    expect(micro).toBe(600_000_000n); // exactly 600 credits, in micro-credits
    expect(micro / MICRO_CREDITS_PER_CREDIT).toBe(600n);
    expect(micro).toBeLessThan(1000n * MICRO_CREDITS_PER_CREDIT);
  });

  it("agrees with creditsForActions once a count's worth lands on a whole credit", () => {
    // 50 actions at the $20 band = $1.00 = exactly 100 credits.
    const micro = microCreditsForActions(50, FIRST_1M);
    const credits = creditsForActions(50, FIRST_1M);
    expect(micro / MICRO_CREDITS_PER_CREDIT).toBe(100n);
    expect(credits).toBe(100n);
    expect(micro / MICRO_CREDITS_PER_CREDIT).toBe(credits);
  });

  it("returns 0n for a non-positive or non-finite count on both functions", () => {
    expect(microCreditsForActions(0, FIRST_1M)).toBe(0n);
    expect(microCreditsForActions(-5, FIRST_1M)).toBe(0n);
    expect(microCreditsForActions(Number.NaN, FIRST_1M)).toBe(0n);
    expect(creditsForActions(0, FIRST_1M)).toBe(0n);
    expect(creditsForActions(-5, FIRST_1M)).toBe(0n);
  });

  it("creditsForActions defaults to the first band when none is given", () => {
    expect(creditsForActions(50)).toBe(creditsForActions(50, FIRST_1M));
  });
});

// ---------------------------------------------------------------------------
// retentionCreditsForGbMonths — rounds up; non-positive/non-finite is 0n.
// ---------------------------------------------------------------------------

describe("retentionCreditsForGbMonths", () => {
  it("returns 0n for zero gb-months", () => {
    expect(retentionCreditsForGbMonths(0)).toBe(0n);
  });

  it("returns 0n for negative gb-months", () => {
    expect(retentionCreditsForGbMonths(-3)).toBe(0n);
  });

  it("returns 0n for non-finite gb-months", () => {
    expect(retentionCreditsForGbMonths(Number.NaN)).toBe(0n);
    expect(retentionCreditsForGbMonths(Number.POSITIVE_INFINITY)).toBe(0n);
  });

  it("prices a whole gb-month exactly", () => {
    // 1 GB-month * $0.08/GB-month = $0.08 = 8 credits, exact.
    expect(retentionCreditsForGbMonths(1)).toBe(
      BigInt(Math.round(RETENTION_USD_PER_GB_MONTH * 100)),
    );
  });

  it("rounds a fractional-credit charge UP", () => {
    // 0.3 GB-months * $0.08 = $0.024 = 2.4 credits → rounds up to 3.
    expect(retentionCreditsForGbMonths(0.3)).toBe(3n);
  });

  it("RETENTION_INCLUDED_MONTHS is a positive whole number of months", () => {
    expect(RETENTION_INCLUDED_MONTHS).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// priceAnnualVolumeCredits — total volume, not marginal.
// ---------------------------------------------------------------------------

describe("priceAnnualVolumeCredits", () => {
  it("prices the whole annual total at the single band it lands in", () => {
    // 3M actions land in the 1m-5m ($15) band; the WHOLE 3M prices at $15,
    // not $20 for the first million and $15 after.
    const total = 3_000_000;
    expect(resolveActionBand(total).id).toBe("1m-5m");
    expect(priceAnnualVolumeCredits(total)).toBe(
      creditsForActions(total, M1_5M),
    );
    expect(priceAnnualVolumeCredits(total)).toBe(4_500_000n);
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
// resolveActionMeterMode / resetActionMeterModeForTests
// ---------------------------------------------------------------------------

describe("resolveActionMeterMode", () => {
  const ENV_KEY = "OXAGEN_ACTION_METER_MODE";
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    resetActionMeterModeForTests();
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    resetActionMeterModeForTests();
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to 'charge' when the env var is unset", () => {
    expect(resolveActionMeterMode()).toBe("charge");
  });

  it("returns 'shadow' only for exactly 'shadow'", () => {
    process.env[ENV_KEY] = "shadow";
    expect(resolveActionMeterMode()).toBe("shadow");
  });

  it("defaults to 'charge' for any other value", () => {
    process.env[ENV_KEY] = "SHADOW"; // wrong case
    expect(resolveActionMeterMode()).toBe("charge");
    resetActionMeterModeForTests();
    process.env[ENV_KEY] = "off";
    expect(resolveActionMeterMode()).toBe("charge");
  });

  it("memoises within a process — a later env change has no effect until reset", () => {
    process.env[ENV_KEY] = "shadow";
    expect(resolveActionMeterMode()).toBe("shadow");
    process.env[ENV_KEY] = "charge";
    expect(resolveActionMeterMode()).toBe("shadow"); // still memoised
    resetActionMeterModeForTests();
    expect(resolveActionMeterMode()).toBe("charge"); // re-resolves after reset
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
// recordGovernedAction — the recorder.
// ---------------------------------------------------------------------------

describe("recordGovernedAction", () => {
  const ENV_KEY = "OXAGEN_ACTION_METER_MODE";
  const now = new Date("2026-04-01T00:00:00Z");

  beforeEach(() => {
    delete process.env[ENV_KEY];
    resetActionMeterModeForTests();
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    resetActionMeterModeForTests();
  });

  it("shadow mode records the count and raises no debit", async () => {
    process.env[ENV_KEY] = "shadow";
    resetActionMeterModeForTests();

    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 5,
      capability: "send_message",
      tier: "free",
      now,
    });

    expect(result.mode).toBe("shadow");
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
    // The action was still counted.
    expect(result.periodActions).toBe(5);
    const counter = await readActionCounter("org-1", now);
    expect(counter.actionsUsed).toBe(5);
  });

  it("raises no debit while inside the allowance", async () => {
    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "build", // 250,000 allowance
      now,
    });

    expect(result.billableActions).toBe(0);
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("debits via consumeCredits with reason consume_execution and referenceType governed_action once past the allowance", async () => {
    // Seed the counter already at the free tier's 25,000 allowance.
    await incrementActionCounter("org-1", 25_000, 0, now);
    consumeCreditsMock.mockResolvedValueOnce({
      chargedCents: 20n,
      shortfallCents: 0n,
      balanceCents: 980n,
      carryMicroCents: 0n,
    });

    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "free",
      now,
    });

    expect(result.billableActions).toBe(10);
    expect(result.band.id).toBe("first-1m");
    expect(result.creditsCharged).toBe(20n);
    expect(consumeCreditsMock).toHaveBeenCalledTimes(1);
    expect(consumeCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        requestedMicroCents: 20_000_000n, // 10 actions @ $20/1000 = 20 credits
        reason: CREDIT_REASONS.CONSUME_EXECUTION,
        referenceType: "governed_action",
      }),
    );
  });

  it("writes NO referenceId (undefined, never fabricated) when there is no runId", async () => {
    await incrementActionCounter("org-1", 25_000, 0, now);
    await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "free",
      now,
    });

    const call = consumeCreditsMock.mock.calls[0]?.[0] as {
      referenceId?: string;
    };
    expect(call.referenceId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(call, "referenceId")).toBe(
      true,
    );
  });

  it("uses the runId as referenceId when one is given", async () => {
    await incrementActionCounter("org-1", 25_000, 0, now);
    const runId = "018f7e4a-4e4a-7000-8000-000000000001";
    await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "free",
      runId,
      now,
    });

    const call = consumeCreditsMock.mock.calls[0]?.[0] as {
      referenceId?: string;
    };
    expect(call.referenceId).toBe(runId);
  });

  it("increments the counter BEFORE debiting, and increments actionsCharged AFTER the debit", async () => {
    await incrementActionCounter("org-1", 25_000, 0, now);
    const order: string[] = [];
    consumeCreditsMock.mockImplementationOnce(async () => {
      order.push("consumeCredits");
      const counter = await readActionCounter("org-1", now);
      // At the moment consumeCredits runs, actionsUsed already reflects this
      // call's actions, but actionsCharged does not yet.
      expect(counter.actionsUsed).toBe(25_010);
      expect(counter.actionsCharged).toBe(0);
      return {
        chargedCents: 20n,
        shortfallCents: 0n,
        balanceCents: 0n,
        carryMicroCents: 0n,
      };
    });

    await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "free",
      now,
    });

    const finalCounter = await readActionCounter("org-1", now);
    expect(finalCounter.actionsCharged).toBe(10);
    expect(order).toEqual(["consumeCredits"]);
  });

  it("never throws when consumeCredits rejects — the customer's response is already correct", async () => {
    await incrementActionCounter("org-1", 25_000, 0, now);
    consumeCreditsMock.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(
      recordGovernedAction({
        orgId: "org-1",
        actions: 10,
        capability: "send_message",
        tier: "free",
        now,
      }),
    ).resolves.not.toThrow();
  });

  it("leaves actions counted but uncharged when consumeCredits rejects (the audit gap)", async () => {
    await incrementActionCounter("org-1", 25_000, 0, now);
    consumeCreditsMock.mockRejectedValueOnce(new Error("ledger unavailable"));

    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 10,
      capability: "send_message",
      tier: "free",
      now,
    });

    expect(result.creditsCharged).toBe(0n);
    expect(result.periodActions).toBe(25_010);

    const counter = await readActionCounter("org-1", now);
    expect(counter.actionsUsed).toBe(25_010); // still counted
    expect(counter.actionsCharged).toBe(0); // never charged — the debit failed
  });

  it("defaults tier to 'free' when none is supplied", async () => {
    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 1,
      capability: "send_message",
      now,
    });
    // free allowance is 25,000 — 1 action stays inside it.
    expect(result.billableActions).toBe(0);
  });

  it("treats a fractional actions count as at least 1", async () => {
    const result = await recordGovernedAction({
      orgId: "org-1",
      actions: 0.4,
      capability: "send_message",
      tier: "free",
      now,
    });
    expect(result.periodActions).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// chargeEvidenceRetention — the opt-in guarantee.
// ---------------------------------------------------------------------------

describe("chargeEvidenceRetention", () => {
  beforeEach(() => {
    consumeCreditsMock.mockReset();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 0n,
      shortfallCents: 0n,
      balanceCents: 0n,
      carryMicroCents: 0n,
    });
  });

  it("refuses and charges nothing when the org has not opted in", async () => {
    const result = await chargeEvidenceRetention({
      orgId: "org-1",
      gbMonths: 100,
      optedIn: false,
    });
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("charges with reason consume_retention when opted in", async () => {
    consumeCreditsMock.mockResolvedValueOnce({
      chargedCents: 8n,
      shortfallCents: 0n,
      balanceCents: 992n,
      carryMicroCents: 0n,
    });

    const result = await chargeEvidenceRetention({
      orgId: "org-1",
      gbMonths: 1,
      optedIn: true,
    });

    expect(result.creditsCharged).toBe(8n);
    expect(consumeCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        reason: CREDIT_REASONS.CONSUME_RETENTION,
        referenceType: "evidence_retention",
      }),
    );
  });

  it("charges nothing for zero gb-months, without calling consumeCredits", async () => {
    const result = await chargeEvidenceRetention({
      orgId: "org-1",
      gbMonths: 0,
      optedIn: true,
    });
    expect(result.creditsCharged).toBe(0n);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });
});
