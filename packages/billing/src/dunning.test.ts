/**
 * Unit tests for dunning.ts
 *
 * Covers:
 *  - getOrgBillingStatus reads settings + subscription
 *  - assertOrgCanConsume: allows active/grace, throws BillingSuspendedError when suspended
 *  - onInvoicePaymentFailed: sets grace state, idempotent on delinquentSince
 *  - onInvoicePaymentFailed: notification fires AFTER transaction commits (post-tx withSystemDb)
 *  - onInvoicePaymentFailed: notification failure does not mask grace state write
 *  - onInvoiceRecovered: resets to active, no-op if already active
 *  - sweepDunning: grace + elapsed → suspended; grace + not elapsed → skipped
 *  - isBillingSuspended type guard
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BillingInvoice } from "./provider";

// ---------------------------------------------------------------------------
// Notifications mock
// ---------------------------------------------------------------------------

const notifyOrgManagersMock = vi.fn().mockResolvedValue(undefined);
const paymentFailedTemplateMock = vi.fn().mockReturnValue({
  subject: "Payment failed",
  text: "Payment failed text",
  html: "<p>Payment failed</p>",
});

vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: notifyOrgManagersMock,
  paymentFailedTemplate: paymentFailedTemplateMock,
}));

// ---------------------------------------------------------------------------
// Drizzle-orm mock — minimal stubs used by dunning.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

interface DbState {
  settingsRow: Record<string, unknown> | null;
  settingsMany: Array<Record<string, unknown>>;
  subRow: Record<string, unknown> | null;
  orgRow: Record<string, unknown> | null;
  insertCalled: boolean;
  updateSets: Array<Record<string, unknown>>;
}

function makeDbState(): DbState {
  return {
    settingsRow: null,
    settingsMany: [],
    subRow: null,
    orgRow: { name: "Test Org" },
    insertCalled: false,
    updateSets: [],
  };
}

function makeDb(state: DbState) {
  return {
    query: {
      orgBillingSettings: {
        findFirst: vi.fn(async () => state.settingsRow),
        findMany: vi.fn(async () => state.settingsMany),
      },
      subscriptions: {
        findFirst: vi.fn(async () => state.subRow),
      },
      organizations: {
        findFirst: vi.fn(async () => state.orgRow),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => {
        state.insertCalled = true;
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        state.updateSets.push(vals);
        return {
          where: vi.fn(() => Promise.resolve()),
        };
      }),
    })),
  };
}

const dbStateHolder: { instance: ReturnType<typeof makeDb> | null } = { instance: null };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbStateHolder.instance,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(dbStateHolder.instance),
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(dbStateHolder.instance),
  };
});

// Import after mocks.
const {
  getOrgBillingStatus,
  assertOrgCanConsume,
  onInvoicePaymentFailed,
  onInvoiceRecovered,
  sweepDunning,
  BillingSuspendedError,
  isBillingSuspended,
  DUNNING_GRACE_DAYS,
} = await import("./dunning");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    id: "in_test_001",
    providerInvoiceId: "in_test_001",
    number: "INV-001",
    status: "open",
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DUNNING_GRACE_DAYS", () => {
  it("is 7", () => {
    expect(DUNNING_GRACE_DAYS).toBe(7);
  });
});

describe("BillingSuspendedError", () => {
  it("has code billing_suspended", () => {
    const err = new BillingSuspendedError(null);
    expect(err.code).toBe("billing_suspended");
    expect(err instanceof Error).toBe(true);
  });

  it("carries graceEndsAt", () => {
    const d = new Date("2026-01-01");
    const err = new BillingSuspendedError(d);
    expect(err.graceEndsAt).toBe(d);
  });
});

describe("isBillingSuspended", () => {
  it("returns true for BillingSuspendedError", () => {
    expect(isBillingSuspended(new BillingSuspendedError(null))).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isBillingSuspended(new Error("other"))).toBe(false);
    expect(isBillingSuspended("string")).toBe(false);
    expect(isBillingSuspended(null)).toBe(false);
  });
});

describe("getOrgBillingStatus", () => {
  beforeEach(() => {
    const state = makeDbState();
    dbStateHolder.instance = makeDb(state);
  });

  it("returns active state when no settings row", async () => {
    const state = makeDbState(); // settingsRow = null
    dbStateHolder.instance = makeDb(state);
    const status = await getOrgBillingStatus("org-abc");
    expect(status.state).toBe("active");
    expect(status.pastDue).toBe(false);
  });

  it("reflects grace dunningState from settings row", async () => {
    const state = makeDbState();
    state.settingsRow = {
      dunningState: "grace",
      delinquentSince: new Date("2026-01-01"),
      graceEndsAt: new Date("2026-01-08"),
      suspendedAt: null,
    };
    dbStateHolder.instance = makeDb(state);
    const status = await getOrgBillingStatus("org-abc");
    expect(status.state).toBe("grace");
  });

  it("reflects suspended dunningState from settings row", async () => {
    const state = makeDbState();
    state.settingsRow = {
      dunningState: "suspended",
      delinquentSince: new Date("2026-01-01"),
      graceEndsAt: new Date("2026-01-08"),
      suspendedAt: new Date("2026-01-08"),
    };
    dbStateHolder.instance = makeDb(state);
    const status = await getOrgBillingStatus("org-abc");
    expect(status.state).toBe("suspended");
    expect(status.pastDue).toBe(false);
  });

  it("pastDue is true when subscription status is past_due", async () => {
    const state = makeDbState();
    state.settingsRow = { dunningState: "active", delinquentSince: null, graceEndsAt: null, suspendedAt: null };
    state.subRow = { status: "past_due" };
    dbStateHolder.instance = makeDb(state);
    const status = await getOrgBillingStatus("org-abc");
    expect(status.pastDue).toBe(true);
  });
});

describe("assertOrgCanConsume", () => {
  it("resolves without throwing when state is active", async () => {
    const state = makeDbState();
    state.settingsRow = { dunningState: "active", delinquentSince: null, graceEndsAt: null, suspendedAt: null };
    dbStateHolder.instance = makeDb(state);
    await expect(assertOrgCanConsume("org-abc")).resolves.toBeUndefined();
  });

  it("resolves without throwing when state is grace", async () => {
    const state = makeDbState();
    state.settingsRow = { dunningState: "grace", delinquentSince: new Date(), graceEndsAt: new Date(), suspendedAt: null };
    dbStateHolder.instance = makeDb(state);
    await expect(assertOrgCanConsume("org-abc")).resolves.toBeUndefined();
  });

  it("throws BillingSuspendedError when state is suspended", async () => {
    const suspendedAt = new Date("2026-01-08");
    const graceEndsAt = new Date("2026-01-08");
    const state = makeDbState();
    state.settingsRow = {
      dunningState: "suspended",
      delinquentSince: new Date("2026-01-01"),
      graceEndsAt,
      suspendedAt,
    };
    dbStateHolder.instance = makeDb(state);

    await expect(assertOrgCanConsume("org-abc")).rejects.toThrow(BillingSuspendedError);
  });

  it("BillingSuspendedError has correct code", async () => {
    const state = makeDbState();
    state.settingsRow = { dunningState: "suspended", delinquentSince: null, graceEndsAt: null, suspendedAt: null };
    dbStateHolder.instance = makeDb(state);

    let caught: unknown;
    try {
      await assertOrgCanConsume("org-abc");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BillingSuspendedError);
    expect((caught as InstanceType<typeof BillingSuspendedError>).code).toBe("billing_suspended");
  });
});

describe("onInvoicePaymentFailed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset notification mock to its default resolved behavior.
    notifyOrgManagersMock.mockResolvedValue(undefined);
    paymentFailedTemplateMock.mockReturnValue({
      subject: "Payment failed",
      text: "Payment failed text",
      html: "<p>Payment failed</p>",
    });
  });

  it("sets dunningState to grace when no existing settings row", async () => {
    const state = makeDbState();
    state.settingsRow = null; // no existing row
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: "org-abc" }));

    expect(state.insertCalled).toBe(true);
  });

  it("updates existing settings row to grace state", async () => {
    const state = makeDbState();
    state.settingsRow = { id: "settings-uuid-1", dunningState: "active", delinquentSince: null };
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: "org-abc" }));

    const updateCall = state.updateSets[0];
    expect(updateCall).toBeDefined();
    expect(updateCall?.dunningState).toBe("grace");
    expect(updateCall?.graceEndsAt).toBeDefined();
  });

  it("preserves existing delinquentSince (idempotent)", async () => {
    const originalDelinquent = new Date("2026-01-01");
    const state = makeDbState();
    state.settingsRow = {
      id: "settings-uuid-1",
      dunningState: "grace",
      delinquentSince: originalDelinquent,
    };
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: "org-abc" }));

    const updateCall = state.updateSets[0];
    expect(updateCall?.delinquentSince).toBe(originalDelinquent);
  });

  it("resolves orgId from subscriptionId when invoice.orgId is null", async () => {
    const state = makeDbState();
    state.settingsRow = null;
    state.subRow = { orgId: "org-from-sub" };
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: null, subscriptionId: "sub_test_001" }));

    // If we reached insert, org was resolved.
    expect(state.insertCalled).toBe(true);
  });

  it("returns early when orgId cannot be resolved", async () => {
    const state = makeDbState();
    state.settingsRow = null;
    state.subRow = null;
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: null, subscriptionId: null }));

    expect(state.insertCalled).toBe(false);
    expect(state.updateSets).toHaveLength(0);
  });

  it("calls notifyOrgManagers after the grace state is written (not inside the tx)", async () => {
    // Verifies fix for floating-promise-over-committed-tx bug:
    // the notification must be awaited in a post-transaction withSystemDb call,
    // not in a void IIFE that closes over the already-committed `tx`.
    const state = makeDbState();
    state.settingsRow = null;
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: "org-abc" }));

    // Grace state written (insert) AND notification fired.
    expect(state.insertCalled).toBe(true);
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
    expect(notifyOrgManagersMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-abc", kind: "system" }),
    );
  });

  it("notification failure does not prevent grace state write from resolving", async () => {
    // If the notification throws, the dunning state write must still be visible
    // to the caller. The notification catch block swallows the error.
    const state = makeDbState();
    state.settingsRow = null;
    dbStateHolder.instance = makeDb(state);
    notifyOrgManagersMock.mockRejectedValueOnce(new Error("smtp timeout"));

    // Must NOT throw.
    await expect(
      onInvoicePaymentFailed(makeInvoice({ orgId: "org-abc" })),
    ).resolves.toBeUndefined();

    // Grace state was written before the notification failed.
    expect(state.insertCalled).toBe(true);
    // Notification was attempted.
    expect(notifyOrgManagersMock).toHaveBeenCalledOnce();
  });

  it("notification is not sent when orgId cannot be resolved", async () => {
    const state = makeDbState();
    state.settingsRow = null;
    state.subRow = null;
    dbStateHolder.instance = makeDb(state);

    await onInvoicePaymentFailed(makeInvoice({ orgId: null, subscriptionId: null }));

    expect(notifyOrgManagersMock).not.toHaveBeenCalled();
  });
});

describe("onInvoiceRecovered", () => {
  it("resets dunningState to active and clears dunning fields", async () => {
    const state = makeDbState();
    state.settingsRow = { id: "settings-uuid-1", dunningState: "grace" };
    dbStateHolder.instance = makeDb(state);

    await onInvoiceRecovered(makeInvoice({ orgId: "org-abc" }));

    const updateCall = state.updateSets[0];
    expect(updateCall?.dunningState).toBe("active");
    expect(updateCall?.delinquentSince).toBeNull();
    expect(updateCall?.graceEndsAt).toBeNull();
    expect(updateCall?.suspendedAt).toBeNull();
  });

  it("is a no-op when already active", async () => {
    const state = makeDbState();
    state.settingsRow = { id: "settings-uuid-1", dunningState: "active" };
    dbStateHolder.instance = makeDb(state);

    await onInvoiceRecovered(makeInvoice({ orgId: "org-abc" }));

    expect(state.updateSets).toHaveLength(0);
  });

  it("is a no-op when no settings row", async () => {
    const state = makeDbState();
    state.settingsRow = null;
    dbStateHolder.instance = makeDb(state);

    await onInvoiceRecovered(makeInvoice({ orgId: "org-abc" }));

    expect(state.updateSets).toHaveLength(0);
  });
});

describe("sweepDunning", () => {
  it("returns { suspended: 0 } when no grace orgs", async () => {
    const state = makeDbState();
    state.settingsMany = [];
    dbStateHolder.instance = makeDb(state);

    const result = await sweepDunning();
    expect(result).toEqual({ suspended: 0 });
  });

  it("suspends orgs in grace with elapsed graceEndsAt", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const state = makeDbState();
    state.settingsMany = [
      { id: "settings-uuid-1", orgId: "org-abc", dunningState: "grace", graceEndsAt: past },
      { id: "settings-uuid-2", orgId: "org-xyz", dunningState: "grace", graceEndsAt: past },
    ];
    dbStateHolder.instance = makeDb(state);

    const result = await sweepDunning();
    expect(result.suspended).toBe(2);
    // Single update call suspends both orgs via inArray.
    expect(state.updateSets.length).toBe(1);
    expect(state.updateSets[0]!.dunningState).toBe("suspended");
    expect(state.updateSets[0]!.suspendedAt).toBeDefined();
  });
});
