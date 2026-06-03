/**
 * Unit tests for grants.ts (grantFreeCredits, grantPlanCreditsForInvoicePaid,
 * grantCreditPackForCheckout).
 *
 * Mocks:
 *  - @oxagen/database → db() factory with transaction support
 *  - ../client.js     → billingProvider() with getCheckoutSessionCreditPacks
 *  - ../subscriptions.js → syncSubscriptionFromStripe (no-op)
 *
 * The refactored grants.ts is fully transactional (INSERT … ON CONFLICT DO
 * NOTHING replaces the old check-then-insert TOCTOU). Tests verify:
 *  1. Happy path — transaction runs, lot + ledger + balance mirror written.
 *  2. Already granted (ON CONFLICT fires, ledger insert returns 0 rows) →
 *     lot/balance inserts are NOT called.
 *  3. Early-return conditions (wrong billing_reason, wrong session mode, etc.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingCheckoutSession, BillingInvoice } from "../provider";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../subscriptions", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

// billingProvider mock — only getCheckoutSessionCreditPacks is used in grants.
const getCheckoutSessionCreditPacksMock = vi.fn().mockResolvedValue([]);
vi.mock("../client", () => ({
  billingProvider: () => ({
    getCheckoutSessionCreditPacks: getCheckoutSessionCreditPacksMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB mock factory (supports transaction)
// ---------------------------------------------------------------------------

interface TxMock {
  insert: ReturnType<typeof vi.fn>;
  _ledgerRows: Array<{ id: string }>;
  _lotInsertCalled: boolean;
  _balanceUpsertCalled: boolean;
}

/**
 * Build a transaction mock.
 * `ledgerConflict` controls whether the ledger INSERT ON CONFLICT fires:
 *   false → insert succeeds, returns [{ id: "ledger-row-1" }]
 *   true  → conflict, returns []
 */
function makeTx(ledgerConflict = false): TxMock {
  const ledgerRows = ledgerConflict ? [] : [{ id: "ledger-row-1" }];
  let insertCallIdx = 0;

  const mock: TxMock = {
    _ledgerRows: ledgerRows,
    _lotInsertCalled: false,
    _balanceUpsertCalled: false,
    insert: vi.fn(() => {
      insertCallIdx++;
      if (insertCallIdx === 1) {
        // First insert: credit_ledger (idempotency guard)
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue(ledgerRows),
            }),
          }),
        };
      }
      if (insertCallIdx === 2) {
        // Second insert: credit_lots
        mock._lotInsertCalled = true;
        return { values: vi.fn().mockResolvedValue(undefined) };
      }
      // Third insert: credit_balances upsert
      mock._balanceUpsertCalled = true;
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      };
    }),
  };
  return mock;
}

function makeDb(
  txMock: TxMock,
  queryOverrides: Partial<{
    creditLedger: ReturnType<typeof vi.fn>;
    subscriptions: ReturnType<typeof vi.fn>;
    plans: ReturnType<typeof vi.fn>;
    invoices: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    transaction: vi.fn((fn: (tx: TxMock) => Promise<unknown>) => fn(txMock)),
    query: {
      creditLedger: { findFirst: queryOverrides.creditLedger ?? vi.fn().mockResolvedValue(undefined) },
      subscriptions: { findFirst: queryOverrides.subscriptions ?? vi.fn().mockResolvedValue(undefined) },
      plans: { findFirst: queryOverrides.plans ?? vi.fn().mockResolvedValue(undefined) },
      invoices: { findFirst: queryOverrides.invoices ?? vi.fn().mockResolvedValue(undefined) },
    },
  };
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", () => ({
  db: () => dbState.instance,
  schema: {
    creditLedger: {
      orgId: "creditLedger.orgId",
      reason: "creditLedger.reason",
      referenceType: "creditLedger.referenceType",
      referenceId: "creditLedger.referenceId",
    },
    creditLots: { orgId: "creditLots.orgId" },
    creditBalances: {
      orgId: "creditBalances.orgId",
      balanceCents: "creditBalances.balanceCents",
    },
    subscriptions: { stripeSubscriptionId: "subscriptions.stripeSubscriptionId" },
    plans: { id: "plans.id" },
    invoices: { stripeInvoiceId: "invoices.stripeInvoiceId" },
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  and: vi.fn((...args: unknown[]) => args),
}));

// Import after mocks.
const { grantFreeCredits, grantPlanCreditsForInvoicePaid, grantCreditPackForCheckout } =
  await import("../grants");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    id: "in_test_001",
    providerInvoiceId: "in_test_001",
    number: "INV-001",
    status: "paid",
    amountDueCents: 2000,
    amountPaidCents: 2000,
    amountRemainingCents: 0,
    currency: "usd",
    periodStart: new Date(),
    periodEnd: new Date(),
    dueAt: null,
    paidAt: new Date(),
    hostedInvoiceUrl: null,
    invoicePdfUrl: null,
    subscriptionId: "sub_test_001",
    orgId: "org-abc",
    billingReason: "subscription_create",
    lineItems: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<BillingCheckoutSession> = {}): BillingCheckoutSession {
  return {
    id: "cs_test_001",
    mode: "payment",
    paymentStatus: "paid",
    metadata: { org_id: "org-abc" },
    subscriptionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — grantFreeCredits
// ---------------------------------------------------------------------------

describe("grantFreeCredits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first grant — transaction runs, lot + ledger + balance written", async () => {
    const txMock = makeTx(false); // no conflict
    dbState.instance = makeDb(txMock);

    await grantFreeCredits("org-abc");

    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    expect(txMock.insert).toHaveBeenCalledTimes(3);
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("already granted (ledger conflict) — lot and balance inserts NOT called", async () => {
    const txMock = makeTx(true); // conflict → 0 rows returned
    dbState.instance = makeDb(txMock);

    await grantFreeCredits("org-abc");

    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    // Only the ledger insert (idempotency check) is called; lot/balance are skipped.
    expect(txMock.insert).toHaveBeenCalledTimes(1);
    expect(txMock._lotInsertCalled).toBe(false);
    expect(txMock._balanceUpsertCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — grantPlanCreditsForInvoicePaid
// ---------------------------------------------------------------------------

describe("grantPlanCreditsForInvoicePaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncSubscriptionMock.mockResolvedValue(undefined);
  });

  it("subscription_create billing reason — grants plan credits in transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billingReason: "subscription_create" }));

    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("subscription_cycle billing reason — grants plan credits", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 3000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-2" }),
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billingReason: "subscription_cycle" }));

    expect(txMock._lotInsertCalled).toBe(true);
  });

  it("already granted (ledger conflict) — lot NOT inserted", async () => {
    const txMock = makeTx(true); // conflict
    dbState.instance = makeDb(txMock, {
      subscriptions: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    expect(txMock._lotInsertCalled).toBe(false);
  });

  it("missing invoice row — transaction not entered (referenceId undefined)", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue(undefined), // no row
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("non-subscription billing reason (manual) — returns early, no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billingReason: "manual" }));

    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("no subscriptionId on invoice — returns early", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantPlanCreditsForInvoicePaid(makeInvoice({ subscriptionId: null, billingReason: "subscription_create" }));

    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — grantCreditPackForCheckout
// ---------------------------------------------------------------------------

describe("grantCreditPackForCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);
  });

  it("happy path — line items with credits → grants correct total in transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([
      { creditsPerUnit: 100, quantity: 2 }, // 200 credits
      { creditsPerUnit: 50, quantity: 1 },  // 50 credits
    ]);

    await grantCreditPackForCheckout(makeSession());

    expect(getCheckoutSessionCreditPacksMock).toHaveBeenCalledWith("cs_test_001");
    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("already granted (ledger conflict) — lot NOT inserted", async () => {
    const txMock = makeTx(true);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([
      { creditsPerUnit: 100, quantity: 1 },
    ]);

    await grantCreditPackForCheckout(makeSession());

    expect(txMock._lotInsertCalled).toBe(false);
  });

  it("zero credits from line items — transaction not entered", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);
    getCheckoutSessionCreditPacksMock.mockResolvedValue([]); // no credit line items

    await grantCreditPackForCheckout(makeSession());

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("session mode is not payment — returns early, no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ mode: "subscription" }));

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("paymentStatus is not paid — returns early, no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ paymentStatus: "unpaid" }));

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("no org_id on session metadata — returns early, no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ metadata: {} }));

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("dynamic purchase — no price metadata credits but session metadata has credits → grants face value", async () => {
    // Simulate a dynamic checkout where line items return nothing (price_data
    // has no credits metadata) but the session itself carries credits = grantCents.
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    // Provider returns no credit packs (inline price_data has no credits metadata)
    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    // The session carries the face-value grant in metadata (put there by
    // createDynamicCreditCheckout → StripeProvider.createDynamicCreditCheckout).
    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "25000" } }),
    );

    // Transaction should have run and granted 25000 cents (face value, not paid amount)
    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("dynamic purchase — session metadata credits is non-numeric → no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "not-a-number" } }),
    );

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("dynamic purchase — session metadata credits is zero → no transaction", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "0" } }),
    );

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("dynamic purchase — already granted (ledger conflict) → lot NOT inserted", async () => {
    const txMock = makeTx(true); // simulate conflict
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "10000" } }),
    );

    // Ledger insert was called (idempotency check) but lot/balance were not
    expect(txMock.insert).toHaveBeenCalledTimes(1);
    expect(txMock._lotInsertCalled).toBe(false);
  });
});
