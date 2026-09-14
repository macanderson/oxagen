/**
 * Unit tests for contract-terms.ts — resolveContractTerms and
 * resolveGauEntitlement (ADR-055 §3).
 *
 * The fake tx answers by the table it is asked to read from, so the tests do
 * not depend on the order the resolver issues its three selects in. Every
 * `where` argument is recorded so a test can assert which tables were read —
 * the resolver must never touch `org.organizations` (plan_type is not a leg).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

const { resolveContractTerms, resolveGauEntitlement, FREE_PLAN_SLUG } =
  await import("./contract-terms");

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-14T12:00:00.000Z");

const FREE_PLAN = {
  tier: "free",
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
};

const SCALE_SUB = {
  tier: "scale",
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 300_000,
  billingInterval: "year",
  currentPeriodStart: new Date("2026-01-31T00:00:00.000Z"),
  currentPeriodEnd: new Date("2027-01-31T00:00:00.000Z"),
};

const NEGOTIATED = {
  agreementRef: "MSA-2026-017",
  currency: "usd",
  ratePerGauMicros: 4_000n,
  blockSizeGau: 10_000,
  includedGauPerMonth: 1_000_000,
  effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
  effectiveTo: null as Date | null,
};

type Rows = {
  contractTerms: unknown[];
  entitled: unknown[];
  free: unknown[];
};

const tablesRead: unknown[] = [];

/**
 * A select chain that answers by table. `plans` is read twice by the resolver
 * — once through the subscription join and once alone for the Free row — so
 * the fake tells them apart by whether `.innerJoin` was called.
 */
function makeTx(rows: Rows) {
  return {
    select: () => ({
      from: (table: unknown) => {
        tablesRead.push(table);
        let joined = false;
        const chain = {
          innerJoin: (joinTable: unknown) => {
            tablesRead.push(joinTable);
            joined = true;
            return chain;
          },
          where: () => chain,
          orderBy: () => chain,
          limit: () => {
            if (table === schema.contractTerms)
              return Promise.resolve(rows.contractTerms);
            if (table === schema.subscriptions && joined)
              return Promise.resolve(rows.entitled);
            if (table === schema.plans) return Promise.resolve(rows.free);
            return Promise.reject(new Error("unexpected table"));
          },
        };
        return chain;
      },
    }),
  };
}

function setup(overrides: Partial<Rows> = {}) {
  const rows: Rows = {
    contractTerms: [],
    entitled: [],
    free: [FREE_PLAN],
    ...overrides,
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(rows))),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  tablesRead.length = 0;
});

// ── the fallback chain ────────────────────────────────────────────────────────

describe("resolveContractTerms — which row answers", () => {
  it("a negotiated row in force wins over the entitled plan", async () => {
    setup({ contractTerms: [NEGOTIATED], entitled: [SCALE_SUB] });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms).toEqual({
      source: "negotiated",
      tier: "scale",
      agreementRef: "MSA-2026-017",
      currency: "usd",
      ratePerGauMicros: 4_000n,
      blockSizeGau: 10_000,
      includedGauPerMonth: 1_000_000,
      effectiveFrom: NEGOTIATED.effectiveFrom,
      effectiveTo: null,
    });
  });

  it("a negotiated row with a future effective_to is still in force", async () => {
    setup({
      contractTerms: [
        { ...NEGOTIATED, effectiveTo: new Date("2027-06-01T00:00:00.000Z") },
      ],
      entitled: [SCALE_SUB],
    });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms.source).toBe("negotiated");
  });

  it("an expired negotiated row falls back to the entitled plan's published terms", async () => {
    // The query filters expired rows out (effective_to <= now), so the fake
    // returns none for contract_terms; the assertion is on the fallback.
    setup({ contractTerms: [], entitled: [SCALE_SUB] });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms).toEqual({
      source: "published_tier",
      tier: "scale",
      currency: "usd",
      ratePerGauMicros: 5_000n,
      blockSizeGau: 5_000,
      includedGauPerMonth: 300_000,
    });
  });

  it("a plan change is reflected on the next call — nothing is cached", async () => {
    setup({
      entitled: [{ ...SCALE_SUB, tier: "build", includedGauPerMonth: 50_000 }],
    });
    const before = await resolveContractTerms("org-1", NOW);
    expect(before.tier).toBe("build");
    expect(before.includedGauPerMonth).toBe(50_000);

    setup({ entitled: [SCALE_SUB] });
    const after = await resolveContractTerms("org-1", NOW);
    expect(after.tier).toBe("scale");
    expect(after.includedGauPerMonth).toBe(300_000);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("an org with no entitled subscription gets the Free plan's published terms", async () => {
    setup();
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms).toEqual({ source: "published_tier", ...FREE_PLAN });
  });

  it("a legacy organizations.plan_type row resolves through its subscription or Free, never through plan_type", async () => {
    // No subscription: whatever organizations.plan_type says, the answer is
    // Free, and the organizations table is never read.
    setup();
    const terms = await resolveContractTerms("org-legacy", NOW);
    expect(terms.tier).toBe("free");
    expect(tablesRead).not.toContain(schema.organizations);
    expect(tablesRead).toEqual(
      expect.arrayContaining([
        schema.contractTerms,
        schema.subscriptions,
        schema.plans,
      ]),
    );
  });

  it("a subscription on an unrecognised tier falls back to the Free plan rather than trusting it", async () => {
    setup({ entitled: [{ ...SCALE_SUB, tier: "legacy_unknown" }] });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms.tier).toBe("free");
    expect(terms.includedGauPerMonth).toBe(FREE_PLAN.includedGauPerMonth);
  });

  it("throws when the Free plan row is not seeded and nothing else answers", async () => {
    setup({ free: [] });
    await expect(resolveContractTerms("org-1", NOW)).rejects.toThrow(
      /Free plan row is not seeded/,
    );
  });

  it("normalises the driver's column types: micros to bigint, counts to number", async () => {
    setup({
      entitled: [
        {
          ...SCALE_SUB,
          ratePerGauMicros: "5000" as unknown as bigint,
          blockSizeGau: "5000" as unknown as number,
          includedGauPerMonth: "300000" as unknown as number,
        },
      ],
    });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms.ratePerGauMicros).toBe(5_000n);
    expect(terms.blockSizeGau).toBe(5_000);
    expect(terms.includedGauPerMonth).toBe(300_000);
  });

  it("looks the Free plan up by the seeded slug", () => {
    expect(FREE_PLAN_SLUG).toBe("free");
  });
});

// ── the subscription beside the terms ─────────────────────────────────────────

describe("resolveGauEntitlement — the subscription for periodFor", () => {
  it("carries the entitled subscription's interval and period", async () => {
    setup({ entitled: [SCALE_SUB] });
    const { subscription } = await resolveGauEntitlement("org-1", NOW);
    expect(subscription).toEqual({
      billingInterval: "year",
      currentPeriodStart: SCALE_SUB.currentPeriodStart,
      currentPeriodEnd: SCALE_SUB.currentPeriodEnd,
    });
  });

  it("reads any interval that is not 'year' as 'month'", async () => {
    setup({ entitled: [{ ...SCALE_SUB, billingInterval: "month" }] });
    const { subscription } = await resolveGauEntitlement("org-1", NOW);
    expect(subscription?.billingInterval).toBe("month");
  });

  it("is null for an org with no entitled subscription", async () => {
    setup();
    const { subscription } = await resolveGauEntitlement("org-1", NOW);
    expect(subscription).toBeNull();
  });

  it("resolves terms and subscription in ONE tenant-scoped round trip", async () => {
    setup({ contractTerms: [NEGOTIATED], entitled: [SCALE_SUB] });
    await resolveGauEntitlement("org-1", NOW);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
