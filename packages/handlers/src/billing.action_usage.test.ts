/**
 * Unit tests for the get_action_usage handler (billing.action_usage).
 *
 * Strategy: stub the two `@oxagen/billing` reads that touch Postgres
 * (`readActionCounter`, `resolveOrgActionEntitlement`), stub `withTenantDb` for
 * the ledger and audit-log reads, and stub ClickHouse's `sumTokenUsage`. The
 * pricing constants and band arithmetic stay REAL — a test that restated them
 * would keep passing through a price change.
 *
 * Covers:
 *  - happy path with overage, validated against the contract's output schema;
 *  - the zero-usage / no-counter-row case;
 *  - enterprise's null allowance falling back rather than reading as unlimited;
 *  - the per-capability breakdown: off by default, and dropping `noBillingGate`
 *    capabilities when on;
 *  - a ClickHouse outage costing the model-spend line, not the whole answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readActionCounter: vi.fn(),
  resolveOrgActionEntitlement: vi.fn(),
  sumTokenUsage: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    readActionCounter: mocks.readActionCounter,
    resolveOrgActionEntitlement: mocks.resolveOrgActionEntitlement,
  };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, sumTokenUsage: mocks.sumTokenUsage };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { actionPeriodStart } from "@oxagen/billing";
import { billingActionUsage } from "@oxagen/oxagen/contracts/billing.action_usage";
import { billingActionUsageHandler } from "./billing.action_usage";
import { TEST_CTX } from "./test-utils/fixtures";

// ── tx stub ───────────────────────────────────────────────────────────────────

/**
 * A drizzle-shaped builder that returns itself from every chained method and
 * resolves to the next queued result set when awaited. Awaiting is what pops
 * the queue, so a chain that is built but never awaited consumes nothing.
 */
interface TxChain {
  select: () => TxChain;
  from: () => TxChain;
  where: () => TxChain;
  groupBy: () => TxChain;
  orderBy: () => TxChain;
  limit: () => TxChain;
  then: <T>(onFulfilled: (rows: unknown[]) => T) => Promise<T>;
}

function makeTx(resultSets: unknown[][]): TxChain {
  let cursor = 0;
  const chain: TxChain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (onFulfilled) =>
      Promise.resolve(resultSets[cursor++] ?? []).then(onFulfilled),
  };
  return chain;
}

/** Queue the result sets the handler's `withTenantDb` calls will see, in order. */
function queueDbReads(resultSets: unknown[][]): void {
  const tx = makeTx(resultSets);
  mocks.withTenantDb.mockImplementation(
    (fn: (t: TxChain) => Promise<unknown>) => fn(tx),
  );
}

/** One `sum(delta_cents)` row. Debits are negative. */
function ledgerSum(deltaCents: number): unknown[] {
  return [{ total: String(deltaCents) }];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sumTokenUsage.mockResolvedValue([
    { metric: "executions", quantity: 12, costMicros: 4_200_000n },
  ]);
});

describe("billingActionUsageHandler", () => {
  it("reports an over-allowance period and validates against the contract", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 2_000_000,
      actionsCharged: 500_000,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "scale",
      includedActionsAnnual: null,
    });
    // 1: governed-action overage debits; 2: assistant-token debits.
    queueDbReads([ledgerSum(-9_000), ledgerSum(-250)]);

    const out = await billingActionUsageHandler(
      { includeBreakdown: false },
      TEST_CTX,
    );

    expect(() => billingActionUsage.output.parse(out)).not.toThrow();

    // Derived, not hard-coded: the entitlement window is the calendar year,
    // so a literal here would start failing on 1 January.
    expect(out.period.start).toBe(actionPeriodStart().toISOString());
    expect(new Date(out.period.end).getTime()).toBeGreaterThan(
      new Date(out.period.start).getTime(),
    );

    expect(out.actionsUsed).toBe(2_000_000);
    expect(out.actionsIncluded).toBe(1_500_000);
    expect(out.actionsWithinAllowance).toBe(1_500_000);
    expect(out.actionsCharged).toBe(500_000);
    expect(out.actionsRemaining).toBe(0);
    // 2M annual total lands in the 1M–5M band.
    expect(out.band.id).toBe("1m-5m");

    // Read back from the ledger, not recomputed: the figure charged.
    expect(out.creditsCharged).toBe(9_000);
    expect(out.creditsAtFinalBand).toBeGreaterThan(0);
    expect(out.bandTrueUpCredits).toBe(
      Math.max(0, out.creditsCharged - out.creditsAtFinalBand),
    );

    expect(out.modelSpend.reportedCostMicros).toBe(4_200_000);
    // §4.4 — the zero is the message, not an omission.
    expect(out.modelSpend.chargedCredits).toBe(0);
    expect(out.modelSpend.assistantTokenCredits).toBe(250);
    expect(out.byCapability).toEqual([]);
  });

  it("returns honest zeroes when the organisation has no counter row yet", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 0,
      actionsCharged: 0,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "free",
      includedActionsAnnual: null,
    });
    queueDbReads([[], []]);
    mocks.sumTokenUsage.mockResolvedValue([]);

    const out = await billingActionUsageHandler(
      { includeBreakdown: false },
      TEST_CTX,
    );

    expect(() => billingActionUsage.output.parse(out)).not.toThrow();
    expect(out.actionsUsed).toBe(0);
    expect(out.actionsWithinAllowance).toBe(0);
    expect(out.actionsCharged).toBe(0);
    expect(out.actionsIncluded).toBe(25_000);
    expect(out.actionsRemaining).toBe(25_000);
    expect(out.creditsCharged).toBe(0);
    expect(out.creditsAtFinalBand).toBe(0);
    expect(out.bandTrueUpCredits).toBe(0);
    expect(out.modelSpend.reportedCostMicros).toBe(0);
    expect(out.band.id).toBe("first-1m");
  });

  it("falls back to a bounded allowance for an enterprise plan with no stored figure", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 10,
      actionsCharged: 0,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "enterprise",
      includedActionsAnnual: null,
    });
    queueDbReads([[], []]);

    const out = await billingActionUsageHandler(
      { includeBreakdown: false },
      TEST_CTX,
    );

    expect(() => billingActionUsage.output.parse(out)).not.toThrow();
    // Never unlimited, and never zero: a missing negotiated figure lands on the
    // scale allowance.
    expect(out.actionsIncluded).toBe(1_500_000);
    expect(out.actionsRemaining).toBe(1_499_990);
    expect(out.actionsCharged).toBe(0);
  });

  it("returns the per-capability breakdown only when asked, dropping non-billable capabilities", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 900,
      actionsCharged: 0,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "build",
      includedActionsAnnual: null,
    });
    queueDbReads([
      ledgerSum(-3),
      [],
      [
        { capability: "send_message", actions: "500" },
        // Registered with noBillingGate: true — never accrues, so it must not
        // appear in an explanation of a bill.
        { capability: "get_action_usage", actions: "400" },
        // Not registered in this process: kept, because absence of a contract
        // module is not proof the capability is non-billable.
        { capability: "some_unregistered_capability", actions: "7" },
        { capability: null, actions: "3" },
      ],
    ]);

    const out = await billingActionUsageHandler(
      { includeBreakdown: true },
      TEST_CTX,
    );

    expect(() => billingActionUsage.output.parse(out)).not.toThrow();
    expect(out.byCapability).toEqual([
      { capability: "send_message", actions: 500 },
      { capability: "some_unregistered_capability", actions: 7 },
    ]);
    // Three ledger/audit reads when the breakdown is on, two when it is off.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(3);
  });

  it("skips the breakdown read entirely when includeBreakdown is false", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 5,
      actionsCharged: 0,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "build",
      includedActionsAnnual: null,
    });
    queueDbReads([[], []]);

    await billingActionUsageHandler({ includeBreakdown: false }, TEST_CTX);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("reports model spend as zero and logs when ClickHouse is unreachable", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 100,
      actionsCharged: 0,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "scale",
      includedActionsAnnual: null,
    });
    queueDbReads([[], []]);
    mocks.sumTokenUsage.mockRejectedValue(new Error("clickhouse down"));

    const out = await billingActionUsageHandler(
      { includeBreakdown: false },
      TEST_CTX,
    );

    // The outage costs one line, not the answer — and never an invented number.
    expect(() => billingActionUsage.output.parse(out)).not.toThrow();
    expect(out.modelSpend.reportedCostMicros).toBe(0);
    expect(out.actionsUsed).toBe(100);
  });

  it("clamps the band true-up to zero rather than reporting a negative", async () => {
    mocks.readActionCounter.mockResolvedValue({
      periodStart: new Date(Date.UTC(2026, 0, 1)),
      actionsUsed: 2_000_000,
      actionsCharged: 500_000,
    });
    mocks.resolveOrgActionEntitlement.mockResolvedValue({
      tier: "scale",
      includedActionsAnnual: null,
    });
    // A single trivial debit against a large single-band price.
    queueDbReads([ledgerSum(-1), []]);

    const out = await billingActionUsageHandler(
      { includeBreakdown: false },
      TEST_CTX,
    );

    expect(() => billingActionUsage.output.parse(out)).not.toThrow();
    expect(out.creditsCharged).toBe(1);
    expect(out.creditsAtFinalBand).toBeGreaterThan(1);
    expect(out.bandTrueUpCredits).toBe(0);
  });
});
