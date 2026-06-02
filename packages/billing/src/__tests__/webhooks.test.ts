/**
 * Unit tests for processStripeEvent (packages/billing/src/webhooks.ts).
 *
 * Mocks at the DB adapter seam — no live Postgres, no Stripe API.
 *
 * Scenarios:
 *  1. First receipt of an event → inserts to stripe_events → dispatches
 *     business logic → writes stripe_event_processing → returns "applied".
 *  2. Duplicate event (same providerEventId already in DB) → ON CONFLICT DO
 *     NOTHING yields zero rows → returns "duplicate" without dispatching.
 *  3. Retry after failed dispatch → conflict + no processed row → re-dispatches.
 *  4. invoice.paid event dispatches syncInvoiceFromStripe.
 *  5. Unhandled event type → stored, no dispatcher, returns "applied".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingWebhookEvent } from "../provider";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import of the module under test.
// ---------------------------------------------------------------------------

const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
const syncInvoiceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../subscriptions", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

vi.mock("../invoices", () => ({
  syncInvoiceFromStripe: syncInvoiceMock,
}));

// billingProvider is only used by verifyStripeSignature in webhooks.ts (not
// by processStripeEvent itself), so a minimal mock suffices.
vi.mock("../client", () => ({
  billingProvider: vi.fn(() => ({
    parseWebhookEvent: vi.fn(),
  })),
}));

// Mock grants so their internal syncSubscriptionFromStripe calls don't leak
// into webhook dispatch assertions. Grant correctness is tested in grants.test.ts.
vi.mock("../grants", () => ({
  grantPlanCreditsForInvoicePaid: vi.fn().mockResolvedValue(undefined),
  grantCreditPackForCheckout: vi.fn().mockResolvedValue(undefined),
  grantFreeCredits: vi.fn().mockResolvedValue(undefined),
}));

// Config mock to prevent env-var validation at import time.
vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" })),
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

function makeDb(
  insertedRows: Array<{ id: string }> = [{ id: "row-uuid-1" }],
  opts: { existingEventId?: string | null; processedAt?: Date | null } = {},
) {
  const processingInsertChain = {
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };

  let callIdx = 0;
  const insertFn = vi.fn(() => {
    callIdx++;
    if (callIdx === 1) {
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(insertedRows),
          }),
        }),
      };
    }
    return {
      values: vi.fn().mockReturnValue(processingInsertChain),
    };
  });

  return {
    insert: insertFn,
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    query: {
      subscriptions: { findFirst: vi.fn().mockResolvedValue(null) },
      stripeEvents: {
        findFirst: vi.fn().mockResolvedValue(
          opts.existingEventId === undefined
            ? null
            : opts.existingEventId === null
              ? null
              : { id: opts.existingEventId },
        ),
      },
      stripeEventProcessing: {
        findFirst: vi.fn().mockResolvedValue(
          opts.processedAt === undefined ? null : { processedAt: opts.processedAt },
        ),
      },
    },
    _processingInsertChain: processingInsertChain,
    _callIdx: () => callIdx,
  };
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", () => ({
  db: () => dbState.instance,
  schema: {
    stripeEvents: { stripeEventId: "stripeEvents.stripeEventId" },
    stripeEventProcessing: {
      stripeEventId: "stripeEventProcessing.stripeEventId",
    },
    subscriptions: { stripeCustomerId: "subscriptions.stripeCustomerId" },
    paymentMethods: { stripePaymentMethodId: "paymentMethods.stripePaymentMethodId" },
  },
}));

// Import after mocks.
const { processStripeEvent } = await import("../webhooks");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeWebhookEvent(overrides: Partial<BillingWebhookEvent> = {}): BillingWebhookEvent {
  return {
    providerEventId: "evt_test_001",
    apiVersion: "2025-02-24.acacia",
    type: "subscription.created",
    rawPayload: { id: "evt_test_001" },
    subscriptionId: "sub_test_001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processStripeEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncSubscriptionMock.mockReset().mockResolvedValue(undefined);
    syncInvoiceMock.mockReset().mockResolvedValue(undefined);
  });

  it("first receipt — inserts event, dispatches, writes processing row, returns 'applied'", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-1" }]);

    const event = makeWebhookEvent({ providerEventId: "evt_first_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    expect(dbState.instance!._processingInsertChain.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("already-processed duplicate — conflict + processed row → 'duplicate', no dispatch", async () => {
    dbState.instance = makeDb([], { existingEventId: "evt-row-1", processedAt: new Date() });

    const event = makeWebhookEvent({ providerEventId: "evt_dupe_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "duplicate" });
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(1);
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("retry after a failed dispatch — conflict + no processed row → re-dispatches → 'applied'", async () => {
    dbState.instance = makeDb([], { existingEventId: "evt-row-2", processedAt: null });

    const event = makeWebhookEvent({ providerEventId: "evt_retry_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
  });

  it("invoice.paid event dispatches syncInvoiceFromStripe", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-2" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_inv_001",
      type: "invoice.paid",
      subscriptionId: undefined,
      invoice: {
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
      },
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_test_001");
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("unhandled event type — event is stored but no dispatcher is invoked, returns 'applied'", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-3" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_unknown_001",
      type: "unknown",
      subscriptionId: undefined,
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(syncInvoiceMock).not.toHaveBeenCalled();
  });
});
