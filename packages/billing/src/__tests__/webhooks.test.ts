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
 *  4. invoice.paid event dispatches syncInvoiceFromStripe + dunning recovery.
 *  5. invoice.payment_failed dispatches syncInvoiceFromStripe + dunning entry.
 *  6. subscription.trial_will_end syncs subscription.
 *  7. invoice.voided / invoice.finalized / invoice.marked_uncollectible sync invoice.
 *  8. invoice.payment_action_required syncs invoice (SCA warning).
 *  9. payment_method.updated: upserts payment method.
 *  10. dispute.created / dispute.closed dispatch dunning handlers.
 *  11. charge.refunded dispatches onChargeRefunded.
 *  12. Unhandled event type → stored, no dispatcher, returns "applied".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingWebhookEvent, BillingDispute, BillingRefundedCharge } from "../provider";

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
const grantPlanCreditsForInvoicePaidMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../grants", () => ({
  grantPlanCreditsForInvoicePaid: grantPlanCreditsForInvoicePaidMock,
  grantCreditPackForCheckout: vi.fn().mockResolvedValue(undefined),
  grantFreeCredits: vi.fn().mockResolvedValue(undefined),
}));

// Mock dunning handlers.
const onInvoicePaymentFailedMock = vi.fn().mockResolvedValue(undefined);
const onInvoiceRecoveredMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../dunning", () => ({
  onInvoicePaymentFailed: onInvoicePaymentFailedMock,
  onInvoiceRecovered: onInvoiceRecoveredMock,
}));

// Mock dispute handlers.
const onDisputeCreatedMock = vi.fn().mockResolvedValue(undefined);
const onDisputeClosedMock = vi.fn().mockResolvedValue(undefined);
const onChargeRefundedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../disputes", () => ({
  onDisputeCreated: onDisputeCreatedMock,
  onDisputeClosed: onDisputeClosedMock,
  onChargeRefunded: onChargeRefundedMock,
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
      orgBillingSettings: { findFirst: vi.fn().mockResolvedValue(null) },
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
  withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
  schema: {
    stripeEvents: { stripeEventId: "stripeEvents.stripeEventId" },
    stripeEventProcessing: {
      stripeEventId: "stripeEventProcessing.stripeEventId",
    },
    subscriptions: { stripeCustomerId: "subscriptions.stripeCustomerId" },
    paymentMethods: { stripePaymentMethodId: "paymentMethods.stripePaymentMethodId" },
    orgBillingSettings: { orgId: "orgBillingSettings.orgId", dunningState: "orgBillingSettings.dunningState" },
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

  it("invoice.paid event dispatches syncInvoiceFromStripe + dunning recovery", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-2" }]);

    const invoice = {
      id: "in_test_001",
      providerInvoiceId: "in_test_001",
      number: "INV-001",
      status: "paid" as const,
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
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_inv_001",
      type: "invoice.paid",
      subscriptionId: undefined,
      invoice,
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_test_001");
    expect(grantPlanCreditsForInvoicePaidMock).toHaveBeenCalledWith(invoice);
    expect(onInvoiceRecoveredMock).toHaveBeenCalledWith(invoice);
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed dispatches syncInvoiceFromStripe + dunning entry", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-3" }]);

    const invoice = {
      id: "in_failed_001",
      providerInvoiceId: "in_failed_001",
      number: "INV-002",
      status: "open" as const,
      amountDueCents: 2000,
      amountPaidCents: 0,
      amountRemainingCents: 2000,
      currency: "usd",
      periodStart: new Date(),
      periodEnd: new Date(),
      dueAt: null,
      paidAt: null,
      hostedInvoiceUrl: null,
      invoicePdfUrl: null,
      subscriptionId: "sub_test_001",
      orgId: "org-abc",
      billingReason: "subscription_cycle",
      lineItems: [],
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_fail_001",
      type: "invoice.payment_failed",
      subscriptionId: undefined,
      invoice,
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_failed_001");
    expect(onInvoicePaymentFailedMock).toHaveBeenCalledWith(invoice);
    expect(onInvoiceRecoveredMock).not.toHaveBeenCalled();
  });

  it("subscription.trial_will_end syncs subscription and returns 'applied'", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-4" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_trial_001",
      type: "subscription.trial_will_end",
      subscriptionId: "sub_trial_001",
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    expect(syncSubscriptionMock).toHaveBeenCalledWith("sub_trial_001");
  });

  it("invoice.voided syncs invoice", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-5" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_void_001",
      type: "invoice.voided",
      subscriptionId: undefined,
      invoice: {
        id: "in_void_001",
        providerInvoiceId: "in_void_001",
        number: "INV-003",
        status: "void" as const,
        amountDueCents: 0,
        amountPaidCents: 0,
        amountRemainingCents: 0,
        currency: "usd",
        periodStart: new Date(),
        periodEnd: new Date(),
        dueAt: null,
        paidAt: null,
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
        subscriptionId: null,
        orgId: "org-abc",
        billingReason: null,
        lineItems: [],
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_void_001");
  });

  it("invoice.finalized syncs invoice", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-6" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_final_001",
      type: "invoice.finalized",
      subscriptionId: undefined,
      invoice: {
        id: "in_final_001",
        providerInvoiceId: "in_final_001",
        number: "INV-004",
        status: "open" as const,
        amountDueCents: 1000,
        amountPaidCents: 0,
        amountRemainingCents: 1000,
        currency: "usd",
        periodStart: new Date(),
        periodEnd: new Date(),
        dueAt: null,
        paidAt: null,
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
        subscriptionId: null,
        orgId: "org-abc",
        billingReason: null,
        lineItems: [],
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_final_001");
  });

  it("invoice.payment_action_required syncs invoice (SCA needed)", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-7" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_sca_001",
      type: "invoice.payment_action_required",
      subscriptionId: undefined,
      invoice: {
        id: "in_sca_001",
        providerInvoiceId: "in_sca_001",
        number: "INV-005",
        status: "open" as const,
        amountDueCents: 2000,
        amountPaidCents: 0,
        amountRemainingCents: 2000,
        currency: "usd",
        periodStart: new Date(),
        periodEnd: new Date(),
        dueAt: null,
        paidAt: null,
        hostedInvoiceUrl: null,
        invoicePdfUrl: null,
        subscriptionId: null,
        orgId: "org-abc",
        billingReason: null,
        lineItems: [],
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_sca_001");
  });

  it("payment_method.updated upserts the payment method", async () => {
    // The upsertPaymentMethod function looks up a subscription by customerId.
    dbState.instance = makeDb([{ id: "row-uuid-8" }]);
    dbState.instance!.query.subscriptions.findFirst = vi.fn().mockResolvedValue({ orgId: "org-abc" });

    const event = makeWebhookEvent({
      providerEventId: "evt_pm_updated_001",
      type: "payment_method.updated",
      subscriptionId: undefined,
      paymentMethod: {
        id: "pm_test_001",
        customerId: "cus_test_001",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 12,
        expYear: 2028,
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
  });

  it("dispute.created dispatches onDisputeCreated", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-9" }]);

    const dispute: BillingDispute = {
      id: "dp_test_001",
      chargeId: "ch_test_001",
      paymentIntentId: "pi_test_001",
      amountCents: 5000,
      currency: "usd",
      reason: "fraudulent",
      status: "needs_response",
      orgId: "org-abc",
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_dispute_created_001",
      type: "dispute.created",
      subscriptionId: undefined,
      dispute,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(onDisputeCreatedMock).toHaveBeenCalledWith(dispute);
    expect(onDisputeClosedMock).not.toHaveBeenCalled();
  });

  it("dispute.closed dispatches onDisputeClosed", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-10" }]);

    const dispute: BillingDispute = {
      id: "dp_test_002",
      chargeId: "ch_test_002",
      paymentIntentId: "pi_test_002",
      amountCents: 3000,
      currency: "usd",
      reason: "duplicate",
      status: "won",
      orgId: "org-abc",
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_dispute_closed_001",
      type: "dispute.closed",
      subscriptionId: undefined,
      dispute,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(onDisputeClosedMock).toHaveBeenCalledWith(dispute);
    expect(onDisputeCreatedMock).not.toHaveBeenCalled();
  });

  it("charge.refunded dispatches onChargeRefunded", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-12" }]);

    const refundedCharge: BillingRefundedCharge = {
      id: "ch_refund_001",
      paymentIntentId: "pi_refund_001",
      amountRefundedCents: 1500,
      currency: "usd",
      orgId: "org-abc",
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_charge_refunded_001",
      type: "charge.refunded",
      subscriptionId: undefined,
      refundedCharge,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(onChargeRefundedMock).toHaveBeenCalledWith(refundedCharge);
    expect(onDisputeCreatedMock).not.toHaveBeenCalled();
    expect(onDisputeClosedMock).not.toHaveBeenCalled();
  });

  it("unhandled event type — event is stored but no dispatcher is invoked, returns 'applied'", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-11" }]);

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
