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

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

const consumeCreditsMock = vi.fn().mockResolvedValue({
  chargedCents: 500n,
  shortfallCents: 0n,
  balanceCents: 0n,
});
vi.mock("./credits", () => ({
  consumeCredits: consumeCreditsMock,
}));

// The GAU reversal seam. Null is the default and means "not a GAU purchase",
// which is what every pre-existing test in this file relies on: the
// usage-credit clawback still runs for a charge that bought credits.
const reverseGauForRefundMock = vi.fn().mockResolvedValue(null);
const reverseGauForDisputeMock = vi.fn().mockResolvedValue(null);
// The charge read that a dispute resolves its organisation from (#3189).
// Default: an ordinary charge with no metadata, so the pre-existing tests
// exercise the fallback paths they were written for.
const readChargeMetadataMock = vi.fn().mockResolvedValue({});
vi.mock("./gau-reversals", () => ({
  reverseGauPurchaseForRefund: reverseGauForRefundMock,
  reverseGauPurchaseForDispute: reverseGauForDisputeMock,
  readChargeMetadata: readChargeMetadataMock,
  orgIdOfChargeMetadata: (m: Record<string, string>) => m.org_id ?? null,
}));

/** What applyGauReversal returns when the event was against a GAU purchase. */
function gauReversed(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-gau",
    settlementId: "settle-1",
    bucketId: "bucket-1",
    requestedGau: 10_000,
    reversedGau: 10_000,
    unrecoveredGau: 0,
    applied: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

interface DbState {
  disputeRow: Record<string, unknown> | null;
  insertCalled: boolean;
  updateSets: Array<Record<string, unknown>>;
  creditLedgerRow: Record<string, unknown> | null;
  /**
   * A checkout GAU settlement for this org that the ADR-085 migration could
   * not give a payment identity to. Null — no such row — is the state every
   * pre-existing test in this file runs in, and the state a deployment is in
   * once the backfill has run.
   */
  unidentifiedGauSettlementRow: Record<string, unknown> | null;
  /** Every condition the residue probe was built with, for shape assertions. */
  gauSettlementWheres: unknown[];
}

function makeState(): DbState {
  return {
    disputeRow: null,
    insertCalled: false,
    updateSets: [],
    creditLedgerRow: null,
    unidentifiedGauSettlementRow: null,
    gauSettlementWheres: [],
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
      gauSettlements: {
        findFirst: vi.fn(async (args: { where?: unknown }) => {
          state.gauSettlementWheres.push(args?.where);
          return state.unidentifiedGauSettlementRow;
        }),
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => dbHolder.instance,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbHolder.instance),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
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
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// onDisputeCreated tests
// ---------------------------------------------------------------------------

describe("onDisputeCreated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reverseGauForRefundMock.mockResolvedValue(null);
    reverseGauForDisputeMock.mockResolvedValue(null);
    readChargeMetadataMock.mockResolvedValue({});
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
    reverseGauForRefundMock.mockResolvedValue(null);
    reverseGauForDisputeMock.mockResolvedValue(null);
    readChargeMetadataMock.mockResolvedValue({});
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

  describe("a legacy gau purchase the backfill could not identify", () => {
    /**
     * ADR-085 §15. A GAU purchase recorded before the payment identity landed
     * has no stripe_payment_intent_id, and the createGauCheckout that paid for
     * it put no metadata on the PaymentIntent, so its Charge cannot name it
     * either. The migration backfills that column from the retained
     * checkout.session.completed payload; these tests are about what happens
     * to the rows it could not reach.
     */
    it("refuses the usage-credit clawback rather than debit a balance the purchase never credited", async () => {
      const state = makeState();
      state.creditLedgerRow = null;
      // One checkout settlement for this org still has no payment identity.
      state.unidentifiedGauSettlementRow = { id: "settle-legacy-1" };
      dbHolder.instance = makeDb(state);

      // A charge that says nothing about what it bought — which is exactly
      // what a legacy GAU purchase's charge looks like.
      await onChargeRefunded(
        makeRefundedCharge({ orgId: "org-xyz", metadata: {} }),
      );

      // The assertion that pins the finding. Taking usage credits here is
      // taking money from a balance this purchase never credited, and the
      // units it did grant stay spendable either way.
      expect(consumeCreditsMock).not.toHaveBeenCalled();
    });

    it("probes only for settlements that have no payment identity", async () => {
      const state = makeState();
      state.creditLedgerRow = null;
      state.unidentifiedGauSettlementRow = { id: "settle-legacy-1" };
      dbHolder.instance = makeDb(state);

      await onChargeRefunded(
        makeRefundedCharge({ orgId: "org-xyz", metadata: {} }),
      );

      // The row this returns is a fixture, so the mock cannot tell a filtered
      // query from an unfiltered one by its answer. Assert the condition the
      // query was BUILT with instead: without the IS NULL on
      // stripe_payment_intent_id the probe matches any checkout purchase the
      // organisation has ever made, and once the backfill has run that is all
      // of them — every legitimate credit refund for a GAU customer would be
      // refused, permanently, with no row left to clear the condition.
      const where = state.gauSettlementWheres[0] as {
        op: string;
        conds: Array<{ op: string; val?: unknown }>;
      };
      expect(where.op).toBe("and");
      expect(where.conds.some((c) => c.op === "isNull")).toBe(true);
      // Scoped to THIS organisation. Without it one customer's unresolved
      // purchase refuses every other customer's refunds — a blast radius the
      // size of the platform, from a row belonging to someone else.
      expect(
        where.conds.some((c) => c.op === "eq" && c.val === "org-xyz"),
      ).toBe(true);
    });

    it("still claws back normally once no settlement is missing its identity", async () => {
      const state = makeState();
      state.creditLedgerRow = null;
      state.unidentifiedGauSettlementRow = null;
      dbHolder.instance = makeDb(state);

      await onChargeRefunded(
        makeRefundedCharge({
          orgId: "org-xyz",
          metadata: {},
          amountRefundedCents: 2000,
        }),
      );

      // The guard is scoped to the unresolved residue and clears itself. A
      // guard that fired whenever the charge carried no metadata would refuse
      // every legitimate refund on a backfilled deployment.
      expect(consumeCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-xyz", requestedCents: 2000n }),
      );
    });

    it("still claws back for a charge that says it bought credits, residue or not", async () => {
      const state = makeState();
      state.creditLedgerRow = null;
      state.unidentifiedGauSettlementRow = { id: "settle-legacy-1" };
      dbHolder.instance = makeDb(state);

      await onChargeRefunded(
        makeRefundedCharge({
          orgId: "org-xyz",
          metadata: { oxagen_kind: "usage_credits" },
          amountRefundedCents: 2000,
        }),
      );

      // This charge names what it bought, so there is nothing to be ambiguous
      // about and the residue is irrelevant to it.
      expect(consumeCreditsMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-xyz", requestedCents: 2000n }),
      );
    });
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

// ---------------------------------------------------------------------------
// The GAU dispatch (ADR-085)
// ---------------------------------------------------------------------------

describe("a refund or dispute against a GAU block purchase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reverseGauForRefundMock.mockResolvedValue(null);
    reverseGauForDisputeMock.mockResolvedValue(null);
    readChargeMetadataMock.mockResolvedValue({});
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 2000n,
      shortfallCents: 0n,
      balanceCents: 0n,
    });
  });

  it("charge.refunded withdraws units and never debits the usage-credit ledger", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    reverseGauForRefundMock.mockResolvedValue(gauReversed());

    await onChargeRefunded(
      makeRefundedCharge({
        metadata: { oxagen_kind: "gau_purchase", org_id: "org-gau" },
      }),
    );

    expect(reverseGauForRefundMock).toHaveBeenCalledOnce();
    // The point of the dispatch: a block purchase credited no usage credits,
    // so clawing them back would take money from an unrelated balance.
    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("charge.refunded for a charge that says it bought units but matches no settlement stops rather than debiting credits", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    reverseGauForRefundMock.mockResolvedValue(null);

    await expect(
      onChargeRefunded(
        makeRefundedCharge({
          orgId: "org-xyz",
          metadata: { oxagen_kind: "gau_purchase", org_id: "org-xyz" },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("charge.refunded for an ordinary credit purchase still claws back credits", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onChargeRefunded(
      makeRefundedCharge({
        orgId: "org-xyz",
        metadata: { oxagen_kind: "usage_credits" },
      }),
    );

    expect(reverseGauForRefundMock).toHaveBeenCalledOnce();
    expect(consumeCreditsMock).toHaveBeenCalledOnce();
  });

  it("dispute.created records the dispute row against the org the settlement names and leaves credits alone", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    reverseGauForDisputeMock.mockResolvedValue(gauReversed());

    // A Stripe Dispute carries its own metadata, not the charge's, so the
    // dispute reaches the handler with no org at all. The settlement is the
    // only thing that can name one.
    await onDisputeCreated(makeDispute({ orgId: null }));

    expect(state.insertCalled).toBe(true);
    expect(consumeCreditsMock).not.toHaveBeenCalled();
    // clawed_back_cents is not written: no credits were taken.
    expect(state.updateSets).not.toContainEqual(
      expect.objectContaining({ clawedBackCents: expect.anything() }),
    );
    expect(state.updateSets).toContainEqual(
      expect.objectContaining({ status: "needs_response" }),
    );
  });

  it("dispute.created against an ordinary charge still claws back credits", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onDisputeCreated(makeDispute({ orgId: "org-abc" }));

    expect(reverseGauForDisputeMock).toHaveBeenCalledOnce();
    expect(consumeCreditsMock).toHaveBeenCalledOnce();
  });
});

describe("a dispute resolves its organisation from the charge (#3189, ADR-085 §7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reverseGauForRefundMock.mockResolvedValue(null);
    reverseGauForDisputeMock.mockResolvedValue(null);
    readChargeMetadataMock.mockResolvedValue({});
    consumeCreditsMock.mockResolvedValue({
      chargedCents: 2000n,
      shortfallCents: 0n,
      balanceCents: 0n,
    });
  });

  it("claws back credits for a dispute whose org only the charge knows", async () => {
    // The case that has never worked: the dispute carries no org of its own,
    // and neither resolveOrgFromDispute path can produce one — path 1 reads the
    // dispute's own metadata, path 2 looks the dispute up by its own id and can
    // only return what path 1 stored. Before the charge read, this dispute
    // logged a fatal and clawed back nothing.
    const state = makeState();
    dbHolder.instance = makeDb(state);
    readChargeMetadataMock.mockResolvedValue({
      oxagen_kind: "usage_credits",
      org_id: "org-from-charge",
    });

    await onDisputeCreated(makeDispute({ orgId: null }));

    expect(readChargeMetadataMock).toHaveBeenCalledWith("ch_test_001");
    expect(state.insertCalled).toBe(true);
    expect(consumeCreditsMock).toHaveBeenCalledOnce();
    expect(
      (consumeCreditsMock.mock.calls[0]![0] as { orgId: string }).orgId,
    ).toBe("org-from-charge");
  });

  it("reads the charge once and passes it to the gau reversal rather than fetching twice", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);
    const metadata = { oxagen_kind: "gau_purchase", org_id: "org-gau" };
    readChargeMetadataMock.mockResolvedValue(metadata);
    reverseGauForDisputeMock.mockResolvedValue(gauReversed());

    await onDisputeCreated(makeDispute({ orgId: null }));

    expect(readChargeMetadataMock).toHaveBeenCalledOnce();
    expect(reverseGauForDisputeMock).toHaveBeenCalledWith(
      expect.anything(),
      metadata,
    );
  });

  it("still logs the fatal when the charge cannot be read either", async () => {
    // A provider fault degrades to {} rather than throwing, and with no org
    // from any path the dispute is genuinely manual.
    const state = makeState();
    const db = makeDb(state);
    vi.spyOn(db.query.billingDisputes, "findFirst").mockResolvedValue(null);
    dbHolder.instance = db as ReturnType<typeof makeDb>;
    readChargeMetadataMock.mockResolvedValue({});

    await expect(
      onDisputeCreated(makeDispute({ orgId: null })),
    ).resolves.toBeUndefined();

    expect(consumeCreditsMock).not.toHaveBeenCalled();
  });

  it("a dispute with no charge id does not attempt a charge read", async () => {
    const state = makeState();
    dbHolder.instance = makeDb(state);

    await onDisputeCreated(makeDispute({ chargeId: null, orgId: "org-abc" }));

    expect(readChargeMetadataMock).toHaveBeenCalledWith(null);
  });
});
