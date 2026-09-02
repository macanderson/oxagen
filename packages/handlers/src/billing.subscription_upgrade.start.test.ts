/**
 * Unit tests for the billing.subscription.upgrade.start handler.
 *
 * Covers the authorization guards (unauthenticated principal, missing orgId)
 * and the happy path (valid context → createCheckoutSession called and
 * response returned). The billing seam is mocked at the module level.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const { mockCreateCheckoutSession } = vi.hoisted(() => ({
  mockCreateCheckoutSession: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    createCheckoutSession: mockCreateCheckoutSession,
  };
});

// ── imports after mocks ───────────────────────────────────────────────────────
import { billingSubscriptionUpgradeStartHandler } from "./billing.subscription_upgrade.start";
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
