/**
 * Unit tests for contract-terms.ts — resolveContractTerms and
 * resolveGauEntitlement (ADR-055 §3).
 *
 * The fake tx answers by the table it is asked to read from, so the tests do
 * not depend on the order the resolver issues its three selects in, and it
 * evaluates the effective-window WHERE on `contract_terms` (the drizzle
 * operators are mocked to plain objects), so "expired" and "future end" are
 * tested against the statement's own conditions. Every table read is
 * recorded so a test can assert the resolver never touches
 * `org.organizations` (plan_type is not a leg).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

type Cond =
  | { op: "eq" | "lte" | "gt"; col: unknown; val: unknown }
  | { op: "isNull"; col: unknown }
  | { op: "and" | "or"; conds: Cond[] }
  | { op: "inArray"; col: unknown; vals: unknown[] };

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (col: unknown, val: unknown): Cond => ({ op: "eq", col, val }),
    lte: (col: unknown, val: unknown): Cond => ({ op: "lte", col, val }),
    gt: (col: unknown, val: unknown): Cond => ({ op: "gt", col, val }),
    isNull: (col: unknown): Cond => ({ op: "isNull", col }),
    and: (...conds: Cond[]): Cond => ({ op: "and", conds }),
    or: (...conds: Cond[]): Cond => ({ op: "or", conds }),
    inArray: (col: unknown, vals: unknown[]): Cond => ({
      op: "inArray",
      col,
      vals,
    }),
    desc: (col: unknown) => ({ _desc: col }),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

const termsKeys = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.contractTerms)).map(([k, c]) => [c, k]),
);

function num(v: unknown): number {
  return v instanceof Date ? v.getTime() : (v as number);
}

/** Evaluate a mocked condition against a contract_terms row. */
function matches(row: Record<string, unknown>, cond: Cond): boolean {
  switch (cond.op) {
    case "and":
      return cond.conds.every((c) => matches(row, c));
    case "or":
      return cond.conds.some((c) => matches(row, c));
    case "inArray":
      return cond.vals.includes(row[termsKeys.get(cond.col)!]);
    case "isNull":
      return row[termsKeys.get(cond.col)!] === null;
    case "eq":
      return row[termsKeys.get(cond.col)!] === cond.val;
    case "lte":
      return num(row[termsKeys.get(cond.col)!]) <= num(cond.val);
    case "gt":
      return num(row[termsKeys.get(cond.col)!]) > num(cond.val);
  }
}

const { resolveContractTerms, resolveGauEntitlement, FREE_PLAN_SLUG } =
  await import("./contract-terms");

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-14T12:00:00.000Z");

/** When the seeded Free plan row was last written. */
const FREE_PLAN_WRITTEN = new Date("2026-09-14T00:00:00.000Z");
/** When the Scale plan row was last written — a different instant. */
const SCALE_PLAN_WRITTEN = new Date("2026-08-01T00:00:00.000Z");

const FREE_PLAN = {
  tier: "free",
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 5_000,
  updatedAt: FREE_PLAN_WRITTEN,
};

const SCALE_SUB = {
  tier: "scale",
  currency: "usd",
  ratePerGauMicros: 5_000n,
  blockSizeGau: 5_000,
  includedGauPerMonth: 300_000,
  updatedAt: SCALE_PLAN_WRITTEN,
  billingInterval: "year",
  currentPeriodStart: new Date("2026-01-31T00:00:00.000Z"),
  currentPeriodEnd: new Date("2027-01-31T00:00:00.000Z"),
};

const NEGOTIATED = {
  orgId: "org-1",
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
        let where: Cond | null = null;
        const chain = {
          innerJoin: (joinTable: unknown) => {
            tablesRead.push(joinTable);
            joined = true;
            return chain;
          },
          where: (cond: Cond) => {
            where = cond;
            return chain;
          },
          orderBy: () => chain,
          limit: () => {
            if (table === schema.contractTerms)
              return Promise.resolve(
                (rows.contractTerms as Record<string, unknown>[]).filter(
                  (r) => where === null || matches(r, where),
                ),
              );
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
    setup({
      contractTerms: [
        { ...NEGOTIATED, effectiveTo: new Date("2026-09-01T00:00:00.000Z") },
      ],
      entitled: [SCALE_SUB],
    });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms).toEqual({
      source: "published_tier",
      tier: "scale",
      currency: "usd",
      ratePerGauMicros: 5_000n,
      blockSizeGau: 5_000,
      includedGauPerMonth: 300_000,
      effectiveFrom: SCALE_PLAN_WRITTEN,
      effectiveTo: null,
    });
  });

  it("a negotiated row that has not started yet does not answer", async () => {
    setup({
      contractTerms: [
        { ...NEGOTIATED, effectiveFrom: new Date("2026-10-01T00:00:00.000Z") },
      ],
      entitled: [SCALE_SUB],
    });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms.source).toBe("published_tier");
  });

  it("another org's negotiated row never answers for this org", async () => {
    setup({ contractTerms: [{ ...NEGOTIATED, orgId: "org-2" }] });
    const terms = await resolveContractTerms("org-1", NOW);
    expect(terms.source).toBe("published_tier");
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
    expect(terms).toEqual({
      source: "published_tier",
      tier: FREE_PLAN.tier,
      currency: FREE_PLAN.currency,
      ratePerGauMicros: FREE_PLAN.ratePerGauMicros,
      blockSizeGau: FREE_PLAN.blockSizeGau,
      includedGauPerMonth: FREE_PLAN.includedGauPerMonth,
      effectiveFrom: FREE_PLAN_WRITTEN,
      effectiveTo: null,
    });
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
