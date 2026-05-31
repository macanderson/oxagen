/**
 * Unit tests for syncInvoiceFromStripe (packages/billing/src/invoices.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → stripeClient() (no live Stripe API)
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
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Stripe client mock
// ---------------------------------------------------------------------------

const stripeInvoicesMock = { retrieve: vi.fn() };

vi.mock("../client.js", () => ({
  stripeClient: () => ({ invoices: stripeInvoicesMock }),
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a db() mock that captures calls to tx.insert / tx.delete.
 * We track insertion call order so we can assert delete-before-insert.
 */
function makeDb(opts: {
  orgId?: string | null;
  subscriptionRow?: { orgId: string; id: string } | null;
  invoiceInsertedId?: string | null;
} = {}) {
  const orgId = opts.orgId !== undefined ? opts.orgId : "org-abc";
  const subscriptionRow =
    opts.subscriptionRow !== undefined
      ? opts.subscriptionRow
      : { orgId: "org-abc", id: "sub-internal-1" };
  const invoiceInsertedId =
    opts.invoiceInsertedId !== undefined ? opts.invoiceInsertedId : "invoice-uuid-1";

  const txDeleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  const txInsertLineItemsChain = {
    values: vi.fn().mockResolvedValue(undefined),
  };

  // Track which insert call was for invoice vs line items.
  const txInsertInvoiceChain = {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(
          invoiceInsertedId ? [{ id: invoiceInsertedId }] : [],
        ),
      }),
    }),
  };

  const txCallLog: string[] = [];

  let txInsertCallIdx = 0;
  const txInsert = vi.fn(() => {
    txInsertCallIdx++;
    if (txInsertCallIdx === 1) {
      txCallLog.push("invoice-insert");
      return txInsertInvoiceChain;
    }
    txCallLog.push("line-item-insert");
    return txInsertLineItemsChain;
  });

  const txDelete = vi.fn(() => {
    txCallLog.push("line-item-delete");
    return txDeleteChain;
  });

  const txProxy = { insert: txInsert, delete: txDelete };

  const db = {
    query: {
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue(subscriptionRow ?? undefined),
      },
    },
    transaction: vi.fn((cb: (tx: typeof txProxy) => Promise<void>) => cb(txProxy)),
    _txInsert: txInsert,
    _txDelete: txDelete,
    _callLog: txCallLog,
    _txInsertInvoiceChain: txInsertInvoiceChain,
    _txInsertLineItemsChain: txInsertLineItemsChain,
    _txDeleteChain: txDeleteChain,
  };

  return db;
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", () => ({
  db: () => dbState.instance,
  schema: {
    invoices: {
      stripeInvoiceId: "invoices.stripeInvoiceId",
    },
    invoiceLineItems: {
      invoiceId: "invoiceLineItems.invoiceId",
    },
    subscriptions: {
      stripeSubscriptionId: "subscriptions.stripeSubscriptionId",
    },
  },
}));

// Import after mocks.
const { syncInvoiceFromStripe } = await import("../invoices.js");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeStripeInvoice(
  overrides: {
    metadata?: Record<string, string>;
    subscription?: string | null;
    status?: string;
    lines?: Stripe.InvoiceLineItem[];
  } = {},
): Stripe.Invoice {
  const lines = overrides.lines ?? [
    {
      id: "il_001",
      object: "line_item",
      amount: 1000,
      quantity: 1,
      description: "Pro plan",
      price: { id: "price_001", object: "price", unit_amount: 1000 } as Stripe.Price,
      metadata: {},
    } as unknown as Stripe.InvoiceLineItem,
  ];

  return {
    id: "in_test_001",
    object: "invoice",
    status: overrides.status ?? "paid",
    metadata: overrides.metadata ?? { org_id: "org-abc" },
    subscription: overrides.subscription !== undefined ? overrides.subscription : "sub_test_001",
    number: "INV-001",
    amount_due: 2000,
    amount_paid: 2000,
    amount_remaining: 0,
    currency: "usd",
    period_start: Math.floor(Date.now() / 1000) - 86400,
    period_end: Math.floor(Date.now() / 1000),
    due_date: null,
    status_transitions: { paid_at: null },
    hosted_invoice_url: "https://invoice.stripe.com/i/abc",
    invoice_pdf: "https://invoice.stripe.com/i/abc/pdf",
    lines: {
      object: "list",
      data: lines,
      has_more: false,
      url: "/v1/invoices/in_test_001/lines",
    },
  } as unknown as Stripe.Invoice;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncInvoiceFromStripe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path — upserts invoice row and inserts line items inside transaction", async () => {
    dbState.instance = makeDb();
    stripeInvoicesMock.retrieve.mockResolvedValue(makeStripeInvoice());

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    // Invoice upsert + line item insert both happened.
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(2);
    expect(dbState.instance!._txDelete).toHaveBeenCalledOnce();
  });

  it("upsert idempotency — second call runs same upsert path without error", async () => {
    dbState.instance = makeDb();
    stripeInvoicesMock.retrieve.mockResolvedValue(makeStripeInvoice());

    await syncInvoiceFromStripe("in_test_001");
    // Reset call counts to simulate second invocation cleanly.
    dbState.instance = makeDb();
    await syncInvoiceFromStripe("in_test_001");

    // Second call also commits a transaction with the same upsert shape.
    expect(dbState.instance!.transaction).toHaveBeenCalledOnce();
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(2);
  });

  it("no org_id in metadata and no subscription row — returns early, no transaction", async () => {
    dbState.instance = makeDb({ orgId: null, subscriptionRow: null });
    stripeInvoicesMock.retrieve.mockResolvedValue(
      makeStripeInvoice({ metadata: {}, subscription: "sub_orphan" }),
    );
    // The subscription query returns null (no row for sub_orphan).
    dbState.instance.query.subscriptions.findFirst = vi.fn().mockResolvedValue(undefined);

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!.transaction).not.toHaveBeenCalled();
  });

  it("empty line items — delete runs but line-item insert is skipped", async () => {
    dbState.instance = makeDb();
    stripeInvoicesMock.retrieve.mockResolvedValue(makeStripeInvoice({ lines: [] }));

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txDelete).toHaveBeenCalledOnce();
    // Only the invoice insert (call 1); the line-item insert (call 2) is skipped.
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(1);
  });

  it("line items replace — delete is called before line-item insert", async () => {
    dbState.instance = makeDb();
    stripeInvoicesMock.retrieve.mockResolvedValue(makeStripeInvoice());

    await syncInvoiceFromStripe("in_test_001");

    const log = dbState.instance!._callLog;
    const deleteIdx = log.indexOf("line-item-delete");
    const insertIdx = log.indexOf("line-item-insert");

    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(insertIdx).toBeGreaterThan(deleteIdx);
  });
});
