/**
 * Unit tests for the billing.subscription.upgrade.start handler.
 *
 * Covers the authorization guards (unauthenticated principal, missing orgId,
 * the Owner/Billing role gate), the active-subscription conflict
 * reclassification, and the happy path (valid context → createCheckoutSession
 * called and response returned). The billing seam and the org-role gate
 * (`@oxagen/iam/org-role`) are mocked at the module level, the same way
 * `billing.credits.purchase.ts` — the handler this gate was copied from —
 * gates its own top-up capability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const {
  mockCreateCheckoutSession,
  mockAssertOrgRole,
  mockResolveActingUserId,
} = vi.hoisted(() => ({
  mockCreateCheckoutSession: vi.fn(),
  mockAssertOrgRole: vi.fn(),
  mockResolveActingUserId: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    createCheckoutSession: mockCreateCheckoutSession,
  };
});

vi.mock("@oxagen/iam/org-role", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam/org-role")>();
  return {
    ...real,
    assertOrgRole: mockAssertOrgRole,
    resolveActingUserId: mockResolveActingUserId,
  };
});

// ── imports after mocks ───────────────────────────────────────────────────────
import { billingSubscriptionUpgradeStartHandler } from "./billing.subscription_upgrade.start";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const validCtx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const validInput = {
  planSlug: "pro",
  interval: "month" as const,
  successUrl: "https://example.com/success",
  cancelUrl: "https://example.com/cancel",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the acting user resolves to the context's own userId and holds
  // an allowed org role. Individual tests override one or both.
  mockResolveActingUserId.mockImplementation(
    async (ctx: CapabilityContext) => ctx.userId ?? "acted-as-key-creator",
  );
  mockAssertOrgRole.mockResolvedValue(undefined);
});

// ── authorization guards ──────────────────────────────────────────────────────

describe("billingSubscriptionUpgradeStartHandler — authorization guards", () => {
  it("throws when no principal is present (no userId and no apiKeyId)", async () => {
    const unauthenticatedCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: null,
    };
    await expect(
      billingSubscriptionUpgradeStartHandler(validInput, unauthenticatedCtx),
    ).rejects.toThrow(/Unauthorized/);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("throws when orgId is empty (session-authenticated, unscoped)", async () => {
    const unscopedCtx: CapabilityContext = {
      ...validCtx,
      userId: "usr-scoped",
      apiKeyId: null,
      orgId: "",
    };
    await expect(
      billingSubscriptionUpgradeStartHandler(validInput, unscopedCtx),
    ).rejects.toThrow(/Forbidden/);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects before calling createCheckoutSession when unauthenticated", async () => {
    const unauthCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: null,
    };
    await expect(
      billingSubscriptionUpgradeStartHandler(validInput, unauthCtx),
    ).rejects.toThrow();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("billingSubscriptionUpgradeStartHandler — happy path", () => {
  it("calls createCheckoutSession and returns checkoutUrl for a valid user context", async () => {
    mockCreateCheckoutSession.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/session_abc",
    });

    const result = await billingSubscriptionUpgradeStartHandler(
      validInput,
      validCtx,
    );

    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      orgId: "org-1",
      planSlug: "pro",
      interval: "month",
      successUrl: "https://example.com/success",
      cancelUrl: "https://example.com/cancel",
    });
    expect(result).toEqual({
      checkoutUrl: "https://checkout.stripe.com/session_abc",
      planSlug: "pro",
      interval: "month",
    });
  });

  it("calls createCheckoutSession for a valid API-key context (no userId)", async () => {
    mockCreateCheckoutSession.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/session_xyz",
    });

    const apiKeyCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_abc",
    };

    const result = await billingSubscriptionUpgradeStartHandler(
      validInput,
      apiKeyCtx,
    );

    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/session_xyz");
  });
});

// ── role gate ─────────────────────────────────────────────────────────────────

describe("billingSubscriptionUpgradeStartHandler — role gate", () => {
  it("propagates a role refusal from assertOrgRole and never calls createCheckoutSession", async () => {
    const refusal = new HandlerError({
      code: "forbidden",
      reason: "org_role_required",
    });
    mockAssertOrgRole.mockRejectedValueOnce(refusal);

    await expect(
      billingSubscriptionUpgradeStartHandler(validInput, validCtx),
    ).rejects.toBe(refusal);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("resolves the acting user and gates on org Owner or Billing", async () => {
    mockCreateCheckoutSession.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/session_role",
    });

    await billingSubscriptionUpgradeStartHandler(validInput, validCtx);

    expect(mockResolveActingUserId).toHaveBeenCalledWith(validCtx);
    expect(mockAssertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ ...validCtx, userId: "u-1" }),
      { org: ["Owner", "Billing"] },
    );
  });

  it("gates an API-key context on the resolved key creator, not the (absent) session user", async () => {
    mockCreateCheckoutSession.mockResolvedValueOnce({
      url: "https://checkout.stripe.com/session_key",
    });
    mockResolveActingUserId.mockResolvedValueOnce("usr-creator");

    const apiKeyCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_abc",
    };

    await billingSubscriptionUpgradeStartHandler(validInput, apiKeyCtx);

    expect(mockResolveActingUserId).toHaveBeenCalledWith(apiKeyCtx);
    expect(mockAssertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ ...apiKeyCtx, userId: "usr-creator" }),
      { org: ["Owner", "Billing"] },
    );
  });
});

// ── active-subscription conflict ────────────────────────────────────────────

describe("billingSubscriptionUpgradeStartHandler — active-subscription conflict", () => {
  it("reclassifies an active_subscription_exists error into a HandlerError conflict", async () => {
    class FakeActiveSubscriptionError extends Error {
      readonly code = "active_subscription_exists" as const;
      constructor() {
        super("Org already has an active subscription (sub_123).");
        this.name = "ActiveSubscriptionError";
      }
    }
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new FakeActiveSubscriptionError(),
    );

    const promise = billingSubscriptionUpgradeStartHandler(
      validInput,
      validCtx,
    );

    await expect(promise).rejects.toSatisfy(
      (err) => isHandlerError(err) && err.code === "conflict",
    );
    await expect(promise).rejects.toMatchObject({
      code: "conflict",
      reason: "active_subscription_exists",
    });
  });

  it("rethrows any other createCheckoutSession error unchanged", async () => {
    const stripeDown = new Error("stripe down");
    mockCreateCheckoutSession.mockRejectedValueOnce(stripeDown);

    await expect(
      billingSubscriptionUpgradeStartHandler(validInput, validCtx),
    ).rejects.toBe(stripeDown);
  });
});
