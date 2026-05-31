/**
 * Unit tests for consumeCredits (packages/billing/src/credits.ts) — the atomic
 * clamped debit behind the usage gate.
 *
 * Mocks the DB transaction seam and the drizzle helpers (we assert on the mock
 * tx call args, not generated SQL). The invariant under test: the debit is
 * clamped to the locked balance so credit_balances.balance_cents never goes
 * negative, a fully-clamped/zero debit writes NO ledger row, and the shortfall
 * is reported.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
  and: (...args: unknown[]) => ({ _and: args }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ _sql: [strings, vals] }),
}));

const state: { balance: bigint | null; ledgerInserts: Array<Record<string, unknown>>; balanceUpdated: boolean } = {
  balance: null,
  ledgerInserts: [],
  balanceUpdated: false,
};

function makeTx() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          for: vi.fn(async () => (state.balance === null ? [] : [{ balanceCents: state.balance }])),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        state.ledgerInserts.push(v);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            state.balanceUpdated = true;
            return [{ balanceCents: state.balance ?? 0n }];
          }),
        })),
      })),
    })),
  };
}

vi.mock("@oxagen/database", () => ({
  db: () => ({
    transaction: (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => cb(makeTx()),
  }),
  schema: {
    creditBalances: { orgId: "cb.orgId", balanceCents: "cb.balanceCents" },
    creditLedger: { orgId: "cl.orgId" },
  },
}));

const { consumeCredits } = await import("../credits.js");

describe("consumeCredits", () => {
  beforeEach(() => {
    state.balance = null;
    state.ledgerInserts = [];
    state.balanceUpdated = false;
  });

  it("debits the full request when the balance covers it", async () => {
    state.balance = 1000n;
    const r = await consumeCredits({ orgId: "org-1", requestedCents: 20n, reason: "consume_token_overage" });
    expect(r.chargedCents).toBe(20n);
    expect(r.shortfallCents).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(1);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-20n);
    expect(state.balanceUpdated).toBe(true);
  });

  it("clamps to the locked balance and reports the shortfall (no overdraft)", async () => {
    state.balance = 5n;
    const r = await consumeCredits({ orgId: "org-1", requestedCents: 20n, reason: "consume_token_overage" });
    expect(r.chargedCents).toBe(5n);
    expect(r.shortfallCents).toBe(15n);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-5n);
  });

  it("writes no ledger row when the balance is zero", async () => {
    state.balance = 0n;
    const r = await consumeCredits({ orgId: "org-1", requestedCents: 20n, reason: "consume_token_overage" });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(20n);
    expect(state.ledgerInserts).toHaveLength(0);
    expect(state.balanceUpdated).toBe(false);
  });

  it("treats a missing balance row as zero", async () => {
    state.balance = null;
    const r = await consumeCredits({ orgId: "org-1", requestedCents: 7n, reason: "consume_token_overage" });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(7n);
    expect(state.ledgerInserts).toHaveLength(0);
  });

  it("returns a no-op for a non-positive request without opening a transaction", async () => {
    const r = await consumeCredits({ orgId: "org-1", requestedCents: 0n, reason: "consume_token_overage" });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(0);
  });

  it("rejects an invalid reason before touching the DB", async () => {
    await expect(
      consumeCredits({ orgId: "org-1", requestedCents: 5n, reason: "not_a_reason" }),
    ).rejects.toThrow("invalid credit reason");
    expect(state.ledgerInserts).toHaveLength(0);
  });
});
