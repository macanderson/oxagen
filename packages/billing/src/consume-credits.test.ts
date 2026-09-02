/**
 * Unit tests for consumeCredits (packages/billing/src/credits.ts) — the
 * lot-based, soonest-expiring-first atomic debit.
 *
 * The new model:
 *  - Credits live in credit_lots rows with source + optional expires_at.
 *  - consumeCredits drains lots in SOONEST-EXPIRING-FIRST order
 *    (expires_at NULLS LAST — non-expiring lots are consumed last).
 *  - The balance floor is 0: never overdraft across all lots combined.
 *  - Expired lots are excluded from both the available balance and debit.
 *  - A fully-clamped / zero debit writes NO credit_ledger row.
 *
 * Mocks the DB transaction seam. Assertions are on mock call args and the
 * returned result — no live Postgres needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

interface Lot {
  id: string;
  remainingCents: bigint;
  expiresAt: Date | null;
}

const state: {
  lots: Lot[];
  ledgerInserts: Array<Record<string, unknown>>;
  // IDs of credit_lots rows that were updated (excluding credit_balances updates)
  lotUpdateIds: string[];
  balanceUpdateCount: number;
} = {
  lots: [],
  ledgerInserts: [],
  lotUpdateIds: [],
  balanceUpdateCount: 0,
};

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

// The mock schema — we distinguish tables by the string value of the schema key.
const SCHEMA = {
  creditLots: {
    orgId: "cl.orgId",
    remainingCents: "cl.remainingCents",
    expiresAt: "cl.expiresAt",
    id: "cl.id",
  },
  creditLedger: { orgId: "led.orgId" },
  creditBalances: { orgId: "cb.orgId", balanceCents: "cb.balanceCents" },
} as const;

function makeTx() {
  return {
    // SELECT … FROM credit_lots … FOR UPDATE
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            for: vi.fn(async () =>
              state.lots.map((l) => ({
                id: l.id,
                remainingCents: l.remainingCents,
                expiresAt: l.expiresAt,
              })),
            ),
          })),
        })),
      })),
    })),

    // UPDATE — may target credit_lots or credit_balances.
    // We distinguish by the table argument: credit_lots has .id field,
    // credit_balances has .orgId field but no .id field.
    update: vi.fn((table: unknown) => {
      const isCreditLots = table === SCHEMA.creditLots;
      return {
        set: vi.fn((_fields: Record<string, unknown>) => ({
          where: vi.fn((cond: { _eq?: unknown[] }) => {
            if (isCreditLots) {
              // cond._eq[1] is the lot id value from eq(schema.creditLots.id, lot.id)
              const lotId = (cond?._eq?.[1] as string) ?? "unknown";
              state.lotUpdateIds.push(lotId);
            } else {
              state.balanceUpdateCount++;
            }
            return Promise.resolve();
          }),
        })),
      };
    }),

    // INSERT — either credit_ledger (no returning) or credit_balances (balance upsert).
    insert: vi.fn(() => ({
      values: vi.fn(async (v: Record<string, unknown>) => {
        state.ledgerInserts.push(v);
      }),
    })),
  };
}

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      transaction: (cb: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) =>
        cb(makeTx()),
    }),
    withTenantDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    withSystemDb: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    schema: SCHEMA,
  };
});

const { consumeCredits } = await import("./credits");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = new Date();
const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 days

function makeLot(
  id: string,
  remaining: bigint,
  expiresAt: Date | null = null,
): Lot {
  return { id, remainingCents: remaining, expiresAt };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("consumeCredits — lots model", () => {
  beforeEach(() => {
    state.lots = [];
    state.ledgerInserts = [];
    state.lotUpdateIds = [];
    state.balanceUpdateCount = 0;
  });

  // ── basic debit ──────────────────────────────────────────────────────────

  it("debits the full request when total lot balance covers it", async () => {
    state.lots = [makeLot("lot-1", 1000n)];
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(20n);
    expect(r.shortfallCents).toBe(0n);
    expect(r.balanceCents).toBe(980n); // 1000 - 20
    expect(state.ledgerInserts).toHaveLength(1);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-20n);
    expect(state.lotUpdateIds).toHaveLength(1);
    expect(state.lotUpdateIds[0]).toBe("lot-1");
  });

  // ── no-overdraft ─────────────────────────────────────────────────────────

  it("clamps the charge to total lot balance (no overdraft)", async () => {
    state.lots = [makeLot("lot-1", 5n)];
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(5n);
    expect(r.shortfallCents).toBe(15n);
    expect(r.balanceCents).toBe(0n);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-5n);
  });

  it("writes no ledger row and returns zero charge when all lots are empty", async () => {
    state.lots = [makeLot("lot-1", 0n)];
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(20n);
    expect(state.ledgerInserts).toHaveLength(0);
    expect(state.lotUpdateIds).toHaveLength(0);
  });

  it("returns no-op for a non-positive request without opening a transaction", async () => {
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 0n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(0);
  });

  it("treats missing lots (no rows) as zero balance", async () => {
    state.lots = []; // no lots
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 7n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(7n);
    expect(state.ledgerInserts).toHaveLength(0);
  });

  // ── soonest-expiring-first ordering ─────────────────────────────────────

  it("drains the soonest-expiring lot first (expiring before non-expiring)", async () => {
    // Lot A expires in 30 days; Lot B never expires.
    // The DB mock returns lots in the order we add them to state.lots,
    // simulating ORDER BY expires_at ASC NULLS LAST.
    const lotA = makeLot("lot-A", 10n, future); // expires soon → drained first
    const lotB = makeLot("lot-B", 500n, null); // never expires → drained last
    state.lots = [lotA, lotB];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 15n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(15n);
    expect(r.shortfallCents).toBe(0n);
    // Lot A (10n) fully drained, then 5n drawn from Lot B.
    expect(state.lotUpdateIds).toHaveLength(2);
    expect(state.lotUpdateIds[0]).toBe("lot-A");
    expect(state.lotUpdateIds[1]).toBe("lot-B");
  });

  it("draws only from the first lot when it covers the full request", async () => {
    const lotA = makeLot("lot-A", 50n, future);
    const lotB = makeLot("lot-B", 500n, null);
    state.lots = [lotA, lotB];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 30n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(30n);
    // Only lot-A was touched (remaining was broken before iterating lot-B).
    expect(state.lotUpdateIds).toHaveLength(1);
    expect(state.lotUpdateIds[0]).toBe("lot-A");
  });

  // ── lazy expiry ──────────────────────────────────────────────────────────

  it("excludes expired lots from the available balance (lazy expiry)", async () => {
    // The DB WHERE clause excludes expired lots; in this mock state.lots
    // simulates the post-filter result. Only the live lot is visible.
    const liveLot = makeLot("lot-live", 100n, future);
    state.lots = [liveLot]; // expired lot already excluded by WHERE

    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 50n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(50n);
    expect(r.balanceCents).toBe(50n); // only the live lot's balance
  });

  it("reports zero balance and zero charge when all lots are expired", async () => {
    state.lots = []; // all expired → none returned by WHERE
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 100n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(0n);
    expect(r.shortfallCents).toBe(100n);
    expect(state.ledgerInserts).toHaveLength(0);
  });

  // ── free (non-expiring) lots consumed last ───────────────────────────────

  it("consumes non-expiring (free) lots after expiring ones", async () => {
    // Two expiring lots, then a non-expiring lot (NULLS LAST order).
    const soonLot = makeLot(
      "lot-soon",
      10n,
      new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000),
    );
    const laterLot = makeLot("lot-later", 10n, future);
    const freeLot = makeLot("lot-free", 500n, null); // never expires
    state.lots = [soonLot, laterLot, freeLot];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 25n,
      reason: "consume_token_overage",
    });
    expect(r.chargedCents).toBe(25n);
    // lot-soon (10) + lot-later (10) + 5 from lot-free = 25
    expect(state.lotUpdateIds).toHaveLength(3);
    expect(state.lotUpdateIds[0]).toBe("lot-soon");
    expect(state.lotUpdateIds[1]).toBe("lot-later");
    expect(state.lotUpdateIds[2]).toBe("lot-free");
  });

  // ── invalid reason guard ─────────────────────────────────────────────────

  it("rejects an invalid reason before touching the DB", async () => {
    await expect(
      consumeCredits({
        orgId: "org-1",
        requestedCents: 5n,
        reason: "not_a_reason",
      }),
    ).rejects.toThrow("invalid credit reason");
    expect(state.ledgerInserts).toHaveLength(0);
  });
});
