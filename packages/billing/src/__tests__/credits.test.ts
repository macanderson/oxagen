/**
 * Unit tests for grantCredits (packages/billing/src/credits.ts).
 *
 * Mocks at the DB adapter seam: we replace `@oxagen/database`'s `db()`
 * factory so no live Postgres connection is required.
 *
 * Scenarios:
 *  1. happy path — ledger insert + balance upsert called, balance returned
 *  2. negative delta (consumption) — accepted; balance decremented
 *  3. invalid reason — throws before touching DB
 *  4. atomicity contract — if the balance upsert rejects, the error propagates
 *     (transaction rollback semantics)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Shared mock transaction wiring ─────────────────────────────────────────

type TxFn = (tx: ReturnType<typeof makeTx>) => Promise<{ balanceCents: bigint }>;

/** Minimal query-builder chain returned by tx.insert().values()... */
function makeInsertChain(returnRows: Array<Record<string, unknown>> = []) {
  const chain = {
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returnRows),
  };
  return chain;
}

function makeTx(balanceRow: { balanceCents: bigint } = { balanceCents: 500n }) {
  const ledgerChain = {
    // creditLedger insert has no .returning() call in the source
    values: vi.fn().mockResolvedValue(undefined),
  };
  const balanceChain = makeInsertChain([balanceRow]);
  const insertMock = vi.fn((_table: unknown) => {
    // Distinguish by call count; we always return ledgerChain for the first
    // call and balanceChain for the second.
    const callCount = (insertMock.mock.calls.length);
    if (callCount === 1) return { values: vi.fn().mockReturnValue(undefined) };
    return { values: vi.fn().mockReturnValue(balanceChain) };
  });

  return {
    insert: insertMock,
    _ledgerChain: ledgerChain,
    _balanceChain: balanceChain,
  };
}

// Build a realistic transaction mock that captures the callback and executes it.
function makeDb(balanceRow: { balanceCents: bigint } = { balanceCents: 500n }) {
  // The creditLedger insert: values() resolves immediately (no .returning)
  // The creditBalances insert: values() → onConflictDoUpdate() → returning()

  let callIdx = 0;
  const insertFn = vi.fn(() => {
    callIdx++;
    if (callIdx === 1) {
      // First insert: creditLedger — chain is values() → void
      return {
        values: vi.fn().mockResolvedValue(undefined),
      };
    }
    // Second insert: creditBalances — chain ending in .returning()
    return {
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([balanceRow]),
        }),
      }),
    };
  });

  const txProxy = { insert: insertFn };

  return {
    transaction: vi.fn((cb: TxFn) => cb(txProxy as unknown as ReturnType<typeof makeTx>)),
    _txProxy: txProxy,
    _insertFn: insertFn,
  };
}

// ── Module mock ─────────────────────────────────────────────────────────────

vi.mock("@oxagen/database", () => {
  // We use a factory so each test can swap the singleton via the `__db` export.
  const state: { instance: ReturnType<typeof makeDb> | null } = { instance: null };
  return {
    db: () => state.instance,
    schema: {
      creditLedger: "creditLedger",
      creditBalances: "creditBalances",
    },
    __state: state,
  };
});

// Lazily import after mock registration.
const { grantCredits } = await import("../credits.js");
const { __state } = await import("@oxagen/database") as unknown as {
  __state: { instance: ReturnType<typeof makeDb> | null };
  db: () => ReturnType<typeof makeDb>;
  schema: Record<string, string>;
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("grantCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — returns new balance from DB after ledger + balance upsert", async () => {
    __state.instance = makeDb({ balanceCents: 1500n });

    const result = await grantCredits({
      orgId: "org-abc",
      deltaCents: 1000n,
      reason: "grant_signup",
    });

    expect(result.balanceCents).toBe(1500n);
    expect(__state.instance!.transaction).toHaveBeenCalledOnce();
  });

  it("negative delta (consumption) — accepted and balance returned", async () => {
    __state.instance = makeDb({ balanceCents: 400n });

    const result = await grantCredits({
      orgId: "org-abc",
      deltaCents: -100n,
      reason: "consume_execution",
    });

    expect(result.balanceCents).toBe(400n);
  });

  it("invalid reason — throws before any DB interaction", async () => {
    __state.instance = makeDb();

    await expect(
      grantCredits({
        orgId: "org-abc",
        deltaCents: 100n,
        reason: "not_a_real_reason",
      }),
    ).rejects.toThrow("invalid credit reason: not_a_real_reason");

    expect(__state.instance!.transaction).not.toHaveBeenCalled();
  });

  it("atomicity — if balance upsert throws, error propagates out of transaction", async () => {
    const dbInstance = makeDb();
    // Override so the second insert's returning() rejects.
    let callIdx = 0;
    dbInstance._txProxy.insert = vi.fn(() => {
      callIdx++;
      if (callIdx === 1) {
        return { values: vi.fn().mockResolvedValue(undefined) };
      }
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockRejectedValue(new Error("db constraint violation")),
          }),
        }),
      };
    }) as typeof dbInstance._txProxy.insert;

    __state.instance = dbInstance;

    await expect(
      grantCredits({
        orgId: "org-xyz",
        deltaCents: 50n,
        reason: "grant_manual",
      }),
    ).rejects.toThrow("db constraint violation");
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
    __state.instance = makeDb({ balanceCents: 0n });

    await expect(
      grantCredits({ orgId: "org-abc", deltaCents: 1n, reason }),
    ).resolves.toBeDefined();
  });
});
