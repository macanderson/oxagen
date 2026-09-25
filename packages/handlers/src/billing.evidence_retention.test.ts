/**
 * Unit tests for the get_evidence_retention handler
 * (billing.evidence_retention).
 *
 * Strategy: stub `withSystemDb` and queue the three reads the handler makes
 * inside it — settings, the pinned retention policies, the retention ledger.
 * The published constants stay real.
 *
 * `withSystemDb` is the seam because the policy read is deliberately
 * organisation-wide — "the longest window ANY pinned policy declares" — over
 * `evidence.retention_policy_versions`, whose policy class is `standard`. A
 * tenant-scoped read could only ever see one workspace's policies, and under
 * the org-only workspace sentinel none at all; max() over the empty set is SQL
 * NULL, which this handler documents as "no policy pinned". `withTenantDb` is
 * mocked inert so that regression fails here.
 *
 * The load-bearing case is the last one: an unmeasured evidence volume must
 * come back as null with `storedGbMeasured: false`. A zero there would read as
 * "you are storing nothing", which is a different claim and probably a false
 * one, and the contract's JSDoc calls it out by name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The handler's role gate (#4194) runs for real against a role fixture. The
// default caller is an org Owner; a case that needs another sets roleGate.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(() => undefined),
  resolveDataPlane: vi.fn(),
}));

vi.mock("@oxagen/tenancy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/tenancy")>();
  return { ...real, resolveDataPlane: mocks.resolveDataPlane };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
  mocks.withSystemDb.mockImplementation(
    (fn: (t: TxChain) => Promise<unknown>) => fn(tx),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // ADR-042 §1: absence of a binding row means the shared plane, which is what
  // every organisation is today. `status` matters: assertDataPlaneUsable
  // refuses anything that is not active, which is the kill switch withTenantDb
  // used to apply on this handler's behalf.
  mocks.resolveDataPlane.mockResolvedValue({
    orgId: TEST_CTX.orgId,
    kind: "postgres",
    mode: "shared",
    status: "active",
  });
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

describe("the organisation-wide policy read", () => {
  it("reads through the system seam, never the tenant-scoped one", async () => {
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 365 }],
      [{ total: "0" }],
    ]);
    await billingEvidenceRetentionHandler({}, TEST_CTX);
    expect(mocks.withSystemDb).toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("reports the longest window pinned anywhere in the organisation", async () => {
    // Two workspaces' policies in one answer, which is what the contract asks
    // for and what a workspace-scoped read could not return.
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 730 }],
      [{ total: "0" }],
    ]);
    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);
    expect(out.effectiveRetentionDays).toBe(730);
  });
});

describe("the data plane the evidence aggregate reads (ADR-042)", () => {
  it("reads the shared plane, which is where every organisation is today", async () => {
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 365 }],
      [{ total: "0" }],
    ]);
    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);
    expect(out.effectiveRetentionDays).toBe(365);
    expect(mocks.resolveDataPlane).toHaveBeenCalledWith(
      TEST_CTX.orgId,
      "postgres",
    );
  });

  it("refuses for a dedicated plane rather than reporting no policy pinned", async () => {
    // withSystemDb ALWAYS opens the shared-plane singleton and never consults
    // the resolver, and ADR-042 §2 names evidence as tenant data a dedicated
    // plane carries. A shared-plane read for such an organisation finds no
    // policies, and max() over the empty set is NULL, which this handler
    // documents as "no policy pinned" — the same wrong answer the workspace
    // narrowing produced, by a different route.
    mocks.resolveDataPlane.mockResolvedValue({
      orgId: TEST_CTX.orgId,
      kind: "postgres",
      mode: "dedicated",
      status: "active",
    });
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 365 }],
      [{ total: "0" }],
    ]);
    await expect(billingEvidenceRetentionHandler({}, TEST_CTX)).rejects.toThrow(
      /dedicated Postgres plane/,
    );
  });

  it("reads nothing at all when it refuses", async () => {
    mocks.resolveDataPlane.mockResolvedValue({
      orgId: TEST_CTX.orgId,
      kind: "postgres",
      mode: "dedicated",
      status: "active",
    });
    queueDbReads([[], [], []]);
    await expect(
      billingEvidenceRetentionHandler({}, TEST_CTX),
    ).rejects.toThrow();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("the data-plane kill switch", () => {
  const plane = (status: string) => ({
    orgId: TEST_CTX.orgId,
    kind: "postgres" as const,
    mode: "shared" as const,
    status,
  });

  it.each(["degraded", "disabled"])(
    "refuses a shared binding an operator marked %s",
    async (status) => {
      // withTenantDb resolved the plane AND called assertDataPlaneUsable.
      // Standing in for it with a mode check alone kept the first guarantee and
      // dropped the second, so a plane an operator had explicitly disabled was
      // readable anyway — the kill switch, bypassed.
      mocks.resolveDataPlane.mockResolvedValue(plane(status));
      queueDbReads([[], [], []]);
      await expect(
        billingEvidenceRetentionHandler({}, TEST_CTX),
      ).rejects.toThrow();
      expect(mocks.withSystemDb).not.toHaveBeenCalled();
    },
  );

  it("reads an active shared binding", async () => {
    mocks.resolveDataPlane.mockResolvedValue(plane("active"));
    queueDbReads([
      [{ extendedEvidenceRetentionEnabled: true }],
      [{ maxTtlDays: 30 }],
      [{ total: "0" }],
    ]);
    const out = await billingEvidenceRetentionHandler({}, TEST_CTX);
    expect(out.effectiveRetentionDays).toBe(30);
  });

  it("names the plane mode, not the status, for a disabled DEDICATED plane", async () => {
    // A dedicated plane cannot be read here whatever its status, so that is the
    // cause worth reporting.
    mocks.resolveDataPlane.mockResolvedValue({
      ...plane("disabled"),
      mode: "dedicated" as const,
    });
    queueDbReads([[], [], []]);
    await expect(billingEvidenceRetentionHandler({}, TEST_CTX)).rejects.toThrow(
      /dedicated Postgres plane/,
    );
  });
});
