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
  /**
   * org_billing_settings.meter_carry_micro_credits_by_reason — the sub-credit
   * carry, one bucket per `credit_ledger.reason`.
   */
  carryByReason: Record<string, number>;
  /** Whether org_billing_settings holds a row for the org (settlement reads it). */
  hasSettingsRow: boolean;
} = {
  lots: [],
  ledgerInserts: [],
  lotUpdateIds: [],
  balanceUpdateCount: 0,
  carryByReason: {},
  hasSettingsRow: true,
};

/** The micro-credits banked against one reason, as the column stores them. */
function carryFor(reason: string): bigint {
  return BigInt(state.carryByReason[reason] ?? 0);
}

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
  orgBillingSettings: {
    orgId: "obs.orgId",
    meterCarryMicroCreditsByReason: "obs.meterCarryMicroCreditsByReason",
  },
} as const;

function makeTx() {
  return {
    // SELECT … FROM credit_lots … FOR UPDATE, or the settlement's
    // SELECT … FROM org_billing_settings … FOR UPDATE.
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          // settleOwedCredits: the settings row, locked. No row when the org
          // has never carried anything.
          for: vi.fn(async () =>
            table === SCHEMA.orgBillingSettings && state.hasSettingsRow
              ? [{ carryByReason: { ...state.carryByReason } }]
              : [],
          ),
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
      const isSettings = table === SCHEMA.orgBillingSettings;
      return {
        set: vi.fn((fields: Record<string, unknown>) => ({
          where: vi.fn((cond: { _eq?: unknown[] }) => {
            if (isCreditLots) {
              // cond._eq[1] is the lot id value from eq(schema.creditLots.id, lot.id)
              const lotId = (cond?._eq?.[1] as string) ?? "unknown";
              state.lotUpdateIds.push(lotId);
            } else if (isSettings) {
              // The carry write-back: only this reason's remainder stays banked,
              // and the other reasons' buckets ride along untouched.
              state.carryByReason = fields[
                "meterCarryMicroCreditsByReason"
              ] as Record<string, number>;
            } else {
              state.balanceUpdateCount++;
            }
            return Promise.resolve();
          }),
        })),
      };
    }),

    // INSERT — credit_ledger, or the org_billing_settings upsert that locks the
    // row and hands back the stored carry map the way ON CONFLICT DO UPDATE …
    // RETURNING does. A copy, so a caller that spreads it cannot mutate the
    // stored row without going through the UPDATE.
    insert: vi.fn((table: unknown) => {
      if (table === SCHEMA.orgBillingSettings) {
        return {
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(async () => [
                { carryByReason: { ...state.carryByReason } },
              ]),
            })),
          })),
        };
      }
      return {
        values: vi.fn(async (v: Record<string, unknown>) => {
          state.ledgerInserts.push(v);
        }),
      };
    }),
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
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
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

const { consumeCredits, settleOwedCredits } = await import("./credits");
const { microCreditsForCostUsd } = await import("./metering");
const { providerCostUsd } = await import("./pricing");

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
    state.carryByReason = {};
  });

  // ── basic debit ──────────────────────────────────────────────────────────

  it("debits the full request when total lot balance covers it", async () => {
    state.lots = [makeLot("lot-1", 1000n)];
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
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
      reason: "consume_execution",
    });
    expect(r.chargedCents).toBe(50n);
    expect(r.balanceCents).toBe(50n); // only the live lot's balance
  });

  it("reports zero balance and zero charge when all lots are expired", async () => {
    state.lots = []; // all expired → none returned by WHERE
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 100n,
      reason: "consume_execution",
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
      reason: "consume_execution",
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

// ---------------------------------------------------------------------------
// The sub-credit carry (#1413)
// ---------------------------------------------------------------------------

describe("consumeCredits — sub-credit carry", () => {
  // The live markup, so these numbers are the ones a customer would be charged.
  const MARKUP = 3.381;

  /** One 200-token embedding, in micro-credits — the call from the issue. */
  const EMBEDDING_MICRO = microCreditsForCostUsd(
    providerCostUsd({
      model: "text-embedding-3-small",
      inputTokens: 200,
      outputTokens: 0,
    }),
    MARKUP,
  );

  beforeEach(() => {
    state.lots = [];
    state.ledgerInserts = [];
    state.lotUpdateIds = [];
    state.balanceUpdateCount = 0;
    state.carryByReason = {};
  });

  it("charges nothing for a call worth a fraction of a credit, and banks the fraction", async () => {
    state.lots = [makeLot("lot-1", 1000n)];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: EMBEDDING_MICRO,
      reason: "consume_execution",
    });

    // 0.0014 of a credit. Rounding it up charged 739x the call's cost.
    expect(EMBEDDING_MICRO).toBeLessThan(1_000_000n);
    expect(r.chargedCents).toBe(0n);
    expect(r.carryMicroCents).toBe(EMBEDDING_MICRO);
    // Nothing was debited, so no ledger row and no lot touched.
    expect(state.ledgerInserts).toHaveLength(0);
    expect(state.lotUpdateIds).toHaveLength(0);
  });

  it("debits a whole credit once the fractions add up, and keeps the remainder", async () => {
    state.lots = [makeLot("lot-1", 1000n)];

    // 740 embeddings is just over one credit's worth at this markup.
    let charged = 0n;
    for (let i = 0; i < 740; i++) {
      const r = await consumeCredits({
        orgId: "org-1",
        requestedMicroCents: EMBEDDING_MICRO,
        reason: "consume_execution",
      });
      charged += r.chargedCents;
    }

    const owedMicro = EMBEDDING_MICRO * 740n;
    expect(charged).toBe(owedMicro / 1_000_000n);
    expect(carryFor("consume_execution")).toBe(owedMicro % 1_000_000n);
    // The carry never holds a whole credit — that is what makes it exact.
    expect(carryFor("consume_execution")).toBeLessThan(1_000_000n);
  });

  it("prices an ingestion pass at its cost, not at one credit per chunk", async () => {
    // The issue's table: 1,000 embedded chunks are worth about a cent in total,
    // and used to be charged 1,000 credits — $10.00 for $0.01 of work.
    state.lots = [makeLot("lot-1", 100_000n)];

    let charged = 0n;
    for (let i = 0; i < 1_000; i++) {
      const r = await consumeCredits({
        orgId: "org-1",
        requestedMicroCents: EMBEDDING_MICRO,
        reason: "consume_execution",
      });
      charged += r.chargedCents;
    }

    expect(charged).toBe((EMBEDDING_MICRO * 1_000n) / 1_000_000n);
    expect(charged).toBeLessThanOrEqual(2n);
  });

  it("still debits whole credits directly for a requestedCents caller", async () => {
    state.lots = [makeLot("lot-1", 1000n)];
    const r = await consumeCredits({
      orgId: "org-1",
      requestedCents: 20n,
      reason: "consume_execution",
    });
    expect(r.chargedCents).toBe(20n);
    // A whole-credit caller does not carry.
    expect(r.carryMicroCents).toBe(0n);
    expect(carryFor("consume_execution")).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// The carry is partitioned by billing reason
// ---------------------------------------------------------------------------

describe("consumeCredits — carry is partitioned by reason", () => {
  /** 0.9 of a credit, and 0.1 of a credit, in micro-credits. */
  const NINE_TENTHS = 900_000n;
  const ONE_TENTH = 100_000n;

  beforeEach(() => {
    state.lots = [];
    state.ledgerInserts = [];
    state.lotUpdateIds = [];
    state.balanceUpdateCount = 0;
    state.carryByReason = {};
  });

  it("does not bill an embedding fraction as an assistant turn", async () => {
    // The exact case that made a pooled carry wrong. consume_embedding carries
    // the solved blended markup; consume_assistant_tokens bills at exactly the
    // platform key's cost (ADR-053 §3, amended 2026-09-18). A single pooled
    // counter reached one credit on the assistant's 0.1 and wrote the whole
    // credit as consume_assistant_tokens — 0.9 of it embedding margin, on a line
    // that is supposed to carry none, and counted against the assistant cap.
    state.lots = [makeLot("lot-1", 1000n)];

    const embedding = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: NINE_TENTHS,
      reason: "consume_embedding",
    });
    const assistant = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: ONE_TENTH,
      reason: "consume_assistant_tokens",
    });

    // Neither reason reached a whole credit on its own, so nothing is debited
    // and no ledger row is written under either name.
    expect(embedding.chargedCents).toBe(0n);
    expect(assistant.chargedCents).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(0);

    // Each fraction is still banked, under the reason that accrued it.
    expect(carryFor("consume_embedding")).toBe(NINE_TENTHS);
    expect(carryFor("consume_assistant_tokens")).toBe(ONE_TENTH);
  });

  it("debits a whole credit under the reason whose own fractions reached it", async () => {
    state.lots = [makeLot("lot-1", 1000n)];

    // Embedding gets to 1.2 credits on its own; the assistant stays at 0.1.
    await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: NINE_TENTHS,
      reason: "consume_embedding",
    });
    await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: ONE_TENTH,
      reason: "consume_assistant_tokens",
    });
    const crossing = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: 300_000n,
      reason: "consume_embedding",
    });

    expect(crossing.chargedCents).toBe(1n);
    expect(state.ledgerInserts).toHaveLength(1);
    expect(state.ledgerInserts[0]!.reason).toBe("consume_embedding");
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-1n);
    // 0.2 left on embedding; the assistant's 0.1 was never touched.
    expect(carryFor("consume_embedding")).toBe(200_000n);
    expect(carryFor("consume_assistant_tokens")).toBe(ONE_TENTH);
  });

  it("keeps each reason exact over a long interleaved sequence", async () => {
    state.lots = [makeLot("lot-1", 1000n)];

    // Ten of each, alternating, so a pooled counter would cross the boundary on
    // whichever call happened to land there.
    for (let i = 0; i < 10; i++) {
      await consumeCredits({
        orgId: "org-1",
        requestedMicroCents: NINE_TENTHS,
        reason: "consume_embedding",
      });
      await consumeCredits({
        orgId: "org-1",
        requestedMicroCents: ONE_TENTH,
        reason: "consume_assistant_tokens",
      });
    }

    const byReason = (reason: string): bigint =>
      state.ledgerInserts
        .filter((row) => row.reason === reason)
        .reduce((acc, row) => acc + (row.deltaCents as bigint), 0n);

    // 10 × 0.9 = 9 credits of embedding, 10 × 0.1 = 1 credit of assistant.
    expect(byReason("consume_embedding")).toBe(-9n);
    expect(byReason("consume_assistant_tokens")).toBe(-1n);
    expect(carryFor("consume_embedding")).toBe(0n);
    expect(carryFor("consume_assistant_tokens")).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// A shortfall kept as a debt (carryShortfall), and the grant that settles it
// ---------------------------------------------------------------------------

describe("consumeCredits — an assistant shortfall is owed, not forgiven", () => {
  const PERSON = "0199a7e2-6f00-7000-8000-000000000001";

  beforeEach(() => {
    state.lots = [];
    state.ledgerInserts = [];
    state.lotUpdateIds = [];
    state.balanceUpdateCount = 0;
    state.carryByReason = {};
    state.hasSettingsRow = true;
  });

  // The defect: a turn that cost 20.5 credits against a balance of 5 was
  // debited 5 and the other 15 were dropped, because the lots cannot go below
  // zero and nothing remembered the rest.
  it("banks what the balance could not cover beside the fraction", async () => {
    state.lots = [makeLot("lot-1", 5n)];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: 20_500_000n,
      reason: "consume_assistant_tokens",
      carryShortfall: true,
    });

    expect(r.chargedCents).toBe(5n);
    expect(r.shortfallCents).toBe(15n);
    expect(r.owedCents).toBe(15n);
    expect(carryFor("consume_assistant_tokens")).toBe(15_500_000n);
    // Still no overdraft: the ledger shows what the lots held and no more.
    expect(state.ledgerInserts).toHaveLength(1);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-5n);
  });

  it("still drops the shortfall for a caller that does not carry it", async () => {
    state.lots = [makeLot("lot-1", 5n)];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: 20_500_000n,
      reason: "consume_embedding",
    });

    expect(r.shortfallCents).toBe(15n);
    expect(r.owedCents).toBe(0n);
    expect(carryFor("consume_embedding")).toBe(500_000n);
  });

  it("collects the debt first on the next charge, in a row of its own", async () => {
    state.carryByReason = { consume_assistant_tokens: 15_500_000 };
    state.lots = [makeLot("lot-1", 100n)];

    const r = await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: 2_000_000n,
      reason: "consume_assistant_tokens",
      referenceType: "token_usage",
      referenceId: "0199a7e2-6f00-7000-8000-0000000000aa",
      createdById: PERSON,
      carryShortfall: true,
    });

    // 15 owed + 2.5 of new cost = 17 whole credits, 0.5 carried.
    expect(r.priorOwedCents).toBe(15n);
    expect(r.chargedCents).toBe(17n);
    expect(r.owedCents).toBe(0n);
    expect(carryFor("consume_assistant_tokens")).toBe(500_000n);
    // The debt names nobody: the bucket does not record who ran it up, and
    // this call's person did not.
    expect(state.ledgerInserts).toEqual([
      expect.objectContaining({
        deltaCents: -15n,
        reason: "consume_assistant_tokens",
        referenceType: "credit_debt",
        createdById: null,
      }),
      expect.objectContaining({
        deltaCents: -2n,
        reason: "consume_assistant_tokens",
        referenceType: "token_usage",
        createdById: PERSON,
      }),
    ]);
  });

  it("writes the acting person to created_by_id on a consume row", async () => {
    state.lots = [makeLot("lot-1", 100n)];
    await consumeCredits({
      orgId: "org-1",
      requestedMicroCents: 3_000_000n,
      reason: "consume_assistant_tokens",
      createdById: PERSON,
      carryShortfall: true,
    });
    expect(state.ledgerInserts[0]!.createdById).toBe(PERSON);
  });

  it("names nobody on a consume row when no person is given", async () => {
    state.lots = [makeLot("lot-1", 100n)];
    await consumeCredits({
      orgId: "org-1",
      requestedCents: 3n,
      reason: "consume_execution",
    });
    expect(state.ledgerInserts[0]!.createdById).toBeNull();
  });
});

describe("settleOwedCredits — a grant pays what the org owes", () => {
  beforeEach(() => {
    state.lots = [];
    state.ledgerInserts = [];
    state.lotUpdateIds = [];
    state.balanceUpdateCount = 0;
    state.carryByReason = {};
    state.hasSettingsRow = true;
  });

  const tx = () =>
    makeTx() as unknown as Parameters<typeof settleOwedCredits>[0];

  it("collects the debt from the new credits and keeps the fraction", async () => {
    state.carryByReason = {
      consume_assistant_tokens: 15_500_000,
      consume_embedding: 400_000,
    };
    state.lots = [makeLot("lot-new", 500n)];

    const collected = await settleOwedCredits(tx(), "org-1");

    expect(collected).toBe(15n);
    expect(state.ledgerInserts).toEqual([
      expect.objectContaining({
        deltaCents: -15n,
        reason: "consume_assistant_tokens",
        referenceType: "credit_debt",
      }),
    ]);
    expect(state.lotUpdateIds).toEqual(["lot-new"]);
    expect(carryFor("consume_assistant_tokens")).toBe(500_000n);
    // A fraction is not owed yet; it stays where it was.
    expect(carryFor("consume_embedding")).toBe(400_000n);
  });

  it("pays part of the debt when the grant is smaller, and the rest stays owed", async () => {
    state.carryByReason = { consume_assistant_tokens: 15_000_000 };
    state.lots = [makeLot("lot-new", 10n)];

    const collected = await settleOwedCredits(tx(), "org-1");

    expect(collected).toBe(10n);
    expect(state.ledgerInserts[0]!.deltaCents).toBe(-10n);
    expect(carryFor("consume_assistant_tokens")).toBe(5_000_000n);
  });

  it("writes nothing when the org owes nothing", async () => {
    state.carryByReason = { consume_assistant_tokens: 900_000 };
    state.lots = [makeLot("lot-new", 10n)];

    expect(await settleOwedCredits(tx(), "org-1")).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(0);
    expect(state.lotUpdateIds).toHaveLength(0);
  });

  it("writes nothing for an org with no settings row", async () => {
    state.hasSettingsRow = false;
    state.lots = [makeLot("lot-new", 10n)];

    expect(await settleOwedCredits(tx(), "org-1")).toBe(0n);
    expect(state.ledgerInserts).toHaveLength(0);
  });
});
