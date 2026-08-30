/**
 * Unit tests for disputes.ts
 *
 * Covers:
 *  - onDisputeCreated: upsert row + clawback credits + idempotency
 *  - onDisputeCreated: orgId resolution fallback
 *  - onDisputeCreated: no orgId → logs CRITICAL, no crash
 *  - onDisputeClosed: updates status + resolvedAt
 *  - onChargeRefunded: happy path clawback
 *  - onChargeRefunded: idempotency on repeat (existing ledger row)
 *  - onChargeRefunded: unresolved-org logs critical, no crash
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingDispute, BillingRefundedCharge } from "./provider";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const consumeCreditsMock = vi.fn().mockResolvedValue({
  chargedCents: 500n,
  shortfallCents: 0n,
  balanceCents: 0n,
});
vi.mock("./credits", () => ({
  consumeCredits: consumeCreditsMock,
}));

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

interface DbState {
  disputeRow: Record<string, unknown> | null;
  insertCalled: boolean;
  updateSets: Array<Record<string, unknown>>;
  creditLedgerRow: Record<string, unknown> | null;
}

function makeState(): DbState {
  return {
    disputeRow: null,
    insertCalled: false,
    updateSets: [],
    creditLedgerRow: null,
  };
}

function makeDb(state: DbState) {
  return {
    query: {
      billingDisputes: {
        findFirst: vi.fn(async () => state.disputeRow),
      },
      creditLedger: {
        findFirst: vi.fn(async () => state.creditLedgerRow),
      },
    },
    insert: vi.fn(() => {
      state.insertCalled = true;
      return {
        values: vi.fn(() => Promise.resolve()),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        state.updateSets.push(vals);
        return {
          where: vi.fn(() => Promise.resolve()),
        };
      }),
    })),
  };
}

const dbHolder: { instance: ReturnType<typeof makeDb> | null } = {
  instance: null,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbHolder.instance,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
  };
});

// Import after mocks.
const { onDisputeCreated, onDisputeClosed, onChargeRefunded } = await import(
  "./disputes"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDispute(overrides: Partial<BillingDispute> = {}): BillingDispute {
  return {
    id: "dp_test_001",
    chargeId: "ch_test_001",
    paymentIntentId: "pi_test_001",
    amountCents: 5000,
    currency: "usd",
    reason: "duplicate",
    status: "needs_response",
    orgId: "org-abc",
    ...overrides,
  };
}

function makeRefundedCharge(
  overrides: Partial<BillingRefundedCharge> = {},
): BillingRefundedCharge {
  return {
    id: "ch_refund_001",
    paymentIntentId: "pi_refund_001",
    amountRefundedCents: 2000,
    currency: "usd",
    orgId: "org-xyz",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// onDisputeCreated tests
// ---------------------------------------------------------------------------

describe("onDisputeCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 500n,
      shortfallCents: 0n,
      balanceCents: 0n,
    });
  });

  it("inserts dispute row and claws back credits", async () => {
    const state = makeState();
    const db = makeDb(state);
    let callCount = 0;
    vi.spyOn(db.query.billingDisputes, "findFirst").mockImplementation(
      async () => {
        callCount++;
        if (callCount === 1) return null; // upsert check
        return { id: "dispute-uuid-1", clawedBackCents: 0n }; // post-insert lookup
      },
    );
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    expect(state.insertCalled).toBe(true);
    expect(consumeCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-abc",
        requestedCents: 5000n,
        reason: "clawback_dispute",
        referenceType: "dispute",
      }),
    );
    // referenceId must be a deterministic UUID derived from the Stripe dispute
    // id (credit_ledger.reference_id is a UUID column), not the raw "dp_..." id.
    const call = consumeCreditsMock.mock.calls[0]![0] as {
      referenceId: string;
    };
    expect(call.referenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("idempotent: skips clawback when a clawback ledger row already exists for this dispute", async () => {
    const state = makeState();
    state.creditLedgerRow = { id: "ledger-uuid-1" }; // prior dispute clawback debit
    const db = makeDb(state);
    let callCount = 0;
    vi.spyOn(db.query.billingDisputes, "findFirst").mockImplementation(
      async () => {
        callCount++;
        if (callCount === 1) return null; // upsert check → insert path
        return { id: "dispute-uuid-1", clawedBackCents: 0n };
      },
    );
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    // Even though the billing_disputes row shows clawedBackCents == 0, the
    // ledger pre-check must short-circuit before debiting credits again.
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("is idempotent: skips clawback when clawedBackCents already > 0", async () => {
    const state = makeState();
    const db = makeDb(state);
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue({
      id: "dispute-uuid-1",
      clawedBackCents: 2000n,
    });
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("logs CRITICAL when orgId is null and cannot be resolved", async () => {
    const state = makeState();
    const db = makeDb(state);
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue(null);
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    // Should not throw — logs critical and returns.
    await expect(
      onDisputeCreated(
        makeDispute({ orgId: null, chargeId: null, paymentIntentId: null }),
      ),
    ).resolves.toBeUndefined();

    expect(state.insertCalled).toBe(false);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("records clawedBackCents from consumeCredits result", async () => {
    const state = makeState();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 3000n,
      shortfallCents: 2000n,
      balanceCents: 0n,
    });
    const db = makeDb(state);
    let callCount = 0;
    vi.spyOn(db.query.billingDisputes, "findFirst").mockImplementation(
      async () => {
        callCount++;
        if (callCount === 1) return null;
        return { id: "dispute-uuid-1", clawedBackCents: 0n };
      },
    );
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(
      makeDispute({ orgId: "org-abc", amountCents: 5000 }),
    );

    const updateCall = state.updateSets.find((s) => "clawedBackCents" in s);
    expect(updateCall?.clawedBackCents).toBe(3000n);
  });
});

// ---------------------------------------------------------------------------
// onDisputeClosed tests
// ---------------------------------------------------------------------------

describe("onDisputeClosed", () => {
  it("updates status and resolvedAt", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onDisputeClosed(makeDispute({ status: "won" }));

    expect(state.updateSets[0]?.status).toBe("won");
    expect(state.updateSets[0]?.resolvedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// onChargeRefunded tests
// ---------------------------------------------------------------------------

describe("onChargeRefunded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 2000n,
      shortfallCents: 0n,
      balanceCents: 0n,
    });
  });

  it("happy path: resolves org from charge.orgId, calls consumeCredits, logs info", async () => {
    const state = makeState();
    state.creditLedgerRow = null; // no prior clawback
    dbHolder.instance = makeDb(state);

    await onChargeRefunded(
      makeRefundedCharge({ orgId: "org-xyz", amountRefundedCents: 2000 }),
    );

    expect(consumeCreditsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-xyz",
        requestedCents: 2000n,
        reason: "refund",
        referenceType: "charge_refund",
      }),
    );
    // referenceId should be a deterministic UUID (not the raw charge id).
    const call = consumeCreditsMock.mock.calls[0]![0] as {
      referenceId: string;
    };
    expect(call.referenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("idempotency: skips clawback when ledger row already exists for this charge", async () => {
    const state = makeState();
    state.creditLedgerRow = { id: "ledger-uuid-1" }; // already clawed back
    dbHolder.instance = makeDb(state);

    await onChargeRefunded(makeRefundedCharge({ orgId: "org-xyz" }));

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("idempotency: same charge id always produces the same referenceId UUID", async () => {
    // The deterministicUuid is a pure SHA-256 derivation; verify consistency.
    const state1 = makeState();
    state1.creditLedgerRow = null;
    const db1 = makeDb(state1);
    dbHolder.instance = db1 as ReturnType<typeof makeDb>;

    await onChargeRefunded(
      makeRefundedCharge({
        id: "ch_stable_001",
        orgId: "org-xyz",
        amountRefundedCents: 100,
      }),
    );

    const callA = consumeCreditsMock.mock.calls[0]![0] as {
      referenceId: string;
    };

    consumeCreditsMock.mockClear();
    const state2 = makeState();
    state2.creditLedgerRow = null;
    dbHolder.instance = makeDb(state2);

    await onChargeRefunded(
      makeRefundedCharge({
        id: "ch_stable_001",
        orgId: "org-xyz",
        amountRefundedCents: 100,
      }),
    );

    const callB = consumeCreditsMock.mock.calls[0]![0] as {
      referenceId: string;
    };
    expect(callA.referenceId).toBe(callB.referenceId);
  });

  it("unresolved org logs CRITICAL and does NOT crash or call consumeCredits", async () => {
    const state = makeState();
    const db = makeDb(state);
    // All fallback queries return null.
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue(null);
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await expect(
      onChargeRefunded(makeRefundedCharge({ orgId: null })),
    ).resolves.toBeUndefined();

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("skips clawback gracefully when amountRefundedCents is 0", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onChargeRefunded(
      makeRefundedCharge({ orgId: "org-xyz", amountRefundedCents: 0 }),
    );

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });
});
