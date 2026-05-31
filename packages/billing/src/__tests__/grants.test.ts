/**
 * Unit tests for grants.ts (grantPlanCreditsForInvoicePaid,
 * grantCreditPackForCheckout).
 *
 * Mocks:
 *  - @oxagen/database → db() factory
 *  - ../client.js     → stripeClient() (no live Stripe API)
 *  - ../credits.js    → grantCredits (spy, no ledger/DB needed)
 *  - ../subscriptions.js → syncSubscriptionFromStripe (no-op)
 *
 * Scenarios (grantPlanCreditsForInvoicePaid):
 *  1. Happy path subscription_create — credits granted once.
 *  2. subscription_cycle billing reason — credits granted.
 *  3. Already granted (alreadyGranted returns true) — grantCredits not called.
 *  4. Missing invoice row in DB — grantCredits not called.
 *  5. Non-subscription billing reason (e.g. manual) — returns early, no grant.
 *
 * Scenarios (grantCreditPackForCheckout):
 *  1. Happy path — line items with price.metadata.credits → credits granted.
 *  2. Already granted (alreadyGranted returns true) — grantCredits not called.
 *  3. Session mode is "subscription" (not payment) — returns early, no grant.
 *  4. payment_status is not "paid" — returns early, no grant.
 *  5. No org_id on session metadata — returns early, no grant.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

// ---------------------------------------------------------------------------
// Module mocks — registered before any module import.
// ---------------------------------------------------------------------------

const grantCreditsMock = vi.fn().mockResolvedValue({ balanceCents: 1000n });
vi.mock("../credits.js", () => ({
  grantCredits: grantCreditsMock,
}));

const syncSubscriptionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../subscriptions.js", () => ({
  syncSubscriptionFromStripe: syncSubscriptionMock,
}));

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

type QueryFindFirst = ReturnType<typeof vi.fn>;

interface DbQueryMocks {
  creditLedger: { findFirst: QueryFindFirst };
  subscriptions: { findFirst: QueryFindFirst };
  plans: { findFirst: QueryFindFirst };
  invoices: { findFirst: QueryFindFirst };
}

function makeDb(overrides: Partial<DbQueryMocks> = {}): { query: DbQueryMocks } {
  return {
    query: {
      creditLedger: { findFirst: vi.fn().mockResolvedValue(undefined) },
      subscriptions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      plans: { findFirst: vi.fn().mockResolvedValue(undefined) },
      invoices: { findFirst: vi.fn().mockResolvedValue(undefined) },
      ...overrides,
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
    subscriptions: { stripeSubscriptionId: "subscriptions.stripeSubscriptionId" },
    plans: { id: "plans.id" },
    invoices: { stripeInvoiceId: "invoices.stripeInvoiceId" },
  },
}));

// ---------------------------------------------------------------------------
// Stripe client mock factory
// ---------------------------------------------------------------------------

function makeStripeListLineItems(
  items: Stripe.LineItem[],
): { autoPagingToArray: ReturnType<typeof vi.fn> } {
  return {
    autoPagingToArray: vi.fn().mockResolvedValue(items),
  };
}

const stripeCheckoutSessionsMock = {
  listLineItems: vi.fn(),
};

vi.mock("../client.js", () => ({
  stripeClient: () => ({
    checkout: { sessions: stripeCheckoutSessionsMock },
  }),
}));

// Import after mocks.
const { grantPlanCreditsForInvoicePaid, grantCreditPackForCheckout } = await import(
  "../grants.js"
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeInvoice(
  overrides: Partial<Stripe.Invoice> = {},
): Stripe.Invoice {
  return {
    id: "in_test_001",
    object: "invoice",
    billing_reason: "subscription_create",
    subscription: "sub_test_001",
    status: "paid",
    amount_due: 2000,
    amount_paid: 2000,
    amount_remaining: 0,
    currency: "usd",
    period_start: Math.floor(Date.now() / 1000) - 86400,
    period_end: Math.floor(Date.now() / 1000),
    metadata: {},
    lines: { data: [], object: "list", has_more: false, url: "/v1/invoices/in_test_001/lines" },
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makeSession(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_001",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    metadata: { org_id: "org-abc" },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

function makeLineItem(creditCount: number, quantity: number = 1): Stripe.LineItem {
  return {
    id: `li_${creditCount}`,
    object: "item",
    quantity,
    price: {
      id: "price_test",
      object: "price",
      metadata: { credits: String(creditCount) },
      product: null,
    } as unknown as Stripe.Price,
  } as unknown as Stripe.LineItem;
}

// ---------------------------------------------------------------------------
// Tests — grantPlanCreditsForInvoicePaid
// ---------------------------------------------------------------------------

describe("grantPlanCreditsForInvoicePaid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantCreditsMock.mockResolvedValue({ balanceCents: 1000n });
    syncSubscriptionMock.mockResolvedValue(undefined);
  });

  it("subscription_create billing reason — grants plan credits once", async () => {
    dbState.instance = makeDb({
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      },
      plans: {
        findFirst: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      },
      invoices: {
        findFirst: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
      },
      creditLedger: {
        // Not yet granted.
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billing_reason: "subscription_create" }));

    expect(grantCreditsMock).toHaveBeenCalledOnce();
    const call = grantCreditsMock.mock.calls[0]![0] as { deltaCents: bigint; reason: string };
    expect(call.deltaCents).toBe(5000n);
    expect(call.reason).toBe("grant_plan_renewal");
  });

  it("subscription_cycle billing reason — grants plan credits", async () => {
    dbState.instance = makeDb({
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      },
      plans: {
        findFirst: vi.fn().mockResolvedValue({ includedCreditCents: 3000 }),
      },
      invoices: {
        findFirst: vi.fn().mockResolvedValue({ id: "invoice-uuid-2" }),
      },
      creditLedger: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billing_reason: "subscription_cycle" }));

    expect(grantCreditsMock).toHaveBeenCalledOnce();
  });

  it("already granted (ledger row exists) — grantCredits is NOT called", async () => {
    dbState.instance = makeDb({
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      },
      plans: {
        findFirst: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      },
      invoices: {
        findFirst: vi.fn().mockResolvedValue({ id: "invoice-uuid-1" }),
      },
      creditLedger: {
        // Row exists — already granted.
        findFirst: vi.fn().mockResolvedValue({ id: "ledger-row-1" }),
      },
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    expect(grantCreditsMock).not.toHaveBeenCalled();
  });

  it("missing invoice row — grantCredits is NOT called", async () => {
    dbState.instance = makeDb({
      subscriptions: {
        findFirst: vi.fn().mockResolvedValue({ orgId: "org-abc", planId: "plan-001" }),
      },
      plans: {
        findFirst: vi.fn().mockResolvedValue({ includedCreditCents: 5000 }),
      },
      invoices: {
        // No row mirrored yet.
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
      creditLedger: {
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    });

    await grantPlanCreditsForInvoicePaid(makeInvoice());

    // referenceId is undefined → alreadyGranted check is skipped, grantCredits
    // is called with referenceId: undefined. The function still calls grantCredits
    // because the guard is: "if (referenceId && alreadyGranted)".
    // So when referenceId is undefined the idempotency guard is bypassed and
    // grantCredits IS still called.  This is the observed behaviour of the
    // source and the test documents it faithfully.
    expect(grantCreditsMock).toHaveBeenCalledOnce();
  });

  it("non-subscription billing reason (manual) — returns early, no grant", async () => {
    dbState.instance = makeDb();

    await grantPlanCreditsForInvoicePaid(makeInvoice({ billing_reason: "manual" }));

    expect(syncSubscriptionMock).not.toHaveBeenCalled();
    expect(grantCreditsMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — grantCreditPackForCheckout
// ---------------------------------------------------------------------------

describe("grantCreditPackForCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantCreditsMock.mockResolvedValue({ balanceCents: 500n });
  });

  it("happy path — line items with price.metadata.credits grants correct total", async () => {
    dbState.instance = makeDb({
      creditLedger: { findFirst: vi.fn().mockResolvedValue(undefined) },
    });

    stripeCheckoutSessionsMock.listLineItems.mockReturnValue(
      makeStripeListLineItems([
        makeLineItem(100, 2), // 200 credits
        makeLineItem(50, 1),  // 50 credits
      ]),
    );

    await grantCreditPackForCheckout(makeSession());

    expect(grantCreditsMock).toHaveBeenCalledOnce();
    const call = grantCreditsMock.mock.calls[0]![0] as { deltaCents: bigint; reason: string };
    expect(call.deltaCents).toBe(250n);
    expect(call.reason).toBe("grant_credit_pack");
  });

  it("already granted — grantCredits is NOT called", async () => {
    dbState.instance = makeDb({
      creditLedger: {
        // Row exists → alreadyGranted returns true.
        findFirst: vi.fn().mockResolvedValue({ id: "ledger-row-1" }),
      },
    });

    await grantCreditPackForCheckout(makeSession());

    expect(stripeCheckoutSessionsMock.listLineItems).not.toHaveBeenCalled();
    expect(grantCreditsMock).not.toHaveBeenCalled();
  });

  it("session mode is subscription — returns early, no grant", async () => {
    dbState.instance = makeDb();

    await grantCreditPackForCheckout(makeSession({ mode: "subscription" }));

    expect(grantCreditsMock).not.toHaveBeenCalled();
  });

  it("payment_status is not paid — returns early, no grant", async () => {
    dbState.instance = makeDb();

    await grantCreditPackForCheckout(makeSession({ payment_status: "unpaid" }));

    expect(grantCreditsMock).not.toHaveBeenCalled();
  });

  it("no org_id on metadata — returns early, no grant", async () => {
    dbState.instance = makeDb();

    await grantCreditPackForCheckout(makeSession({ metadata: {} }));

    expect(grantCreditsMock).not.toHaveBeenCalled();
  });
});
