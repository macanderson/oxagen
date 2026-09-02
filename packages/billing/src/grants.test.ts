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
import type { BillingCheckoutSession, BillingInvoice } from "./provider";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

// Logger mock — lets tests assert on warn emissions for silent-failure paths.
const loggerWarnMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerDebugMock = vi.fn();
vi.mock("./logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    debug: loggerDebugMock,
    error: vi.fn(),
  },
}));

const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./subscriptions", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

// grantPlanCreditsForInvoicePaid self-heals the local invoice row before keying
// the grant on it (webhook events can arrive out of order). Default no-op; the
// out-of-order test overrides it to materialise the invoice row.
const syncInvoiceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./invoices", () => ({
  syncInvoiceFromStripe: syncInvoiceMock,
}));

// billingProvider mock — only getCheckoutSessionCreditPacks is used in grants.
const getCheckoutSessionCreditPacksMock = vi.fn().mockResolvedValue([]);
vi.mock("./client", () => ({
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
    // withSystemDb mock passes dbState.instance as tx; expose insert so the
    // functions under test can call tx.insert(...) when withSystemDb is used.
    insert: txMock.insert,
    transaction: vi.fn((fn: (tx: TxMock) => Promise<unknown>) => fn(txMock)),
    query: {
      creditLedger: {
        findFirst:
          queryOverrides.creditLedger ?? vi.fn().mockResolvedValue(undefined),
      },
      subscriptions: {
        findFirst:
          queryOverrides.subscriptions ?? vi.fn().mockResolvedValue(undefined),
      },
      plans: {
        findFirst: queryOverrides.plans ?? vi.fn().mockResolvedValue(undefined),
      },
      invoices: {
        findFirst:
          queryOverrides.invoices ?? vi.fn().mockResolvedValue(undefined),
      },
    },
  };
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = {
  instance: null,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbState.instance,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      dbState.instance?.transaction(fn),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(dbState.instance),
  };
});

// Import after mocks.
const {
  grantFreeCredits,
  grantPlanCreditsForInvoicePaid,
  grantCreditPackForCheckout,
} = await import("./grants");

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

function makeSession(
  overrides: Partial<BillingCheckoutSession> = {},
): BillingCheckoutSession {
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

  it("first grant — lot + ledger + balance written via the system seam", async () => {
    const txMock = makeTx(false); // no conflict
    dbState.instance = makeDb(txMock);

    await grantFreeCredits("org-abc");

    // grantFreeCredits runs via withSystemDb (no tenant scope post-org-creation),
    // so the tenant-path transaction() is NOT used — see grants.scope.test.ts.
    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
    expect(txMock.insert).toHaveBeenCalledTimes(3);
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("already granted (ledger conflict) — lot and balance inserts NOT called", async () => {
    const txMock = makeTx(true); // conflict → 0 rows returned
    dbState.instance = makeDb(txMock);

    await grantFreeCredits("org-abc");

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
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
    syncInvoiceMock.mockReset().mockResolvedValue(undefined);
    // Reset logger mocks.
    loggerWarnMock.mockReset();
    loggerInfoMock.mockReset();
    loggerDebugMock.mockReset();
  });

  it("out-of-order webhook (invoice row not yet synced) — re-syncs invoice, then grants", async () => {
    // Regression for OXA-1611: invoice.paid handled before subscription.created /
    // invoice.created. The invoice carries NO org_id metadata (subscription
    // checkouts only stamp subscription_data.metadata), so the dispatch-time
    // syncInvoiceFromStripe bailed and no local invoice row exists yet. Before
    // the fix the grant exited at "no local invoice row" and the upgrade's
    // credits were silently dropped. The grant must now re-sync the invoice
    // (after syncing the subscription) and deposit the plan credits.
    const txMock = makeTx(false);
    // No local invoice row until syncInvoiceFromStripe runs.
    const invoicesFindFirst = vi.fn().mockResolvedValue(undefined);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 2400 }),
      invoices: invoicesFindFirst,
    });
    // syncInvoiceFromStripe materialises the local invoice row.
    syncInvoiceMock.mockImplementation(async () => {
      invoicesFindFirst.mockResolvedValue({ id: "invoice-uuid-late" });
    });

    // orgId: null mirrors the real subscription-invoice payload (no metadata).
    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ orgId: null, billingReason: "subscription_create" }),
    );

    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_test_001");
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("subscription_create billing reason — grants plan credits via withSystemDb", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_create" }),
    );

    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    // withSystemDb passes dbState.instance as tx; insert is called directly on it.
    expect(txMock.insert).toHaveBeenCalled();
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("subscription_cycle billing reason — grants plan credits", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 3000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-2" }),
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_cycle" }),
    );

    expect(txMock._lotInsertCalled).toBe(true);
  });

  it("already granted (ledger conflict) — lot NOT inserted", async () => {
    const txMock = makeTx(true); // conflict
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    expect(txMock._lotInsertCalled).toBe(false);
  });

  it("missing invoice row — grant not applied (referenceId undefined)", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue(undefined), // no row
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    // No inserts because referenceId is undefined — early return inside withSystemDb.
    expect(txMock._lotInsertCalled).toBe(false);
  });

  it("non-subscription billing reason (manual) — returns early, no grant", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "manual" }),
    );

    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("no subscriptionId on invoice — returns early", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({
        subscriptionId: null,
        billingReason: "subscription_create",
      }),
    );

    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("missing subscription row — emits logger.warn (not silent)", async () => {
    // Verifies fix for grants.ts:204 silent return — previously returned void
    // with no log when the subscription row could not be found.
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi.fn().mockResolvedValue(undefined), // no subscription row
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_create" }),
    );

    expect(txMock._lotInsertCalled).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledOnce();
    expect(loggerWarnMock.mock.calls[0]![1]).toMatch(/no subscription row/);
  });

  it("plan has zero includedCreditCents — emits logger.warn (not silent)", async () => {
    // Verifies fix for grants.ts:210-211: includedCreditCents = 0 previously
    // caused a silent return with no log. A misconfigured plan now surfaces.
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 0 }),
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_create" }),
    );

    expect(txMock._lotInsertCalled).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledOnce();
    expect(loggerWarnMock.mock.calls[0]![1]).toMatch(
      /zero\/null includedCreditCents/,
    );
  });

  it("plan row missing (undefined) — emits logger.warn (not silent)", async () => {
    // plan?.includedCreditCents ?? 0 evaluates to 0 when plan is undefined;
    // the warn must fire in both the plan-missing and the zero-credits cases.
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue(undefined), // plan not found
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_create" }),
    );

    expect(txMock._lotInsertCalled).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledOnce();
    expect(loggerWarnMock.mock.calls[0]![1]).toMatch(
      /zero\/null includedCreditCents/,
    );
  });

  it("missing local invoice row — emits logger.warn (not silent)", async () => {
    // Verifies fix for grants.ts:217-218: missing invoice row previously returned
    // void with no log, silently skipping the credit grant.
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock, {
      subscriptions: vi
        .fn()
        .mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      plans: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      invoices: vi.fn().mockResolvedValue(undefined), // no local invoice row
    });

    await grantPlanCreditsForInvoicePaid(
      makeInvoice({ billingReason: "subscription_create" }),
    );

    expect(txMock._lotInsertCalled).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledOnce();
    expect(loggerWarnMock.mock.calls[0]![1]).toMatch(/no local invoice row/);
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

  it("happy path — line items with credits → grants correct total via withSystemDb", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([
      { creditsPerUnit: 100, quantity: 2 }, // 200 credits
      { creditsPerUnit: 50, quantity: 1 }, // 50 credits
    ]);

    await grantCreditPackForCheckout(makeSession());

    expect(getCheckoutSessionCreditPacksMock).toHaveBeenCalledWith(
      "cs_test_001",
    );
    // withSystemDb passes dbState.instance as tx; insert called directly on it.
    expect(txMock.insert).toHaveBeenCalled();
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

  it("zero credits from line items — no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);
    getCheckoutSessionCreditPacksMock.mockResolvedValue([]); // no credit line items

    await grantCreditPackForCheckout(makeSession());

    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("session mode is not payment — returns early, no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ mode: "subscription" }));

    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("paymentStatus is not paid — returns early, no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ paymentStatus: "unpaid" }));

    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("no org_id on session metadata — returns early, no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    await grantCreditPackForCheckout(makeSession({ metadata: {} }));

    expect(txMock.insert).not.toHaveBeenCalled();
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

    // withSystemDb ran and granted 25000 cents (face value, not paid amount)
    expect(txMock.insert).toHaveBeenCalled();
    expect(txMock._lotInsertCalled).toBe(true);
    expect(txMock._balanceUpsertCalled).toBe(true);
  });

  it("dynamic purchase — session metadata credits is non-numeric → no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "not-a-number" } }),
    );

    expect(txMock.insert).not.toHaveBeenCalled();
  });

  it("dynamic purchase — session metadata credits is zero → no insert", async () => {
    const txMock = makeTx(false);
    dbState.instance = makeDb(txMock);

    getCheckoutSessionCreditPacksMock.mockResolvedValue([]);

    await grantCreditPackForCheckout(
      makeSession({ metadata: { org_id: "org-abc", credits: "0" } }),
    );

    expect(txMock.insert).not.toHaveBeenCalled();
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
