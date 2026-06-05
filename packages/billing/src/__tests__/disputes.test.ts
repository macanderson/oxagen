/**
 * Unit tests for disputes.ts
 *
 * Covers:
 *  - onDisputeCreated: upsert row + clawback credits + idempotency
 *  - onDisputeCreated: orgId resolution fallback
 *  - onDisputeCreated: no orgId → early return (no crash)
 *  - onDisputeClosed: updates status + resolvedAt
 *  - refundOrgPayment: delegates to provider.createRefund
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingDispute } from "../provider";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ _eq: [a, b] }),
}));

const consumeCreditsMock = vi.fn().mockResolvedValue({ chargedCents: 500n, shortfallCents: 0n, balanceCents: 0n });
vi.mock("../credits", () => ({
  consumeCredits: consumeCreditsMock,
}));

const createRefundMock = vi.fn().mockResolvedValue({ refundId: "re_test_001", amountCents: 1000, status: "succeeded" });
vi.mock("../client", () => ({
  billingProvider: () => ({
    createRefund: createRefundMock,
  }),
}));

// DB mock.
interface DbState {
  disputeRow: Record<string, unknown> | null;
  disputeById: Record<string, unknown> | null;
  insertCalled: boolean;
  updateSets: Array<Record<string, unknown>>;
}

function makeState(): DbState {
  return {
    disputeRow: null,
    disputeById: null,
    insertCalled: false,
    updateSets: [],
  };
}

function makeDb(state: DbState) {
  // Track insert call count to distinguish first vs subsequent.
  let insertIdx = 0;
  return {
    query: {
      billingDisputes: {
        findFirst: vi.fn(async () => {
          // First call during resolve (by stripeDisputeId): returns disputeRow.
          // Second call after insert (by stripeDisputeId for update): returns disputeById.
          return state.disputeRow;
        }),
      },
    },
    insert: vi.fn(() => {
      insertIdx++;
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

const dbHolder: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", () => ({
  db: () => dbHolder.instance,
  schema: {
    billingDisputes: {
      stripeDisputeId: "billingDisputes.stripeDisputeId",
      id: "billingDisputes.id",
    },
  },
}));

// Import after mocks.
const { onDisputeCreated, onDisputeClosed, refundOrgPayment } = await import("../disputes");

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onDisputeCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumeCreditsMock.mockResolvedValue({ chargedCents: 500n, shortfallCents: 0n, balanceCents: 0n });
  });

  it("inserts dispute row and claws back credits", async () => {
    const state = makeState();
    state.disputeRow = null; // no existing row on first findFirst, then return row for update
    // First call: upsert check → null (not yet inserted)
    // After insert, second call for update → return row
    let callCount = 0;
    const db = makeDb(state);
    vi.spyOn(db.query.billingDisputes, "findFirst").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null; // upsert check
      return { id: "dispute-uuid-1", clawedBackCents: 0n }; // post-insert lookup
    });
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    expect(state.insertCalled).toBe(true);
    expect(consumeCreditsMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-abc",
      requestedCents: 5000n,
      reason: "clawback_dispute",
      referenceType: "dispute",
      referenceId: "dp_test_001",
    }));
  });

  it("is idempotent: skips clawback when clawedBackCents already > 0", async () => {
    const state = makeState();
    const db = makeDb(state);
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue({
      id: "dispute-uuid-1",
      clawedBackCents: 2000n, // already clawed back
    });
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("returns early when orgId is null and cannot be resolved", async () => {
    const state = makeState();
    const db = makeDb(state);
    // billingDisputes findFirst returns null (no existing dispute to get orgId from)
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue(null);
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: null, chargeId: null, paymentIntentId: null }));

    expect(state.insertCalled).toBe(false);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("records clawedBackCents from consumeCredits result", async () => {
    const state = makeState();
    consumeCreditsMock.mockResolvedValue({ chargedCents: 3000n, shortfallCents: 2000n, balanceCents: 0n });
    const db = makeDb(state);
    let callCount = 0;
    vi.spyOn(db.query.billingDisputes, "findFirst").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return null;
      return { id: "dispute-uuid-1", clawedBackCents: 0n };
    });
    dbHolder.instance = db as ReturnType<typeof makeDb>;

    await onDisputeCreated(makeDispute({ orgId: "org-abc", amountCents: 5000 }));

    const updateCall = state.updateSets.find((s) => "clawedBackCents" in s);
    expect(updateCall?.clawedBackCents).toBe(3000n);
  });
});

describe("onDisputeClosed", () => {
  it("updates status and resolvedAt", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onDisputeClosed(makeDispute({ status: "won" }));

    expect(state.updateSets[0]?.status).toBe("won");
    expect(state.updateSets[0]?.resolvedAt).toBeDefined();
  });
});

describe("refundOrgPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createRefundMock.mockResolvedValue({ refundId: "re_test_001", amountCents: 1000, status: "succeeded" });
  });

  it("calls provider.createRefund and returns result", async () => {
    const result = await refundOrgPayment("org-abc", {
      paymentIntentId: "pi_test_001",
      amountCents: 1000,
      reason: "requested_by_customer",
    });

    expect(createRefundMock).toHaveBeenCalledWith(expect.objectContaining({
      paymentIntentId: "pi_test_001",
      amountCents: 1000,
      reason: "requested_by_customer",
    }));
    expect(result.refundId).toBe("re_test_001");
    expect(result.amountCents).toBe(1000);
    expect(result.status).toBe("succeeded");
  });

  it("passes chargeId when provided instead of paymentIntentId", async () => {
    createRefundMock.mockResolvedValue({ refundId: "re_test_002", amountCents: 500, status: "succeeded" });
    const result = await refundOrgPayment("org-abc", {
      chargeId: "ch_test_001",
      reason: "fraudulent",
    });

    expect(createRefundMock).toHaveBeenCalledWith(expect.objectContaining({
      chargeId: "ch_test_001",
      reason: "fraudulent",
    }));
    expect(result.refundId).toBe("re_test_002");
  });
});
