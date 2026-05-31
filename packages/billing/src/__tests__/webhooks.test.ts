/**
 * Unit tests for processStripeEvent (packages/billing/src/webhooks.ts).
 *
 * Mocks at the DB adapter seam — no live Postgres, no Stripe API.
 *
 * Scenarios:
 *  1. First receipt of an event → inserts to stripe_events → dispatches
 *     business logic → writes stripe_event_processing → returns "applied".
 *  2. Duplicate event (same stripe_event_id already in DB) → ON CONFLICT DO
 *     NOTHING yields zero rows → returns "duplicate" without dispatching.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import of the module under test.
// ---------------------------------------------------------------------------

// Spy that captures the callback passed to syncSubscriptionFromStripe.
const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
const syncInvoiceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../subscriptions.js", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

vi.mock("../invoices.js", () => ({
  syncInvoiceFromStripe: syncInvoiceMock,
}));

// Stripe client mock — processStripeEvent itself doesn't call stripeClient()
// but the module imports it transitively. We stub to prevent env look-ups.
vi.mock("../client.js", () => ({
  stripeClient: vi.fn(() => ({
    webhooks: { constructEvent: vi.fn() },
  })),
}));

// Config mock to prevent env-var validation at import time.
vi.mock("@oxagen/config/env", () => ({
  requireEnv: vi.fn(() => ({ STRIPE_WEBHOOK_SECRET: "whsec_test" })),
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal DB mock for processStripeEvent.
 *
 * The function:
 *  1. d.insert(schema.stripeEvents).values(...).onConflictDoNothing(...).returning(...)
 *  2. d.insert(schema.stripeEventProcessing).values(...).onConflictDoUpdate(...) [success path]
 *     OR d.insert(schema.stripeEventProcessing).values(...).onConflictDoUpdate(...) [error path]
 *
 * `insertedRows` controls what `.returning()` on the first insert yields.
 * An empty array simulates a duplicate (ON CONFLICT DO NOTHING, no row back).
 */
function makeDb(
  insertedRows: Array<{ id: string }> = [{ id: "row-uuid-1" }],
  opts: { existingEventId?: string | null; processedAt?: Date | null } = {},
) {
  // Processing insert chain (no .returning needed, just resolves).
  const processingInsertChain = {
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };

  let callIdx = 0;
  const insertFn = vi.fn(() => {
    callIdx++;
    if (callIdx === 1) {
      // First insert: stripe_events
      return {
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(insertedRows),
          }),
        }),
      };
    }
    // Subsequent inserts: stripe_event_processing
    return {
      values: vi.fn().mockReturnValue(processingInsertChain),
    };
  });

  return {
    insert: insertFn,
    query: {
      subscriptions: { findFirst: vi.fn().mockResolvedValue(null) },
      // Re-entrancy lookups used when the event row already exists.
      stripeEvents: {
        findFirst: vi.fn().mockResolvedValue(
          opts.existingEventId === undefined ? null : opts.existingEventId === null ? null : { id: opts.existingEventId },
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
const { processStripeEvent } = await import("../webhooks.js");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeStripeEvent(overrides: Partial<Stripe.Event> = {}): Stripe.Event {
  return {
    id: "evt_test_001",
    object: "event",
    type: "customer.subscription.created",
    api_version: "2025-02-24.acacia",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: { id: "sub_test_001", object: "subscription" } as Stripe.Subscription,
    },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    ...overrides,
  } as unknown as Stripe.Event;
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

    const event = makeStripeEvent({ id: "evt_first_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    // Stripe event insert was called.
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
    // syncSubscriptionFromStripe was dispatched for the subscription event.
    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    // Processing row was written.
    expect(dbState.instance!._processingInsertChain.onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it("already-processed duplicate — conflict + processed row → 'duplicate', no dispatch", async () => {
    // Empty array from .returning() = ON CONFLICT DO NOTHING; the event was
    // already processed successfully (processedAt set), so it's a true dupe.
    dbState.instance = makeDb([], { existingEventId: "evt-row-1", processedAt: new Date() });

    const event = makeStripeEvent({ id: "evt_dupe_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "duplicate" });
    // Only the first insert (stripe_events) should have been called.
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(1);
    // Business logic must NOT run.
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("retry after a failed dispatch — conflict + no processed row → re-dispatches → 'applied'", async () => {
    // Event row exists but was never processed successfully (processedAt null):
    // a Stripe retry must re-enter dispatch and self-heal.
    dbState.instance = makeDb([], { existingEventId: "evt-row-2", processedAt: null });

    const event = makeStripeEvent({ id: "evt_retry_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_test_001");
    // Event insert (no-op conflict) + processing-row upsert.
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
  });

  it("invoice.paid event dispatches syncInvoiceFromStripe", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-2" }]);

    const event = makeStripeEvent({
      id: "evt_inv_001",
      type: "invoice.paid",
      data: { object: { id: "in_test_001", object: "invoice" } as Stripe.Invoice },
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_test_001");
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("unhandled event type — event is stored but no dispatcher is invoked, returns 'applied'", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-3" }]);

    // Use `customer.subscription.created` as base and override type via
    // unknown cast so the test exercises the default branch of the dispatch
    // switch without triggering TS union exhaustiveness errors.
    const event = {
      ...makeStripeEvent({ id: "evt_unknown_001" }),
      type: "charge.succeeded",
    } as unknown as Stripe.Event;

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(syncInvoiceMock).not.toHaveBeenCalled();
  });
});
