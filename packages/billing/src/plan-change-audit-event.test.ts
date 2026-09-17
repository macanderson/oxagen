/**
 * When `billing.plan_changed` is written, and when it is not.
 *
 * `changeOrgPlan` returns early when the provider is already on the price being
 * asked for. That branch exists for a RETRY — a first attempt whose swap
 * reached Stripe and whose response was lost — and for that caller the audit
 * event is the only record of a privileged mutation that really happened, so it
 * is emitted rather than lost.
 *
 * But the same branch is taken by a caller who simply submits the plan and
 * interval already active. Nothing is mutated on that request, and emitting
 * there records a successful privileged billing mutation that never occurred —
 * which is worse than a missing record, because SOC 2 evidence that asserts
 * something false is evidence that has to be disproved (#3157, PR #3171
 * review).
 *
 * THE DISCRIMINATOR IS ALREADY ON THE ROW, and this file asserts all three
 * outcomes rather than only the one that was wrong. A fix that just stops
 * emitting on the branch satisfies the no-op case and silently breaks the
 * retry case, turning a false positive into a false negative:
 *
 *   - steady state, nothing in flight  → no event
 *   - a recorded intent still unsettled → exactly one event
 *   - the provider moved and our row did not → exactly one event
 *   - a real in-place swap              → exactly one event
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Stripe SDK mock ──────────────────────────────────────────────────────────

const stripeMethods = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  invoices: { createPreview: vi.fn(), retrieve: vi.fn() },
  paymentMethods: { list: vi.fn(), detach: vi.fn() },
};

vi.mock("stripe", () => ({ default: vi.fn(() => stripeMethods) }));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_mock",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  }),
}));

const dbQueryMocks = {
  plans: { findFirst: vi.fn() },
  subscriptions: { findFirst: vi.fn() },
  organizations: { findFirst: vi.fn() },
  orgBillingSettings: { findFirst: vi.fn() },
};

const dbMocks = {
  query: dbQueryMocks,
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => Promise.resolve(undefined)),
    })),
  })),
  select: vi.fn(),
  update: vi.fn(() => ({
    set: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
  })),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const hasPlanUpgradeGrantMock = vi.fn().mockResolvedValue(true);
vi.mock("./grants", () => ({
  hasPlanUpgradeGrant: hasPlanUpgradeGrantMock,
  grantProratedPlanUpgradeCredits: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER the mocks.
const { StripeProvider } = await import("./stripe-provider");
const { setBillingProvider, resetBillingProvider } = await import("./client");
const { changeOrgPlan } = await import("./subscriptions");
const { emitSecurityEvent } = await import("@oxagen/database/security");

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BUILD_PLAN = {
  id: "plan-build-id",
  slug: "build-v2",
  tier: "build",
  stripePriceIdMonthly: "price_build_m",
  stripePriceIdAnnual: "price_build_y",
  monthlyCents: 20_000,
  annualCents: 200_000,
  stripeProductId: "prod_build",
};

/** Which price the PROVIDER reports the subscription on. */
let providerPriceId = "price_build_m";

function stubProvider(): void {
  stripeMethods.subscriptions.retrieve.mockImplementation(async () => {
    const lastUpdate = stripeMethods.subscriptions.update.mock.calls.at(-1) as
      | [string, { items?: Array<{ price?: string }> }]
      | undefined;
    const swappedTo = lastUpdate?.[1]?.items?.[0]?.price;
    return {
      id: "sub_active_001",
      customer: "cus_001",
      metadata: { org_id: "org-abc" },
      status: "active",
      items: {
        data: [
          {
            id: "si_001",
            quantity: 1,
            price: {
              id: swappedTo ?? providerPriceId,
              recurring: { interval: "month" },
              product: "prod_build",
            },
          },
        ],
      },
      current_period_start: 1_756_684_800,
      current_period_end: 1_759_276_800,
      cancel_at_period_end: false,
      canceled_at: null,
      trial_end: null,
    };
  });
}

function stubPreview(): void {
  stripeMethods.invoices.createPreview.mockImplementation(
    async (args: { subscription_details?: { proration_date?: number } }) => {
      const anchor = args.subscription_details?.proration_date ?? 0;
      return {
        currency: "usd",
        total: 5_000,
        amount_due: 5_000,
        lines: {
          data: [
            {
              proration: true,
              description: "Remaining time",
              amount: 5_000,
              period: { start: anchor, end: anchor + 100 },
            },
          ],
        },
      };
    },
  );
}

/** The local row, as the last successful sync left it. */
function stubRow(over: {
  stripePriceId: string;
  pendingUpgradeFromPlanId: string | null;
}): void {
  dbQueryMocks.subscriptions.findFirst.mockResolvedValue({
    stripeSubscriptionId: "sub_active_001",
    stripeCustomerId: "cus_001",
    seatCount: 1,
    planId: BUILD_PLAN.id,
    billingInterval: "month",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    ...over,
  });
}

/** How many `billing.plan_changed` rows this call wrote. */
function planChangedEvents(): number {
  return vi
    .mocked(emitSecurityEvent)
    .mock.calls.filter(
      (c) =>
        (c[0] as { eventType?: string })?.eventType === "billing.plan_changed",
    ).length;
}

describe("the billing.plan_changed audit event (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBillingProvider(new StripeProvider());
    providerPriceId = "price_build_m";
    hasPlanUpgradeGrantMock.mockResolvedValue(true);
    stubProvider();
    stubPreview();
    dbQueryMocks.plans.findFirst.mockReset();
    dbQueryMocks.plans.findFirst.mockResolvedValue(BUILD_PLAN);
    stripeMethods.customers.retrieve.mockResolvedValue({
      id: "cus_001",
      deleted: false,
      invoice_settings: { default_payment_method: null },
    });
    stripeMethods.subscriptions.update.mockResolvedValue(undefined);
  });

  it("writes nothing when the caller asks for the plan already active", async () => {
    // Steady state: the provider and our row agree on the target, and nothing
    // is in flight. This request mutated nothing, so it is not a plan change.
    stubRow({ stripePriceId: "price_build_m", pendingUpgradeFromPlanId: null });

    const result = await changeOrgPlan("org-abc", "build-v2", "month");

    expect(result).toBeNull();
    expect(stripeMethods.subscriptions.update).not.toHaveBeenCalled();
    expect(planChangedEvents()).toBe(0);
  });

  it("writes exactly one when resuming an intent the first attempt left unsettled", async () => {
    // The swap landed and its sync landed, but the call died before the credit
    // grant. The intent is still standing, which is the evidence that a real
    // mutation happened on a previous attempt and is being completed now.
    hasPlanUpgradeGrantMock.mockResolvedValue(false);
    stubRow({
      stripePriceId: "price_build_m",
      pendingUpgradeFromPlanId: "plan-scale-id",
    });

    await changeOrgPlan("org-abc", "build-v2", "month");

    // A missing record here is worse than a spurious one: this call IS
    // completing a privileged mutation and nothing else records it.
    expect(planChangedEvents()).toBe(1);
  });

  it("writes exactly one when the provider moved and our row never recorded it", async () => {
    // The swap reached Stripe and the sync that follows it did not. The row
    // disagreeing with the provider is itself evidence of a real mutation,
    // even with no intent recorded (a swap predating that column).
    stubRow({ stripePriceId: "price_build_y", pendingUpgradeFromPlanId: null });

    await changeOrgPlan("org-abc", "build-v2", "month");

    expect(planChangedEvents()).toBe(1);
  });

  it("writes exactly one for a change that actually swaps the price", async () => {
    // The ordinary path, asserted so a fix that simply stops emitting on the
    // early-return branch cannot pass this file.
    providerPriceId = "price_build_y";
    stubRow({ stripePriceId: "price_build_y", pendingUpgradeFromPlanId: null });

    await changeOrgPlan("org-abc", "build-v2", "month");

    expect(stripeMethods.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(planChangedEvents()).toBe(1);
  });
});

afterEach(() => {
  resetBillingProvider();
});
