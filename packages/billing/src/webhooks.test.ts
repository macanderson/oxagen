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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FakeGauStore } from "./test-utils/gau-fake-tx";
import type {
  BillingInvoice,
  BillingWebhookEvent,
  BillingDispute,
  BillingRefundedCharge,
} from "./provider";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import of the module under test.
// ---------------------------------------------------------------------------

const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
const syncInvoiceMock = vi.fn().mockResolvedValue(undefined);

vi.mock("./subscriptions", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

vi.mock("./invoices", () => ({
  syncInvoiceFromStripe: syncInvoiceMock,
}));

// billingProvider is only used by verifyStripeSignature in webhooks.ts (not
// by processStripeEvent itself), so a minimal mock suffices.
vi.mock("./client", () => ({
  billingProvider: vi.fn(() => ({
    parseWebhookEvent: vi.fn(),
  })),
}));

// Mock grants so their internal syncSubscriptionFromStripe calls don't leak
// into webhook dispatch assertions. Grant correctness is tested in grants.test.ts.
// The real module is kept so one test can run the real plan-credit grant
// against a governed-action invoice and show it grants nothing.
const grantPlanCreditsForInvoicePaidMock = vi.fn().mockResolvedValue(undefined);
const grantCreditPackForCheckoutMock = vi.fn().mockResolvedValue(undefined);
const realGrants: { module: typeof import("./grants") | null } = {
  module: null,
};
vi.mock("./grants", async (importOriginal) => {
  realGrants.module = await importOriginal<typeof import("./grants")>();
  return {
    grantPlanCreditsForInvoicePaid: grantPlanCreditsForInvoicePaidMock,
    grantCreditPackForCheckout: grantCreditPackForCheckoutMock,
    grantFreeCredits: vi.fn().mockResolvedValue(undefined),
  };
});

// The governed-action Checkout grant (gau-settlements.ts) has its own tests;
// here only the dispatch on the session's oxagen_kind is asserted. The
// settlement writers the invoice branches call are the real ones, running on
// the in-memory GAU store.
const grantGauPurchaseForCheckoutMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./gau-settlements", async (importOriginal) => {
  const real = await importOriginal<typeof import("./gau-settlements")>();
  return {
    ...real,
    grantGauPurchaseForCheckout: grantGauPurchaseForCheckoutMock,
  };
});

// The prepaid-order grant and close (prepaid-orders.ts) have their own
// tests; here only the dispatch on the invoice's prepaid order is asserted.
const grantPrepaidOrderMock = vi.fn().mockResolvedValue(undefined);
const closePrepaidOrderMock = vi.fn().mockResolvedValue(undefined);
vi.mock(
  "./prepaid-orders",
  () =>
    ({
      grantPrepaidOrder: grantPrepaidOrderMock,
      closePrepaidOrder: closePrepaidOrderMock,
    }) satisfies Pick<
      typeof import("./prepaid-orders"),
      "grantPrepaidOrder" | "closePrepaidOrder"
    >,
);

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  const { conditionMocks } = await import("./test-utils/gau-conditions");
  return { ...real, ...conditionMocks };
});

// The grant reads the org's terms on the settlement's transaction.
const readGauEntitlementMock = vi.fn();
vi.mock("./contract-terms", async (importOriginal) => {
  const real = await importOriginal<typeof import("./contract-terms")>();
  return { ...real, readGauEntitlement: readGauEntitlementMock };
});

// Mock dunning handlers. Spread the REAL module so resolveOrgFromInvoice — which
// the real receipts.ts imports — stays available; only the two lifecycle handlers
// are stubbed so their DB writes don't run in this dispatch test.
const onInvoicePaymentFailedMock = vi.fn().mockResolvedValue(undefined);
const onInvoiceRecoveredMock = vi.fn().mockResolvedValue(undefined);
const realDunning: { module: typeof import("./dunning") | null } = {
  module: null,
};
vi.mock("./dunning", async (importOriginal) => {
  const real = await importOriginal<typeof import("./dunning")>();
  realDunning.module = real;
  return {
    ...real,
    onInvoicePaymentFailed: onInvoicePaymentFailedMock,
    onInvoiceRecovered: onInvoiceRecoveredMock,
  };
});

// Mock @oxagen/notifications so the REAL receipts.ts (invoice.paid receipt send)
// runs against a spy instead of a live email transport. paymentFailedTemplate is
// included because the real dunning module (spread above) imports it at load.
const notifyOrgManagersMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: notifyOrgManagersMock,
  paymentReceiptTemplate: vi.fn(() => ({
    subject: "Payment receipt",
    text: "receipt text",
    html: "<html>receipt</html>",
  })),
  paymentFailedTemplate: vi.fn(() => ({
    subject: "Payment failed",
    text: "failed text",
    html: "<html>failed</html>",
  })),
}));

// Mock dispute handlers.
const onDisputeCreatedMock = vi.fn().mockResolvedValue(undefined);
const onDisputeClosedMock = vi.fn().mockResolvedValue(undefined);
const onChargeRefundedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./disputes", () => ({
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
      organizations: {
        findFirst: vi.fn().mockResolvedValue({ name: "Acme Inc" }),
      },
      stripeEvents: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            opts.existingEventId === undefined
              ? null
              : opts.existingEventId === null
                ? null
                : { id: opts.existingEventId },
          ),
      },
      stripeEventProcessing: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            opts.processedAt === undefined
              ? null
              : { processedAt: opts.processedAt },
          ),
      },
    },
    _processingInsertChain: processingInsertChain,
    _callIdx: () => callIdx,
  };
}

const dbState: { instance: ReturnType<typeof makeDb> | null } = {
  instance: null,
};

/** When set, withTenantDb is the real one, which refuses outside a scope. */
const tenantScope: {
  enforced: boolean;
  realWithTenantDb: typeof import("@oxagen/database")["withTenantDb"] | null;
} = { enforced: false, realWithTenantDb: null };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  tenantScope.realWithTenantDb = real.withTenantDb;
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => dbState.instance,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      tenantScope.enforced
        ? tenantScope.realWithTenantDb!(fn)
        : fn(dbState.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbState.instance),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// Import after mocks.
const { processStripeEvent } = await import("./webhooks");
const { settleGauPaid } = await import("./gau-settlements");
// Loaded after the mocks: the fake store imports gau-bucket, which reaches
// every module mocked above.
const { fakeGauExecutor, makeFakeGauStore, makeFakeGauTx } = await import(
  "./test-utils/gau-fake-tx"
);
const { schema } = await import("@oxagen/database");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeWebhookEvent(
  overrides: Partial<BillingWebhookEvent> = {},
): BillingWebhookEvent {
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
    expect(
      dbState.instance!._processingInsertChain.onConflictDoUpdate,
    ).toHaveBeenCalledOnce();
  });

  it("already-processed duplicate — conflict + processed row → 'duplicate', no dispatch", async () => {
    dbState.instance = makeDb([], {
      existingEventId: "evt-row-1",
      processedAt: new Date(),
    });

    const event = makeWebhookEvent({ providerEventId: "evt_dupe_001" });
    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "duplicate" });
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(1);
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
  });

  // The other half of the retry contract, and the half nothing asserted.
  // The test above proves that an event with no `processed_at` is
  // re-dispatched; this one proves a throwing handler is what LEAVES it
  // unset. Both halves matter to ADR-085 §9: a charge read that fails
  // propagates precisely so the event is redelivered and the dispute parks on
  // the second delivery. If a throw were swallowed here, or recorded
  // `processedAt` alongside the error, the classifier's choice to throw would
  // buy nothing and the units would still be granted.
  it("a throwing dispatch records the error, does NOT mark processed, and rethrows", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-throw" }]);
    syncSubscriptionMock.mockRejectedValueOnce(new Error("stripe is down"));

    const event = makeWebhookEvent({ providerEventId: "evt_throw_001" });

    // Rethrown, so the route answers non-2xx and Stripe redelivers.
    await expect(processStripeEvent(event)).rejects.toThrow("stripe is down");

    // The processing row is written with the error and NO processedAt. The
    // `set` of the upsert is what a redelivery would collide with, and it
    // must not carry a processedAt either.
    const chain = dbState.instance!._processingInsertChain;
    expect(chain.onConflictDoUpdate).toHaveBeenCalledOnce();
    const [{ set }] = chain.onConflictDoUpdate.mock.calls[0] as [
      { set: Record<string, unknown> },
    ];
    expect(set).toHaveProperty("processingError", "stripe is down");
    expect(set).not.toHaveProperty("processedAt");
  });

  it("retry after a failed dispatch — conflict + no processed row → re-dispatches → 'applied'", async () => {
    dbState.instance = makeDb([], {
      existingEventId: "evt-row-2",
      processedAt: null,
    });

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
      gauSettlementId: null,
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
    // A paid, non-zero invoice emails the customer a receipt (via the real
    // receipts.ts → notifyOrgManagers spy).
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
    expect(notifyOrgManagersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-abc",
        kind: "system",
        deepLink: "/settings/billing",
      }),
    );
  });

  it("invoice.paid — zero-amount invoice does NOT send a receipt", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-zero" }]);

    const invoice = {
      id: "in_zero_001",
      providerInvoiceId: "in_zero_001",
      number: "INV-000",
      status: "paid" as const,
      amountDueCents: 0,
      amountPaidCents: 0,
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
      gauSettlementId: null,
      lineItems: [],
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_inv_zero_001",
      type: "invoice.paid",
      subscriptionId: undefined,
      invoice,
    });

    const result = await processStripeEvent(event);

    expect(result).toEqual({ status: "applied" });
    // Grants + recovery still run; only the receipt email is skipped for $0.
    expect(onInvoiceRecoveredMock).toHaveBeenCalledWith(invoice);
    expect(notifyOrgManagersMock).not.toHaveBeenCalled();
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
      gauSettlementId: null,
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
    // Payment failure must NOT send a payment receipt (that path emails the
    // failure notice via onInvoicePaymentFailed, not a receipt).
    expect(notifyOrgManagersMock).not.toHaveBeenCalled();
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
        gauSettlementId: null,
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
        gauSettlementId: null,
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
        gauSettlementId: null,
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
    dbState.instance!.query.subscriptions.findFirst = vi
      .fn()
      .mockResolvedValue({ orgId: "org-abc" });

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
      metadata: {},
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

  it("checkout.session.completed — dispatches grantCreditPackForCheckout", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-12" }]);

    const checkoutSession = {
      id: "cs_test_checkout_001",
      mode: "payment",
      paymentStatus: "paid",
      customerId: "cus_test_001",
      metadata: { org_id: "org-abc", credits: "500" },
      subscriptionId: null,
      invoiceId: null,
      paymentIntentId: null,
      amountTotalCents: null,
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_checkout_completed_001",
      type: "checkout.session.completed",
      subscriptionId: undefined,
      checkoutSession,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(grantCreditPackForCheckoutMock).toHaveBeenCalledWith(
      checkoutSession,
    );
    expect(grantGauPurchaseForCheckoutMock).not.toHaveBeenCalled();
  });

  it("checkout.session.completed — a gau_purchase session goes to grantGauPurchaseForCheckout and never to the credit-pack grant", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-12b" }]);

    const checkoutSession = {
      id: "cs_test_gau_001",
      mode: "payment",
      paymentStatus: "paid",
      customerId: "cus_test_001",
      metadata: {
        oxagen_kind: "gau_purchase",
        org_id: "org-abc",
        gau_quantity: "5000",
        block_size_gau: "5000",
        rate_per_gau_micros: "5000",
        currency: "usd",
      },
      subscriptionId: null,
      invoiceId: "in_gau_001",
      paymentIntentId: "pi_gau_001",
      amountTotalCents: 5_000,
    };

    const event = makeWebhookEvent({
      providerEventId: "evt_checkout_gau_001",
      type: "checkout.session.completed",
      subscriptionId: undefined,
      checkoutSession,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    expect(grantGauPurchaseForCheckoutMock).toHaveBeenCalledWith(
      checkoutSession,
    );
    expect(grantCreditPackForCheckoutMock).not.toHaveBeenCalled();
  });

  it("invoice.paid for a governed-action purchase invoice mirrors it, sends the receipt and grants no plan credits", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-gau-inv" }]);
    // The real plan-credit grant, against the invoice a Checkout with
    // invoice_creation issues: billing_reason 'manual', no subscription, the
    // org in the invoice metadata.
    grantPlanCreditsForInvoicePaidMock.mockImplementationOnce(
      realGrants.module!.grantPlanCreditsForInvoicePaid,
    );

    const invoice = {
      id: "in_gau_001",
      providerInvoiceId: "in_gau_001",
      number: "INV-GAU-001",
      status: "paid" as const,
      amountDueCents: 2500,
      amountPaidCents: 2500,
      amountRemainingCents: 0,
      currency: "usd",
      periodStart: new Date(),
      periodEnd: new Date(),
      dueAt: null,
      paidAt: new Date(),
      hostedInvoiceUrl: "https://invoice.stripe.com/i/gau",
      invoicePdfUrl: null,
      subscriptionId: null,
      orgId: "org-abc",
      billingReason: "manual",
      gauSettlementId: null,
      lineItems: [],
    };

    const result = await processStripeEvent(
      makeWebhookEvent({
        providerEventId: "evt_inv_gau_001",
        type: "invoice.paid",
        subscriptionId: undefined,
        invoice,
      }),
    );

    expect(result).toEqual({ status: "applied" });
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_gau_001");
    // No plan credits: the real grant left before any subscription sync or
    // ledger insert (the two inserts are the event row and its processing row).
    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
    expect(notifyOrgManagersMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-abc", kind: "system" }),
    );
  });

  it("checkout.session.completed — no-ops when checkoutSession is missing", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-13" }]);

    const event = makeWebhookEvent({
      providerEventId: "evt_checkout_no_session_001",
      type: "checkout.session.completed",
      subscriptionId: undefined,
      checkoutSession: undefined,
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
  });

  it("payment_method.detached — updates the payment method with deletedAt", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-14" }]);
    dbState.instance!.query.subscriptions.findFirst = vi
      .fn()
      .mockResolvedValue({ orgId: "org-abc" });

    const event = makeWebhookEvent({
      providerEventId: "evt_pm_detached_001",
      type: "payment_method.detached",
      subscriptionId: undefined,
      paymentMethod: {
        id: "pm_test_detached_001",
        customerId: "cus_test_001",
        type: "card",
        brand: "mastercard",
        last4: "5555",
        expMonth: 6,
        expYear: 2027,
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    // The detach path calls db.update(paymentMethods).set({ deletedAt })
    expect(dbState.instance!.update).toHaveBeenCalled();
  });

  it("payment_method.attached — a Free org with no subscription mirrors through org_billing_settings.stripe_customer_id", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-15a" }]);
    dbState.instance!.query.orgBillingSettings.findFirst = vi
      .fn()
      .mockResolvedValue({ orgId: "org-free" });
    dbState.instance!.query.subscriptions.findFirst = vi
      .fn()
      .mockResolvedValue(null);

    const event = makeWebhookEvent({
      providerEventId: "evt_pm_attached_free_001",
      type: "payment_method.attached",
      subscriptionId: undefined,
      paymentMethod: {
        id: "pm_free_001",
        customerId: "cus_free_001",
        type: "card",
        brand: "visa",
        last4: "4242",
        expMonth: 3,
        expYear: 2029,
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
    // The event row, the payment_methods upsert, the processing row.
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(3);
    const upsert = dbState.instance!.insert.mock.results[1]!.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(upsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-free",
        stripeCustomerId: "cus_free_001",
        stripePaymentMethodId: "pm_free_001",
        isDefault: false,
      }),
    );
    expect(
      dbState.instance!.query.subscriptions.findFirst,
    ).not.toHaveBeenCalled();
  });

  it("payment_method.attached — a customer known to neither table is skipped", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-15b" }]);

    const result = await processStripeEvent(
      makeWebhookEvent({
        providerEventId: "evt_pm_attached_unknown_001",
        type: "payment_method.attached",
        subscriptionId: undefined,
        paymentMethod: {
          id: "pm_unknown_001",
          customerId: "cus_unknown_001",
          type: "card",
          brand: "visa",
          last4: "1111",
          expMonth: 1,
          expYear: 2030,
        },
      }),
    );
    expect(result).toEqual({ status: "applied" });
    // The event row and the processing row only.
    expect(dbState.instance!.insert).toHaveBeenCalledTimes(2);
  });

  it("payment_method.attached — upserts payment method when subscription exists", async () => {
    dbState.instance = makeDb([{ id: "row-uuid-15" }]);
    dbState.instance!.query.subscriptions.findFirst = vi
      .fn()
      .mockResolvedValue({ orgId: "org-abc" });

    const event = makeWebhookEvent({
      providerEventId: "evt_pm_attached_001",
      type: "payment_method.attached",
      subscriptionId: undefined,
      paymentMethod: {
        id: "pm_new_001",
        customerId: "cus_test_001",
        type: "card",
        brand: "amex",
        last4: "0005",
        expMonth: 3,
        expYear: 2029,
      },
    });

    const result = await processStripeEvent(event);
    expect(result).toEqual({ status: "applied" });
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

// ---------------------------------------------------------------------------
// Governed-action settlement invoices (ADR-055 §6; ARCHITECTURE.md §3.9)
// ---------------------------------------------------------------------------

describe("processStripeEvent — governed-action settlement invoices", () => {
  const ORG = "00000000-0000-0000-0000-00000000a0a1";
  const NOW = new Date("2026-09-15T12:00:00.000Z");
  const SEPTEMBER = new Date("2026-09-01T00:00:00.000Z");
  const AUGUST = new Date("2026-08-01T00:00:00.000Z");

  let store: FakeGauStore;
  /** The event-ledger double of the latest delivery; GAU tables go to the store. */
  let ledger: ReturnType<typeof makeDb>;
  let delivery = 0;

  function seedBucket(overrides: Record<string, unknown> = {}) {
    const row = {
      id: crypto.randomUUID(),
      orgId: ORG,
      periodStart: SEPTEMBER,
      periodEnd: new Date("2026-10-01T00:00:00.000Z"),
      includedGau: 5_000,
      purchasedGau: 0,
      carriedGau: 0,
      usedGau: 5_000,
      overageInvoicedGau: 0,
      interimSeq: 0,
      topupSeq: 1,
      openTopupSettlementId: null as string | null,
      closedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
    store.buckets.push(row);
    return row;
  }

  /** A pending auto top-up that holds its bucket's episode open. */
  function seedTopup(bucket: ReturnType<typeof seedBucket>) {
    const row = {
      id: crypto.randomUUID(),
      orgId: ORG,
      bucketId: bucket.id,
      kind: "auto_topup",
      seq: 1,
      quantityGau: 5_000,
      ratePerGauMicros: 5_000n,
      currency: "usd",
      status: "pending",
      stripeCheckoutSessionId: null,
      stripeInvoiceId: "in_topup_001",
      createdAt: NOW,
      settledAt: null,
    };
    store.settlements.push(row);
    bucket.openTopupSettlementId = row.id;
    return row;
  }

  function gauInvoice(settlementId: string, paid: boolean): BillingInvoice {
    return {
      id: "in_topup_001",
      providerInvoiceId: "in_topup_001",
      number: "INV-GAU-002",
      status: paid ? "paid" : "open",
      amountDueCents: 2500,
      amountPaidCents: paid ? 2500 : 0,
      amountRemainingCents: paid ? 0 : 2500,
      currency: "usd",
      periodStart: NOW,
      periodEnd: NOW,
      dueAt: null,
      paidAt: paid ? NOW : null,
      hostedInvoiceUrl: "https://invoice.stripe.com/i/topup",
      invoicePdfUrl: null,
      subscriptionId: null,
      orgId: ORG,
      billingReason: "manual",
      gauSettlementId: settlementId,
      lineItems: [],
    };
  }

  /** One delivery of a fresh Stripe event carrying `invoice`. */
  async function deliver(
    type: "invoice.paid" | "invoice.payment_failed" | "invoice.created",
    invoice: BillingInvoice,
  ) {
    ledger = makeDb([{ id: `row-gau-${++delivery}` }]);
    const gau = fakeGauExecutor(store);
    const isGau = (t: unknown) =>
      t === schema.gauBuckets || t === schema.gauSettlements;
    dbState.instance = {
      ...ledger,
      insert: ((t: unknown) =>
        isGau(t) ? gau.insert(t) : ledger.insert()) as typeof ledger.insert,
      update: ((t: unknown) =>
        isGau(t) ? gau.update(t) : ledger.update()) as typeof ledger.update,
      select: gau.select,
    } as ReturnType<typeof makeDb>;
    return processStripeEvent(
      makeWebhookEvent({
        providerEventId: `evt_gau_${delivery}`,
        type,
        subscriptionId: undefined,
        invoice,
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    store = makeFakeGauStore();
    readGauEntitlementMock.mockResolvedValue({
      terms: {
        source: "published_tier",
        tier: "free",
        effectiveFrom: SEPTEMBER,
        effectiveTo: null,
        currency: "usd",
        ratePerGauMicros: 5_000n,
        blockSizeGau: 5_000,
        includedGauPerMonth: 5_000,
      },
      subscription: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    tenantScope.enforced = false;
  });

  it("invoice.paid settles the row paid after mirroring the invoice, and a second delivery grants nothing more", async () => {
    const bucket = seedBucket();
    const row = seedTopup(bucket);
    const statusAtSync: string[] = [];
    syncInvoiceMock.mockImplementation(async () => {
      statusAtSync.push(row.status);
    });

    await deliver("invoice.paid", gauInvoice(row.id, true));
    await deliver("invoice.paid", gauInvoice(row.id, true));

    expect(statusAtSync).toEqual(["pending", "paid"]);
    expect(row.status).toBe("paid");
    expect(bucket).toMatchObject({
      purchasedGau: 5_000,
      openTopupSettlementId: null,
    });
  });

  it("grants once when the synchronous paid result landed before the webhook", async () => {
    const bucket = seedBucket();
    const row = seedTopup(bucket);
    await settleGauPaid(makeFakeGauTx(store), row.id, NOW);

    await deliver("invoice.paid", gauInvoice(row.id, true));

    expect(bucket.purchasedGau).toBe(5_000);
  });

  it("invoice.payment_failed leaves the row open with its episode, and Stripe's paid retry ends it paid, granted and cleared", async () => {
    const bucket = seedBucket();
    const row = seedTopup(bucket);

    await deliver("invoice.payment_failed", gauInvoice(row.id, false));
    expect(row.status).toBe("open");
    expect(bucket).toMatchObject({
      purchasedGau: 0,
      openTopupSettlementId: row.id,
    });

    await deliver("invoice.paid", gauInvoice(row.id, true));
    expect(row.status).toBe("paid");
    expect(bucket).toMatchObject({
      purchasedGau: 5_000,
      openTopupSettlementId: null,
    });
  });

  it("invoice.paid after rollover grants to the current month's bucket", async () => {
    const august = seedBucket({
      periodStart: AUGUST,
      periodEnd: SEPTEMBER,
    });
    const row = seedTopup(august);

    await deliver("invoice.paid", gauInvoice(row.id, true));

    const september = store.buckets.find(
      (b) => (b.periodStart as Date).getTime() === SEPTEMBER.getTime(),
    );
    expect(september).toMatchObject({ purchasedGau: 5_000, usedGau: 0 });
    expect(august).toMatchObject({
      purchasedGau: 0,
      openTopupSettlementId: null,
    });
  });

  it("neither branch reaches the org's dunning state: no grace on a declined settlement invoice, no recovery on a paid one", async () => {
    const row = seedTopup(seedBucket());
    onInvoicePaymentFailedMock.mockImplementationOnce(
      realDunning.module!.onInvoicePaymentFailed,
    );
    onInvoiceRecoveredMock.mockImplementationOnce(
      realDunning.module!.onInvoiceRecovered,
    );

    await deliver("invoice.payment_failed", gauInvoice(row.id, false));
    expect(ledger.update).not.toHaveBeenCalled();

    await deliver("invoice.paid", gauInvoice(row.id, true));
    expect(ledger.update).not.toHaveBeenCalled();
    expect(row.status).toBe("paid");
  });

  it("invoice.created settles nothing", async () => {
    const bucket = seedBucket();
    const row = seedTopup(bucket);

    await deliver("invoice.created", gauInvoice(row.id, false));

    expect(row.status).toBe("pending");
    expect(syncInvoiceMock).toHaveBeenCalledWith("in_topup_001");
  });

  it("runs both branches with no active tenant scope under TENANT_RLS_ENFORCEMENT_ENABLED", async () => {
    vi.stubEnv("TENANT_RLS_ENFORCEMENT_ENABLED", "true");
    tenantScope.enforced = true;
    const bucket = seedBucket();
    const row = seedTopup(bucket);

    await expect(
      deliver("invoice.payment_failed", gauInvoice(row.id, false)),
    ).resolves.toEqual({ status: "applied" });
    await expect(
      deliver("invoice.paid", gauInvoice(row.id, true)),
    ).resolves.toEqual({ status: "applied" });

    expect(row.status).toBe("paid");
    expect(bucket.purchasedGau).toBe(5_000);
    await expect(
      tenantScope.realWithTenantDb!(async () => undefined),
    ).rejects.toThrow("No active tenant scope");
  });
});

// ---------------------------------------------------------------------------
// Prepaid orders (prepaid-orders.ts, ADR-165)
// ---------------------------------------------------------------------------

describe("processStripeEvent: prepaid-order invoices", () => {
  const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";
  const CAP = { kind: "set" as const, capCents: 600_000 };

  function prepaidInvoice(over: Partial<BillingInvoice> = {}): BillingInvoice {
    return {
      id: "in_pre_001",
      providerInvoiceId: "in_pre_001",
      number: "OXA-0042",
      status: "paid",
      amountDueCents: 12_500_000,
      amountPaidCents: 12_500_000,
      amountRemainingCents: 0,
      currency: "usd",
      periodStart: new Date("2026-09-23T00:00:00.000Z"),
      periodEnd: new Date("2026-09-23T00:00:00.000Z"),
      dueAt: null,
      paidAt: new Date("2026-10-10T00:00:00.000Z"),
      hostedInvoiceUrl: null,
      invoicePdfUrl: null,
      subscriptionId: null,
      orgId: "org-ent",
      billingReason: "manual",
      gauSettlementId: null,
      prepaidOrder: { orderId: ORDER, assistantSpendCap: CAP },
      lineItems: [],
      ...over,
    };
  }

  async function deliver(
    type: BillingWebhookEvent["type"],
    invoice: BillingInvoice,
  ) {
    dbState.instance = makeDb([{ id: `row-pre-${type}` }]);
    return processStripeEvent(
      makeWebhookEvent({
        providerEventId: `evt_pre_${type}`,
        type,
        subscriptionId: undefined,
        invoice,
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("grants the order on invoice.paid, naming the invoice and the cap instruction the metadata carries", async () => {
    await expect(deliver("invoice.paid", prepaidInvoice())).resolves.toEqual({
      status: "applied",
    });
    expect(grantPrepaidOrderMock).toHaveBeenCalledWith(ORDER, {
      trigger: "paid",
      stripeInvoiceId: "in_pre_001",
      assistantSpendCap: CAP,
    });
    expect(closePrepaidOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invoice.voided", "void"],
    ["invoice.marked_uncollectible", "uncollectible"],
  ] as const)("mirrors %s onto the order as %s", async (type, status) => {
    await deliver(type, prepaidInvoice({ status }));
    expect(closePrepaidOrderMock).toHaveBeenCalledWith(ORDER, {
      status,
      stripeInvoiceId: "in_pre_001",
    });
    expect(grantPrepaidOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    "invoice.created",
    "invoice.finalized",
    "invoice.payment_failed",
  ] as const)("does nothing to the order on %s", async (type) => {
    await deliver(type, prepaidInvoice({ status: "open" }));
    expect(grantPrepaidOrderMock).not.toHaveBeenCalled();
    expect(closePrepaidOrderMock).not.toHaveBeenCalled();
  });

  it("never touches an order for an invoice that names none", async () => {
    await deliver("invoice.paid", prepaidInvoice({ prepaidOrder: null }));
    await deliver(
      "invoice.voided",
      prepaidInvoice({ prepaidOrder: undefined, status: "void" }),
    );
    expect(grantPrepaidOrderMock).not.toHaveBeenCalled();
    expect(closePrepaidOrderMock).not.toHaveBeenCalled();
  });

  it("records a failed grant and rethrows, so Stripe redelivers", async () => {
    grantPrepaidOrderMock.mockRejectedValueOnce(
      new Error("Invoice in_pre_001 names order x, which records invoice y."),
    );
    await expect(deliver("invoice.paid", prepaidInvoice())).rejects.toThrow(
      /records invoice y/,
    );
    expect(
      dbState.instance!._processingInsertChain.onConflictDoUpdate,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        set: { processingError: expect.stringMatching(/records invoice y/) },
      }),
    );
  });
});
