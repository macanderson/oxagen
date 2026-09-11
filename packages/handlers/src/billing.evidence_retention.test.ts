/**
 * Unit tests for the get_evidence_retention handler
 * (billing.evidence_retention).
 *
 * Strategy: stub `withTenantDb` and queue the three reads the handler makes
 * inside it — settings, the pinned retention policies, the retention ledger.
 * The published constants stay real.
 *
 * The load-bearing case is the last one: an unmeasured evidence volume must
 * come back as null with `storedGbMeasured: false`. A zero there would read as
 * "you are storing nothing", which is a different claim and probably a false
 * one, and the contract's JSDoc calls it out by name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  RETENTION_INCLUDED_MONTHS,
  RETENTION_USD_PER_GB_MONTH,
} from "@oxagen/billing";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { billingEvidenceRetentionHandler } from "./billing.evidence_retention";
import { TEST_CTX } from "./test-utils/fixtures";

// ── tx stub ───────────────────────────────────────────────────────────────────

interface TxChain {
  select: () => TxChain;
  from: () => TxChain;
  where: () => TxChain;
  limit: () => TxChain;
  then: <T>(onFulfilled: (rows: unknown[]) => T) => Promise<T>;
}

/** Resolves to the next queued result set each time a chain is awaited. */
function makeTx(resultSets: unknown[][]): TxChain {
  let cursor = 0;
  const chain: TxChain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (onFulfilled) =>
      Promise.resolve(resultSets[cursor++] ?? []).then(onFulfilled),
  };
  return chain;
}

/** Queue, in order: settings rows, retention-policy rows, ledger rows. */
function queueDbReads(resultSets: unknown[][]): void {
  const tx = makeTx(resultSets);
  mocks.withTenantDb.mockImplementation(
    (fn: (t: TxChain) => Promise<unknown>) => fn(tx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billingEvidenceRetentionHandler", () => {
  it("reports the opted-in posture and validates against the contract", async () => {
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 365 }],
      [{ total: "-42" }],
    ]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    expect(out.includedMonths).toBe(RETENTION_INCLUDED_MONTHS);
    expect(out.usdPerGbMonth).toBe(RETENTION_USD_PER_GB_MONTH);
    expect(out.extendedRetentionEnabled).toBe(true);
    expect(out.effectiveRetentionDays).toBe(365);
    // A debit is a negative delta; the readout shows its magnitude.
    expect(out.creditsChargedThisPeriod).toBe(42);
  });

  it("treats a missing settings row as never opted in", async () => {
    queueDbReads([[], [{ maxTtlDays: 90 }], []]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    // Spec §7.4 — an absent row must never be read as consent to accrue.
    expect(out.extendedRetentionEnabled).toBe(false);
    expect(out.creditsChargedThisPeriod).toBe(0);
    expect(out.effectiveRetentionDays).toBe(90);
  });

  it("returns null, not zero, when no retention policy is pinned", async () => {
    // `max()` over an empty set is SQL NULL.
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: false }],
      [{ maxTtlDays: null }],
      [{ total: "0" }],
    ]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    // Null means "the organisation has not declared one", not "kept forever"
    // and not "zero days".
    expect(out.effectiveRetentionDays).toBeNull();
  });

  it("returns null for an organisation with no rows at all", async () => {
    queueDbReads([[], [], []]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    expect(out.effectiveRetentionDays).toBeNull();
    expect(out.extendedRetentionEnabled).toBe(false);
    expect(out.creditsChargedThisPeriod).toBe(0);
  });

  it("reports an unmeasured evidence volume as null rather than zero", async () => {
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 730 }],
      [{ total: "-8" }],
    ]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    // No accounting job measures evidence bytes per organisation yet. Null
    // says "not counted"; zero would say "you are storing nothing".
    expect(out.storedGbBeyondIncluded).toBeNull();
    expect(out.storedGbBeyondIncluded).not.toBe(0);
    expect(out.storedGbMeasured).toBe(false);
  });

  it("takes the longest window across the organisation's pinned policies", async () => {
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      // The query aggregates with max(); a fractional/string reading is floored.
      [{ maxTtlDays: "1095" }],
      [],
    ]);

    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);

    expect(() => billingEvidenceRetention.output.parse(out)).not.toThrow();
    expect(out.effectiveRetentionDays).toBe(1095);
  });
});
