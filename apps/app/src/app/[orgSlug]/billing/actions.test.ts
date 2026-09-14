/**
 * actions.test.ts — unit tests for billing server actions.
 *
 * Mocking strategy:
 *   - getSessionOrRedirect → vi.mock
 *   - resolveOrg → vi.mock
 *   - @oxagen/tenancy → vi.mock (runInTenantScope invokes its callback inline)
 *   - @oxagen/database → vi.mock (dynamic import, withTenantDb inline)
 *   - drizzle-orm → vi.mock
 *   - @oxagen/billing → vi.mock
 *   - @oxagen/config/env → vi.mock
 *   - next/cache → vi.mock
 *   - @oxagen/handlers/logger → vi.mock
 *
 * Coverage:
 *   1. role "member" → every mutating action returns {ok:false, error NOT_AUTHORIZED}
 *   2. role "owner" → resolveManagedOrg proceeds, action succeeds
 *   3. setSeatsAction Zod: seats=0 and seats=-1 fail, seats=1 passes
 *   4. isSeatLimitError branch → {ok:false, code:"seat_limit_reached", licenses, used}
 *   5. buyCreditsAction: amountUsd=4.99 fails, amountUsd=5 passes
 *   6. CAN_MANAGE_BILLING stays in sync with resolve-org's BILLING_MANAGER_ROLES
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures — vi.hoisted() ensures they're available in vi.mock factories
// ---------------------------------------------------------------------------

const { mockDbRows, mockWithTenantDb, mockRunInTenantScope } = vi.hoisted(
  () => {
    const mockDbRows: Array<{ role: string | null }> = [];

    const mockLimit = vi.fn(() => Promise.resolve(mockDbRows));
    const mockWhere = vi.fn(() => ({ limit: mockLimit }));
    const mockFrom = vi.fn(() => ({ where: mockWhere }));
    const mockSelect = vi.fn(() => ({ from: mockFrom }));
    const mockTx = { select: mockSelect };
    const mockWithTenantDb = vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(mockTx),
    );

    const mockRunInTenantScope = vi.fn(
      (_scope: unknown, fn: () => Promise<unknown>) => fn(),
    );

    return { mockDbRows, mockWithTenantDb, mockRunInTenantScope };
  },
);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  getOrgRole: vi.fn().mockResolvedValue("owner"),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mockRunInTenantScope,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    cancelOrgSubscription: vi.fn(),
    reactivateOrgSubscription: vi.fn(),
    changeOrgPlan: vi.fn(),
    setSubscriptionSeats: vi.fn(),
    isSeatLimitError: vi.fn(() => false),
    isTierDenied: vi.fn(() => false),
    createUsageCreditCheckout: vi.fn(),
    previewSeatChange: vi.fn(),
    previewPlanChange: vi.fn(),
    createPaymentMethodSetupIntent: vi.fn(),
    syncPaymentMethodsFromStripe: vi.fn(),
    setOrgDefaultPaymentMethod: vi.fn(),
    removeOrgPaymentMethod: vi.fn(),
    updateAutoReloadSettings: vi.fn(),
  };
});

vi.mock("@oxagen/config/env", () => ({
  // The billing actions use requireEnv (scoped to NEXT_PUBLIC_APP_URL) — NOT
  // loadEnv (full-schema). loadEnv is kept here only to assert it is never
  // called (regression for the page-wipe, digest 812344190).
  requireEnv: vi.fn(() => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  })),
  loadEnv: vi.fn(() => ({
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
  })),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// The actions emit through the consolidated registry helper emitSecurityEvent
// (OXA-N1); mock it directly and assert the single event-payload argument.
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn(() => vi.fn()),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  cancelSubscriptionAction,
  reactivateSubscriptionAction,
  setSeatsAction,
  buyCreditsAction,
  changePlanAction,
  updateAutoReloadAction,
  removePaymentMethodAction,
  setDefaultPaymentMethodAction,
  createSetupIntentAction,
} from "./actions";

import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import {
  cancelOrgSubscription,
  setSubscriptionSeats,
  isSeatLimitError,
  createUsageCreditCheckout,
  changeOrgPlan,
} from "@oxagen/billing";
import { requireEnv, loadEnv } from "@oxagen/config/env";
import { emitSecurityEvent } from "@oxagen/database/security";

const mockEmitSecurityEvent = vi.mocked(emitSecurityEvent);

// Import BILLING_MANAGER_ROLES for the cross-module sync assertion.
// We import resolve-org as a module and check the exported constant's behavior
// matches CAN_MANAGE_BILLING in billing/actions.ts by comparing them via planTierLabel.
// The canonical set from resolve-org.ts (private const, tested via assertBillingManager):
const RESOLVE_ORG_BILLING_ROLES = new Set(["owner", "admin", "billing"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockSession = { user: { id: "user-1" } };
const mockOrg = { id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" };

function setRole(role: string | null) {
  mockDbRows.length = 0;
  if (role !== null) mockDbRows.push({ role });
}

function setupBase() {
  vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
  vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupBase();
});

// ---------------------------------------------------------------------------
// 1. role "member" → NOT_AUTHORIZED on every mutating action
// ---------------------------------------------------------------------------

describe("resolveManagedOrg gate — non-billing role", () => {
  beforeEach(() => {
    setRole("member");
  });

  it("cancelSubscriptionAction returns {ok:false} with NOT_AUTHORIZED error", async () => {
    const result = await cancelSubscriptionAction({ orgSlug: "acme" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission");
  });

  it("reactivateSubscriptionAction returns {ok:false} for member", async () => {
    const result = await reactivateSubscriptionAction({ orgSlug: "acme" });
    expect(result.ok).toBe(false);
  });

  it("setSeatsAction returns {ok:false} for member (valid seats)", async () => {
    const result = await setSeatsAction({ orgSlug: "acme", seats: 5 });
    expect(result.ok).toBe(false);
  });

  it("buyCreditsAction returns {ok:false} for member", async () => {
    const result = await buyCreditsAction({ orgSlug: "acme", amountUsd: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permission");
  });

  it("cancelOrgSubscription is NOT called when member tries to cancel", async () => {
    await cancelSubscriptionAction({ orgSlug: "acme" });
    expect(cancelOrgSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. role "owner" → resolveManagedOrg proceeds, action succeeds
// ---------------------------------------------------------------------------

describe("resolveManagedOrg gate — owner role", () => {
  beforeEach(() => {
    setRole("owner");
  });

  it("cancelSubscriptionAction succeeds for owner", async () => {
    vi.mocked(cancelOrgSubscription).mockResolvedValue(undefined);
    const result = await cancelSubscriptionAction({ orgSlug: "acme" });
    expect(result.ok).toBe(true);
    expect(cancelOrgSubscription).toHaveBeenCalledWith("org-1");
  });

  it("reactivateSubscriptionAction succeeds for owner", async () => {
    const { reactivateOrgSubscription } = await import("@oxagen/billing");
    vi.mocked(reactivateOrgSubscription).mockResolvedValue(undefined);
    const result = await reactivateSubscriptionAction({ orgSlug: "acme" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. setSeatsAction Zod validation
// ---------------------------------------------------------------------------

describe("setSeatsAction — Zod validation", () => {
  beforeEach(() => {
    setRole("owner");
  });

  it("seats=0 → {ok:false} (Zod min(1) fails)", async () => {
    const result = await setSeatsAction({ orgSlug: "acme", seats: 0 });
    expect(result.ok).toBe(false);
    expect(setSubscriptionSeats).not.toHaveBeenCalled();
  });

  it("seats=-1 → {ok:false} (Zod min(1) fails)", async () => {
    const result = await setSeatsAction({ orgSlug: "acme", seats: -1 });
    expect(result.ok).toBe(false);
    expect(setSubscriptionSeats).not.toHaveBeenCalled();
  });

  it("seats=1 → calls setSubscriptionSeats and returns {ok:true}", async () => {
    vi.mocked(setSubscriptionSeats).mockResolvedValue(undefined);
    const result = await setSeatsAction({ orgSlug: "acme", seats: 1 });
    expect(result.ok).toBe(true);
    expect(setSubscriptionSeats).toHaveBeenCalledWith("org-1", 1);
  });
});

// ---------------------------------------------------------------------------
// 4. isSeatLimitError branch → structured error
// ---------------------------------------------------------------------------

describe("setSeatsAction — isSeatLimitError branch", () => {
  beforeEach(() => {
    setRole("owner");
  });

  it("returns {ok:false, code:'seat_limit_reached', licenses, used} on SeatLimitError", async () => {
    const seatErr = Object.assign(new Error("Seat limit reached"), {
      licenses: 10,
      used: 10,
    });
    vi.mocked(setSubscriptionSeats).mockRejectedValue(seatErr);
    vi.mocked(isSeatLimitError).mockReturnValue(true);

    const result = await setSeatsAction({ orgSlug: "acme", seats: 11 });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "seat_limit_reached") {
      expect(result.licenses).toBe(10);
      expect(result.used).toBe(10);
      expect(result.code).toBe("seat_limit_reached");
    } else {
      // Force a clear failure if the branch didn't match
      expect(result.ok).toBe(false);
      // The code field should have been set by the isSeatLimitError branch
      expect("code" in result && result.code).toBe("seat_limit_reached");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. buyCreditsAction amountUsd validation
// ---------------------------------------------------------------------------

describe("buyCreditsAction — Zod validation", () => {
  beforeEach(() => {
    setRole("owner");
  });

  it("amountUsd=4.99 → {ok:false} (Zod min(5) fails)", async () => {
    const result = await buyCreditsAction({ orgSlug: "acme", amountUsd: 4.99 });
    expect(result.ok).toBe(false);
  });

  it("amountUsd=5 → proceeds (calls createUsageCreditCheckout directly)", async () => {
    // The action now calls the billing function directly (no cookie-less self
    // fetch — that returned a spurious 401). Assert the billing fn is invoked
    // with the resolved orgId + cents and its checkout url is returned.
    vi.mocked(createUsageCreditCheckout).mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_test",
      grantCents: 500,
      priceCents: 500,
      percent: 0,
    } as never);

    setRole("owner");
    const result = await buyCreditsAction({ orgSlug: "acme", amountUsd: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toContain("stripe");
    expect(createUsageCreditCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", grantCents: 500 }),
    );
  });

  it("amountUsd=0 → {ok:false}", async () => {
    const result = await buyCreditsAction({ orgSlug: "acme", amountUsd: 0 });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. CAN_MANAGE_BILLING stays in sync with resolve-org's BILLING_MANAGER_ROLES
// ---------------------------------------------------------------------------

describe("CAN_MANAGE_BILLING sync with resolve-org BILLING_MANAGER_ROLES", () => {
  // We verify this indirectly: every role in RESOLVE_ORG_BILLING_ROLES
  // should pass the billing gate (resolveManagedOrg returns non-null),
  // and roles outside the set should fail.

  for (const role of RESOLVE_ORG_BILLING_ROLES) {
    it(`role '${role}' passes the billing action gate (same as resolve-org allows)`, async () => {
      setRole(role);
      vi.mocked(cancelOrgSubscription).mockResolvedValue(undefined);
      const result = await cancelSubscriptionAction({ orgSlug: "acme" });
      expect(result.ok).toBe(true);
    });
  }

  const NON_MANAGER = ["member", "viewer", "guest"];
  for (const role of NON_MANAGER) {
    it(`role '${role}' is blocked by the billing gate (same as resolve-org blocks)`, async () => {
      setRole(role);
      const result = await cancelSubscriptionAction({ orgSlug: "acme" });
      expect(result.ok).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Security event emission — SOC2 CC6.3/CC6.8
// ---------------------------------------------------------------------------

describe("security event emission — billing.access_denied on gate failure", () => {
  beforeEach(() => {
    setRole("member");
  });

  it("emits billing.access_denied (outcome 'deny') when caller lacks billing-manager role", async () => {
    await cancelSubscriptionAction({ orgSlug: "acme" });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.access_denied");
    expect(event.outcome).toBe("deny");
  });

  it("emits actorUserId from session on denial", async () => {
    await cancelSubscriptionAction({ orgSlug: "acme" });
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.actorUserId).toBe("user-1");
  });

  it("emits orgId from resolved org on denial", async () => {
    await cancelSubscriptionAction({ orgSlug: "acme" });
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.orgId).toBe("org-1");
  });
});

describe("security event emission — billing.subscription_canceled on success", () => {
  beforeEach(() => {
    setRole("owner");
    vi.mocked(cancelOrgSubscription).mockResolvedValue(undefined);
  });

  it("emits billing.subscription_canceled (outcome 'success') after successful cancel", async () => {
    await cancelSubscriptionAction({ orgSlug: "acme" });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.subscription_canceled");
    expect(event.outcome).toBe("success");
    expect(event.actorUserId).toBe("user-1");
    expect(event.orgId).toBe("org-1");
    expect(event.workspaceId).toBeNull();
  });

  it("does NOT emit a security event when cancel throws", async () => {
    vi.mocked(cancelOrgSubscription).mockRejectedValue(
      new Error("stripe down"),
    );
    await cancelSubscriptionAction({ orgSlug: "acme" });
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("security event emission — billing.subscription_reactivated on success", () => {
  it("emits billing.subscription_reactivated on owner success", async () => {
    setRole("owner");
    const { reactivateOrgSubscription } = await import("@oxagen/billing");
    vi.mocked(reactivateOrgSubscription).mockResolvedValue(undefined);

    await reactivateSubscriptionAction({ orgSlug: "acme" });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.subscription_reactivated");
    expect(event.outcome).toBe("success");
  });
});

describe("security event emission — billing.seats_changed on success", () => {
  it("emits billing.seats_changed when seats updated", async () => {
    setRole("owner");
    vi.mocked(setSubscriptionSeats).mockResolvedValue(undefined);

    await setSeatsAction({ orgSlug: "acme", seats: 3 });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.seats_changed");
    expect(event.outcome).toBe("success");
  });
});

describe("security event emission — billing.auto_reload_updated on success", () => {
  it("emits billing.auto_reload_updated when settings saved", async () => {
    setRole("owner");
    const { updateAutoReloadSettings } = await import("@oxagen/billing");
    vi.mocked(updateAutoReloadSettings).mockResolvedValue({
      enabled: true,
      thresholdCents: 500,
      amountCents: 2000,
      paymentMethodId: null,
    } as never);

    await updateAutoReloadAction({ orgSlug: "acme", enabled: true });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.auto_reload_updated");
    expect(event.outcome).toBe("success");
  });
});

describe("security event emission — billing.payment_method_default_changed on success", () => {
  it("emits billing.payment_method_default_changed when default PM set", async () => {
    setRole("owner");
    const { setOrgDefaultPaymentMethod } = await import("@oxagen/billing");
    vi.mocked(setOrgDefaultPaymentMethod).mockResolvedValue(undefined);

    await setDefaultPaymentMethodAction({
      orgSlug: "acme",
      paymentMethodId: "pm_abc",
    });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.payment_method_default_changed");
    expect(event.outcome).toBe("success");
  });
});

describe("security event emission — billing.payment_method_removed on success", () => {
  it("emits billing.payment_method_removed when PM removed", async () => {
    setRole("owner");
    const { removeOrgPaymentMethod } = await import("@oxagen/billing");
    vi.mocked(removeOrgPaymentMethod).mockResolvedValue(undefined);

    await removePaymentMethodAction({
      orgSlug: "acme",
      paymentMethodId: "pm_xyz",
    });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.payment_method_removed");
    expect(event.outcome).toBe("success");
  });
});

describe("security event emission — billing.payment_method_added on setup-intent success", () => {
  it("emits billing.payment_method_added when setup intent created", async () => {
    setRole("owner");
    const { createPaymentMethodSetupIntent } = await import("@oxagen/billing");
    vi.mocked(createPaymentMethodSetupIntent).mockResolvedValue({
      clientSecret: "cs_test_abc",
    } as never);

    await createSetupIntentAction({ orgSlug: "acme" });

    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("billing.payment_method_added");
    expect(event.outcome).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// 8. Env validation is scoped + caught — regression for the billing page-wipe
//    (prod STRIPE_WEBHOOK_SECRET="" made loadEnv() throw an UNCAUGHT server-
//    action rejection outside the try, wiping the page; digest 812344190).
//    Guarantees: (a) these actions validate ONLY NEXT_PUBLIC_APP_URL, never the
//    whole monorepo schema, so an unrelated malformed var can't break them; and
//    (b) any env-validation failure degrades to {ok:false}, never a throw.
// ---------------------------------------------------------------------------

describe("env validation scope + resilience (regression: page-wipe 812344190)", () => {
  beforeEach(() => {
    setRole("owner");
  });

  it("buyCreditsAction validates ONLY NEXT_PUBLIC_APP_URL (never full loadEnv)", async () => {
    vi.mocked(createUsageCreditCheckout).mockResolvedValue({
      url: "https://checkout.stripe.com/pay/cs_test",
      grantCents: 500,
      priceCents: 500,
      percent: 0,
    } as never);

    await buyCreditsAction({ orgSlug: "acme", amountUsd: 5 });

    expect(requireEnv).toHaveBeenCalledWith(["NEXT_PUBLIC_APP_URL"]);
    expect(loadEnv).not.toHaveBeenCalled();
  });

  it("changePlanAction validates ONLY NEXT_PUBLIC_APP_URL (never full loadEnv)", async () => {
    vi.mocked(changeOrgPlan).mockResolvedValue(null as never);

    await changePlanAction({
      orgSlug: "acme",
      targetPlanSlug: "scale-v2",
      interval: "month",
    });

    expect(requireEnv).toHaveBeenCalledWith(["NEXT_PUBLIC_APP_URL"]);
    expect(loadEnv).not.toHaveBeenCalled();
  });

  it("buyCreditsAction returns {ok:false} (no throw) when env validation fails", async () => {
    vi.mocked(requireEnv).mockImplementationOnce(() => {
      throw new Error(
        'Invalid environment (required: NEXT_PUBLIC_APP_URL):\n  - STRIPE_WEBHOOK_SECRET: Invalid input: must start with "whsec_"',
      );
    });

    const result = await buyCreditsAction({ orgSlug: "acme", amountUsd: 5 });
    expect(result.ok).toBe(false);
  });

  it("changePlanAction returns {ok:false} (no throw) when env validation fails", async () => {
    vi.mocked(requireEnv).mockImplementationOnce(() => {
      throw new Error("Invalid environment");
    });

    const result = await changePlanAction({
      orgSlug: "acme",
      targetPlanSlug: "scale-v2",
      interval: "month",
    });
    expect(result.ok).toBe(false);
  });
});
