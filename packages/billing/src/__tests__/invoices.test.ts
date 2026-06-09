/**
 * Unit tests for syncInvoiceFromStripe (packages/billing/src/invoices.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider() (neutral BillingProvider interface)
 *
 * Scenarios:
 *  1. Happy path with org_id in metadata — upserts invoice + replaces line items.
 *  2. Upsert idempotency — calling twice with same invoice id runs the same
 *     upsert path (ON CONFLICT DO UPDATE), no duplicate write.
 *  3. No org_id in metadata, no subscription row → function returns early;
 *     no DB writes.
 *  4. Empty line items array — delete runs but insert skipped.
 *  5. Line items replace within transaction — delete is called before insert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingInvoice } from "../provider";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const getInvoiceMock = vi.fn();

vi.mock("../client", () => ({
  billingProvider: () => ({
    getInvoice: getInvoiceMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

function makeDb(opts: {
  subscriptionRow?: { orgId: string; id: string } | null;
  invoiceInsertedId?: string | null;
} = {}) {
  const subscriptionRow =
    opts.subscriptionRow !== undefined
      ? opts.subscriptionRow
      : { orgId: "org-abc", id: "sub-internal-1" };
  const invoiceInsertedId =
    opts.invoiceInsertedId !== undefined ? opts.invoiceInsertedId : "invoice-uuid-1";

  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const insertLineItemsChain = {
    values: vi.fn().mockResolvedValue(undefined),
  };
  const insertInvoiceChain = {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(
          invoiceInsertedId ? [{ id: invoiceInsertedId }] : [],
        ),
      }),
    }),
  };

  const callLog: string[] = [];
  let insertCallIdx = 0;

  const insertFn = vi.fn(() => {
    insertCallIdx++;
    if (insertCallIdx === 1) {
      callLog.push("invoice-insert");
      return insertInvoiceChain;
    }
    callLog.push("line-item-insert");
    return insertLineItemsChain;
  });

  const deleteFn = vi.fn(() => {
    callLog.push("line-item-delete");
    return deleteChain;
  });

  return {
    query: {
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue(subscriptionRow ?? undefined),
      },
    },
    // withSystemDb passes the instance as tx; syncInvoiceFromStripe calls
    // insert/delete directly on tx (no nested transaction anymore).
    insert: insertFn,
    delete: deleteFn,
    // Keep a no-op transaction stub so any stray calls don't hard-fail.
    transaction: vi.fn((cb: (tx: unknown) => Promise<void>) => cb({ insert: insertFn, delete: deleteFn })),
    _txInsert: insertFn,
    _txDelete: deleteFn,
    _callLog: callLog,
  };
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  db: () => dbState.instance,
  withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),

  };
});

// Import after mocks.
const { syncInvoiceFromStripe } = await import("../invoices");

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
    periodStart: new Date(Date.now() - 86400 * 1000),
    periodEnd: new Date(),
    dueAt: null,
    paidAt: new Date(),
    hostedInvoiceUrl: "https://invoice.stripe.com/i/abc",
    invoicePdfUrl: "https://invoice.stripe.com/i/abc/pdf",
    subscriptionId: "sub_test_001",
    orgId: "org-abc",
    billingReason: "subscription_create",
    lineItems: [
      {
        description: "Pro plan",
        quantity: 1,
        unitAmountCents: 1000,
        totalCents: 1000,
        metric: null,
        metadata: {},
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncInvoiceFromStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — upserts invoice row and inserts line items inside withSystemDb", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice());

    await syncInvoiceFromStripe("in_test_001");

    // withSystemDb mock passes instance as tx; insert is called twice (invoice + line items)
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(2);
    expect(dbState.instance!._txDelete).toHaveBeenCalledOnce();
  });

  it("upsert idempotency — second call runs same upsert path without error", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice());

    await syncInvoiceFromStripe("in_test_001");
    dbState.instance = makeDb();
    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(2);
  });

  it("no org_id and no subscription row — returns early, no insert", async () => {
    dbState.instance = makeDb({ subscriptionRow: null });
    getInvoiceMock.mockResolvedValue(
      makeInvoice({ orgId: null, subscriptionId: "sub_orphan" }),
    );
    dbState.instance.query.subscriptions.findFirst = vi.fn().mockResolvedValue(undefined);

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txInsert).not.toHaveBeenCalled();
  });

  it("empty line items — delete runs but line-item insert is skipped", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice({ lineItems: [] }));

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txDelete).toHaveBeenCalledOnce();
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(1);
  });

  it("line items replace — delete is called before line-item insert", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice());

    await syncInvoiceFromStripe("in_test_001");

    const log = dbState.instance!._callLog;
    const deleteIdx = log.indexOf("line-item-delete");
    const insertIdx = log.indexOf("line-item-insert");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });
});
