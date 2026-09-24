/**
 * Unit tests for negotiated-terms.ts: the one writer of billing.contract_terms.
 *
 * The table lives in an in-memory store behind a fake executor that evaluates
 * the `eq` / `and` / `isNull` conditions the writer builds, so an UPDATE that
 * closes the wrong row closes it here too. withTenantDb throws: the caller is
 * an unscoped platform-operator capability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cond } from "./test-utils/gau-conditions";

const state = vi.hoisted(() => ({
  tx: null as unknown,
  events: [] as string[],
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const withTenantDb = async () => {
    throw new Error("No active tenant scope");
  };
  return {
    ...real,
    withTenantDb,
    withOrgDb: withTenantDb,
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(state.tx),
  };
});

const { getTableColumns } = await import("drizzle-orm");
const { schema } = await import("@oxagen/database");
const { assertNegotiatedTerms, ContractTermsError, replaceNegotiatedTerms } =
  await import("./negotiated-terms");
type NegotiatedTerms = import("./negotiated-terms").NegotiatedTerms;

type Row = Record<string, unknown>;
const KEY = new Map<unknown, string>(
  Object.entries(getTableColumns(schema.contractTerms)).map(([k, c]) => [c, k]),
);
const keyOf = (col: unknown) => {
  const k = KEY.get(col);
  if (!k) throw new Error("fake tx: not a contract_terms column");
  return k;
};
function matches(row: Row, cond: Cond): boolean {
  if (cond.op === "and") return cond.conds.every((c) => matches(row, c));
  if (cond.op === "isNull") return row[keyOf(cond.col)] === null;
  if (cond.op === "eq") return row[keyOf(cond.col)] === cond.val;
  throw new Error(`fake tx: unmodelled condition ${cond.op}`);
}

let rows: Row[];

function makeTx() {
  const only = (t: unknown) => {
    if (t !== schema.contractTerms)
      throw new Error("fake tx: unexpected table");
  };
  return {
    execute: async () => {
      state.events.push("lock");
    },
    select: () => ({
      from: (t: unknown) => {
        only(t);
        let hit = rows;
        const chain = {
          where: (c: Cond) => {
            hit = hit.filter((r) => matches(r, c));
            return chain;
          },
          limit: async (n: number) => hit.slice(0, n).map((r) => ({ ...r })),
        };
        return chain;
      },
    }),
    update: (t: unknown) => {
      only(t);
      return {
        set: (patch: Row) => ({
          where: (c: Cond) => ({
            returning: async () => {
              const hit = rows.filter((r) => matches(r, c));
              for (const r of hit) Object.assign(r, patch);
              state.events.push("close");
              return hit.map((r) => ({ ...r }));
            },
          }),
        }),
      };
    },
    insert: (t: unknown) => {
      only(t);
      return {
        values: (v: Row) => ({
          returning: async () => {
            // The partial unique index: one open row per org.
            if (
              rows.some((r) => r.orgId === v.orgId && r.effectiveTo === null)
            ) {
              throw new Error(
                "duplicate key: contract_terms_org_effective_idx",
              );
            }
            const row = { id: crypto.randomUUID(), effectiveTo: null, ...v };
            rows.push(row);
            state.events.push("insert");
            return [{ ...row }];
          },
        }),
      };
    },
  };
}

const ORG = "0192d4a8-7c1e-7a00-8000-00000000e001";
const OTHER = "0192d4a8-7c1e-7a00-8000-00000000e002";
const JAN = new Date("2026-01-01T00:00:00.000Z");
const OCT = new Date("2026-10-01T00:00:00.000Z");

const terms = (over: Partial<NegotiatedTerms> = {}): NegotiatedTerms => ({
  orgId: ORG,
  agreementRef: "MSA-2026-014",
  currency: "usd",
  ratePerGauMicros: 3_000n,
  blockSizeGau: 10_000,
  includedGauPerMonth: 250_000,
  effectiveFrom: OCT,
  ...over,
});

function seedOpen(over: Row = {}) {
  const row = {
    id: crypto.randomUUID(),
    orgId: ORG,
    agreementRef: "MSA-2025-003",
    currency: "usd",
    ratePerGauMicros: 4_000n,
    blockSizeGau: 10_000,
    includedGauPerMonth: 100_000,
    effectiveFrom: JAN,
    effectiveTo: null,
    ...over,
  };
  rows.push(row);
  return row;
}

beforeEach(() => {
  rows = [];
  state.events = [];
  state.tx = makeTx();
});

describe("assertNegotiatedTerms", () => {
  const reason = (t: NegotiatedTerms) => {
    try {
      assertNegotiatedTerms(t);
      return null;
    } catch (err) {
      expect(err).toBeInstanceOf(ContractTermsError);
      return (err as InstanceType<typeof ContractTermsError>).reason;
    }
  };

  it("accepts terms whose block costs whole cents", () => {
    expect(reason(terms())).toBeNull();
    // 3,333 micros x 30,000 units = 99,990,000 micros = 9,999 cents.
    expect(
      reason(terms({ ratePerGauMicros: 3_333n, blockSizeGau: 30_000 })),
    ).toBeNull();
  });

  it("refuses a block that does not cost whole cents, the table's CHECK", () => {
    // 3,333 micros x 1,000 units = 3,333,000 micros: 333.3 cents.
    expect(
      reason(terms({ ratePerGauMicros: 3_333n, blockSizeGau: 1_000 })),
    ).toBe("block_not_whole_cents");
  });

  it.each([
    [{ agreementRef: " " }, "agreement_ref"],
    [{ currency: "US" }, "currency"],
    [{ ratePerGauMicros: -1n }, "rate"],
    [{ blockSizeGau: 0 }, "block_size"],
    [{ blockSizeGau: 2.5 }, "block_size"],
    [{ includedGauPerMonth: -1 }, "included"],
    [{ includedGauPerMonth: 2 ** 31 }, "included"],
    [{ effectiveFrom: new Date("nope") }, "effective_from"],
  ] as const)("refuses invalid case %#", (over, expected) => {
    expect(reason(terms(over as Partial<NegotiatedTerms>))).toBe(expected);
  });
});

describe("replaceNegotiatedTerms", () => {
  it("inserts the org's first agreement under the org's lock", async () => {
    const out = await replaceNegotiatedTerms(terms());

    expect(state.events).toEqual(["lock", "insert"]);
    expect(out.changed).toBe(true);
    expect(out.previous).toBeNull();
    expect(out.current).toMatchObject({
      orgId: ORG,
      agreementRef: "MSA-2026-014",
      ratePerGauMicros: 3_000n,
      blockSizeGau: 10_000,
      includedGauPerMonth: 250_000,
      effectiveFrom: OCT,
      effectiveTo: null,
    });
  });

  it("closes the open row at the new start and opens the new one, in that order", async () => {
    const old = seedOpen();

    const out = await replaceNegotiatedTerms(terms());

    expect(state.events).toEqual(["lock", "close", "insert"]);
    expect(old.effectiveTo).toEqual(OCT);
    expect(out.previous).toMatchObject({
      agreementRef: "MSA-2025-003",
      effectiveTo: OCT,
    });
    expect(rows.filter((r) => r.effectiveTo === null)).toHaveLength(1);
  });

  it("closes only this org's open row", async () => {
    const theirs = seedOpen({ orgId: OTHER });
    seedOpen();

    await replaceNegotiatedTerms(terms());

    expect(theirs.effectiveTo).toBeNull();
  });

  it("writes nothing when the open row already carries these terms", async () => {
    seedOpen({
      agreementRef: "MSA-2026-014",
      ratePerGauMicros: 3_000n,
      includedGauPerMonth: 250_000,
    });

    const out = await replaceNegotiatedTerms(
      terms({ effectiveFrom: new Date() }),
    );

    expect(out.changed).toBe(false);
    expect(state.events).toEqual(["lock"]);
    expect(rows).toHaveLength(1);
  });

  it("refuses terms that start at or before the open agreement's start", async () => {
    seedOpen({ effectiveFrom: OCT });

    await expect(
      replaceNegotiatedTerms(terms({ effectiveFrom: OCT })),
    ).rejects.toMatchObject({
      code: "invalid_contract_terms",
      reason: "starts_before_current",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effectiveTo).toBeNull();
  });

  it("validates before it takes the lock", async () => {
    await expect(
      replaceNegotiatedTerms(
        terms({ ratePerGauMicros: 3_333n, blockSizeGau: 1_000 }),
      ),
    ).rejects.toMatchObject({ reason: "block_not_whole_cents" });
    expect(state.events).toEqual([]);
  });
});
