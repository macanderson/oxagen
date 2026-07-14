/**
 * Unit tests for syncInvoiceFromStripe (packages/billing/src/invoices.ts).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → billingProvider() (neutral BillingProvider interface)
 *
 * Scenarios:
 *  1. Happy path with org_id in metadata — upserts the invoice header row.
 *  2. Upsert idempotency — calling twice with same invoice id runs the same
 *     upsert path (ON CONFLICT DO UPDATE), no duplicate write.
 *  3. No org_id in metadata, no subscription row → function returns early;
 *     no DB writes.
 *  4. Provider line items are NOT mirrored — billing.invoice_line_items was
 *     dropped (migration 20260802130000); receipts read line items straight
 *     off the provider payload and the UI links to the Stripe-hosted invoice.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingInvoice } from "./provider";

// ---------------------------------------------------------------------------
// BillingProvider mock
// ---------------------------------------------------------------------------

const getInvoiceMock = vi.fn();

vi.mock("./client", () => ({
  billingProvider: () => ({
    getInvoice: getInvoiceMock,
  }),
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

function makeDb(
  opts: { subscriptionRow?: { orgId: string; id: string } | null } = {},
) {
  const subscriptionRow =
    opts.subscriptionRow !== undefined
      ? opts.subscriptionRow
      : { orgId: "org-abc", id: "sub-internal-1" };

  const insertInvoiceChain = {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const insertFn = vi.fn(() => insertInvoiceChain);
  const deleteFn = vi.fn();

  return {
    query: {
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue(subscriptionRow ?? undefined),
      },
    },
    // withSystemDb passes the instance as tx; syncInvoiceFromStripe calls
    // insert directly on tx (no nested transaction).
    insert: insertFn,
    delete: deleteFn,
    _txInsert: insertFn,
    _txDelete: deleteFn,
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
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
  };
});

// Import after mocks.
const { syncInvoiceFromStripe } = await import("./invoices");

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

  it("happy path — upserts the invoice header row inside withSystemDb", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice());

    await syncInvoiceFromStripe("in_test_001");

    // Exactly one insert (the header upsert); nothing is deleted.
    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(1);
    expect(dbState.instance!._txDelete).not.toHaveBeenCalled();
  });

  it("upsert idempotency — second call runs same upsert path without error", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice());

    await syncInvoiceFromStripe("in_test_001");
    dbState.instance = makeDb();
    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(1);
  });

  it("no org_id and no subscription row — returns early, no insert", async () => {
    dbState.instance = makeDb({ subscriptionRow: null });
    getInvoiceMock.mockResolvedValue(
      makeInvoice({ orgId: null, subscriptionId: "sub_orphan" }),
    );
    dbState.instance.query.subscriptions.findFirst = vi
      .fn()
      .mockResolvedValue(undefined);

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txInsert).not.toHaveBeenCalled();
  });

  it("provider line items are ignored — only the header row is written", async () => {
    dbState.instance = makeDb();
    getInvoiceMock.mockResolvedValue(makeInvoice()); // fixture carries 1 line item

    await syncInvoiceFromStripe("in_test_001");

    expect(dbState.instance!._txInsert).toHaveBeenCalledTimes(1);
    expect(dbState.instance!._txDelete).not.toHaveBeenCalled();
  });
});
