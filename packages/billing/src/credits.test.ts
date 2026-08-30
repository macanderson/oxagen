/**
 * Unit tests for createCreditLot, grantCredits (shim), and effectiveBalance
 * (packages/billing/src/credits.ts).
 *
 * The lots model:
 *  - createCreditLot inserts a credit_lots row + credit_ledger row + upserts
 *    credit_balances, all in one transaction.
 *  - grantCredits (backward-compat shim) delegates to createCreditLot for
 *    positive deltas and consumeCredits for negative deltas.
 *  - effectiveBalance sums remaining_cents for non-expired lots (lazy expiry).
 *
 * No live Postgres — mocks at the DB adapter seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Drizzle mock (no-op wrappers so calls don't throw) ───────────────────────

// ── Shared mock state ─────────────────────────────────────────────────────────

interface MockState {
  // Lots returned by SELECT for effectiveBalance / createCreditLot balance step
  lots: Array<{ remaining: bigint }>;
  lotInsertRows: Array<Record<string, unknown>>;
  ledgerInserts: Array<Record<string, unknown>>;
  balanceUpserts: number;
  transactionCalled: boolean;
}

const state: MockState = {
  lots: [],
  lotInsertRows: [],
  ledgerInserts: [],
  balanceUpserts: 0,
  transactionCalled: false,
};

// Factory that builds a tx-like object for the transaction callback.
// Must support the full query chains used by both createCreditLot and
// consumeCredits (which is called by grantCredits for negative deltas).
function makeTx() {
  let insertCallCount = 0;
  return {
    insert: vi.fn(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // First insert: credit_lots → .returning([{ id: 'lot-id-1' }])
        return {
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "lot-id-1" }]),
          }),
        };
      }
      if (insertCallCount === 2) {
        // Second insert: credit_ledger → no returning
        return {
          values: vi
            .fn()
            .mockImplementation(async (v: Record<string, unknown>) => {
              state.ledgerInserts.push(v);
            }),
        };
      }
      // Third insert: credit_balances → .onConflictDoUpdate()
      state.balanceUpserts++;
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }),
    // Supports both:
    //   createCreditLot: .select().from().where() → state.lots
    //   consumeCredits:  .select().from().where().orderBy().for() → state.lots
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          // For effectiveBalance / createCreditLot inner SELECT (resolved directly)
          then: (resolve: (v: typeof state.lots) => unknown) =>
            resolve(state.lots),
          // For consumeCredits SELECT (chained with .orderBy().for())
          orderBy: vi.fn(() => ({
            for: vi.fn(async () => state.lots),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  };
}

// Top-level db() mock — exposes __state for cross-test mutation.
const dbState: { instance: ReturnType<typeof buildDb> | null } = {
  instance: null,
};

function buildDb() {
  return {
    transaction: vi.fn(
      async (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        state.transactionCalled = true;
        return cb(makeTx());
      },
    ),
    // effectiveBalance uses db().select()... directly (not via transaction)
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(state.lots),
      })),
    })),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbState.instance,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      dbState.instance?.transaction(fn),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      dbState.instance?.transaction(fn),
    __dbState: dbState,
  };
});

// consumeCredits is imported transitively by grantCredits (negative delta).
// We mock it here to keep these tests isolated to createCreditLot / effectiveBalance.
vi.mock("./credits", async (importOriginal) => {
  // We can't easily partial-mock a module we're testing; instead rely on the
  // module's own implementation. This mock is only for the consumeCredits
  // import WITHIN grantCredits, but since both live in credits.ts we test
  // them at the module level below. No need to stub here.
  return importOriginal<typeof import("./credits")>();
});

const { createCreditLot, grantCredits, effectiveBalance } = await import(
  "./credits"
);
const { __dbState } = (await import("@oxagen/database")) as unknown as {
  __dbState: typeof dbState;
};

// ── helpers ───────────────────────────────────────────────────────────────────

function resetState() {
  state.lots = [];
  state.lotInsertRows = [];
  state.ledgerInserts = [];
  state.balanceUpserts = 0;
  state.transactionCalled = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// createCreditLot
// ─────────────────────────────────────────────────────────────────────────────

describe("createCreditLot", () => {
  beforeEach(() => {
    resetState();
    __dbState.instance = buildDb();
  });

  it("happy path — returns lotId and effectiveBalanceCents", async () => {
    state.lots = [{ remaining: 500n }]; // simulates post-insert SELECT

    const result = await createCreditLot({
      orgId: "org-abc",
      amountCents: 500n,
      source: "free_grant",
      expiresAt: null,
      reason: "grant_signup",
    });

    expect(result.lotId).toBe("lot-id-1");
    expect(result.effectiveBalanceCents).toBe(500n);
    expect(state.transactionCalled).toBe(true);
    expect(state.ledgerInserts).toHaveLength(1);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(500n);
    expect(state.balanceUpserts).toBe(1);
  });

  it("rejects amountCents <= 0", async () => {
    await expect(
      createCreditLot({
        orgId: "org-abc",
        amountCents: 0n,
        source: "purchase",
        expiresAt: null,
        reason: "grant_credit_pack",
      }),
    ).rejects.toThrow("amountCents must be greater than zero");
    expect(state.transactionCalled).toBe(false);
  });

  it("rejects invalid reason before touching DB", async () => {
    await expect(
      createCreditLot({
        orgId: "org-abc",
        amountCents: 10n,
        source: "purchase",
        expiresAt: null,
        reason: "not_valid",
      }),
    ).rejects.toThrow("invalid credit reason: not_valid");
    expect(state.transactionCalled).toBe(false);
  });

  it("records the ledger entry with the correct deltaCents and reason", async () => {
    state.lots = [{ remaining: 200n }];

    await createCreditLot({
      orgId: "org-xyz",
      amountCents: 200n,
      source: "subscription",
      expiresAt: new Date("2026-06-30T23:59:59Z"),
      reason: "grant_plan_renewal",
      referenceType: "stripe_invoice",
      referenceId: "inv-uuid-1",
    });

    expect(state.ledgerInserts[0]!.deltaCents).toBe(200n);
    expect(state.ledgerInserts[0]!.reason).toBe("grant_plan_renewal");
    expect(state.ledgerInserts[0]!.referenceType).toBe("stripe_invoice");
    expect(state.ledgerInserts[0]!.referenceId).toBe("inv-uuid-1");
  });

  it.each([
    "grant_signup",
    "grant_plan_renewal",
    "grant_credit_pack",
    "grant_manual",
  ] as const)("accepts allowed grant reason: %s", async (reason) => {
    state.lots = [{ remaining: 1n }];
    await expect(
      createCreditLot({
        orgId: "org-abc",
        amountCents: 1n,
        source: "free_grant",
        expiresAt: null,
        reason,
      }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// effectiveBalance
// ─────────────────────────────────────────────────────────────────────────────

describe("effectiveBalance", () => {
  beforeEach(() => {
    resetState();
    __dbState.instance = buildDb();
  });

  it("sums remaining_cents across all non-expired lots", async () => {
    state.lots = [{ remaining: 100n }, { remaining: 200n }, { remaining: 50n }];
    expect(await effectiveBalance("org-1")).toBe(350n);
  });

  it("returns 0 when there are no lots", async () => {
    state.lots = [];
    expect(await effectiveBalance("org-1")).toBe(0n);
  });

  it("returns 0 when all lots have zero remaining", async () => {
    state.lots = [{ remaining: 0n }, { remaining: 0n }];
    expect(await effectiveBalance("org-1")).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// grantCredits (backward-compat shim)
// ─────────────────────────────────────────────────────────────────────────────

describe("grantCredits shim", () => {
  beforeEach(() => {
    resetState();
    __dbState.instance = buildDb();
  });

  it("positive delta — delegates to createCreditLot and returns effective balance", async () => {
    state.lots = [{ remaining: 1000n }];

    const result = await grantCredits({
      orgId: "org-abc",
      deltaCents: 1000n,
      reason: "grant_signup",
    });

    expect(result.balanceCents).toBe(1000n);
    expect(state.transactionCalled).toBe(true);
  });

  it("invalid reason — throws before any DB interaction", async () => {
    await expect(
      grantCredits({
        orgId: "org-abc",
        deltaCents: 100n,
        reason: "not_a_real_reason",
      }),
    ).rejects.toThrow("invalid credit reason: not_a_real_reason");

    expect(state.transactionCalled).toBe(false);
  });

  it.each([
    "grant_signup",
    "grant_plan_renewal",
    "grant_manual",
    "consume_execution",
    "consume_tool_call",
    "consume_token_overage",
    "refund",
    "adjustment",
  ] as const)("accepts allowed reason: %s", async (reason) => {
    // For consumption reasons the shim delegates to consumeCredits, which
    // opens a transaction and scans lots. Use an empty lots array so the
    // scan returns 0n available — charge = 0, no overdraft, resolves fine.
    // For grant reasons, state.lots drives the effective-balance SELECT.
    state.lots = [];
    const isConsume =
      reason.startsWith("consume") ||
      reason === "refund" ||
      reason === "adjustment";
    if (!isConsume) {
      // Positive grant: effective-balance SELECT returns 0n after the lot insert.
      await expect(
        grantCredits({ orgId: "org-abc", deltaCents: 1n, reason }),
      ).resolves.toBeDefined();
    } else {
      // Negative delta → consumeCredits path. Empty lots → shortfall only, no error.
      await expect(
        grantCredits({ orgId: "org-abc", deltaCents: -1n, reason }),
      ).resolves.toBeDefined();
    }
  });
});
