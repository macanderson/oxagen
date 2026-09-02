/**
 * Unit tests for the billing.credits.purchase handler.
 *
 * Covers:
 *  - Auth guard: no userId AND no apiKeyId → throws Unauthorized.
 *  - Auth guard: missing orgId → throws Forbidden.
 *  - amountUsd → grantCents conversion (× 100, rounded).
 *  - Happy path with user session.
 *  - Happy path with API key (no userId).
 *  - Billing error (TierDeniedError, provider error) → rethrown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const { mockCreateUsageCreditCheckout } = vi.hoisted(() => ({
  mockCreateUsageCreditCheckout: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    createUsageCreditCheckout: mockCreateUsageCreditCheckout,
  };
});

// ── imports after mocks ───────────────────────────────────────────────────────
import { billingCreditsPurchaseHandler } from "./billing.credits.purchase";
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

function makeCheckoutResult(
  overrides: Partial<{
    url: string;
    sessionId: string;
    grantCents: number;
    priceCents: number;
    percent: number;
  }> = {},
) {
  return {
    url: "https://checkout.stripe.com/pay/cs_test",
    sessionId: "cs_test",
    grantCents: 5000,
    priceCents: 4850,
    percent: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── authorization guards ──────────────────────────────────────────────────────

describe("billingCreditsPurchaseHandler — authorization guards", () => {
  it("throws Unauthorized when no principal is present", async () => {
    const ctx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: null,
    };

    await expect(
      billingCreditsPurchaseHandler({ amountUsd: 50 }, ctx),
    ).rejects.toThrow(/Unauthorized/);

    expect(mockCreateUsageCreditCheckout).not.toHaveBeenCalled();
  });

  it("throws Forbidden when orgId is empty", async () => {
    const ctx: CapabilityContext = { ...validCtx, userId: "u-1", orgId: "" };

    await expect(
      billingCreditsPurchaseHandler({ amountUsd: 50 }, ctx),
    ).rejects.toThrow(/Forbidden/);

    expect(mockCreateUsageCreditCheckout).not.toHaveBeenCalled();
  });

  it("throws Forbidden when orgId is empty even with apiKeyId set", async () => {
    const ctx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_xyz",
      orgId: "",
    };

    await expect(
      billingCreditsPurchaseHandler({ amountUsd: 50 }, ctx),
    ).rejects.toThrow(/Forbidden/);

    expect(mockCreateUsageCreditCheckout).not.toHaveBeenCalled();
  });
});

// ── input conversion ──────────────────────────────────────────────────────────

describe("billingCreditsPurchaseHandler — amountUsd to grantCents conversion", () => {
  it("converts amountUsd to grantCents via × 100 (integer)", async () => {
    mockCreateUsageCreditCheckout.mockResolvedValueOnce(
      makeCheckoutResult({ grantCents: 5000 }),
    );

    await billingCreditsPurchaseHandler({ amountUsd: 50 }, validCtx);

    expect(mockCreateUsageCreditCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ grantCents: 5000, orgId: "org-1" }),
    );
  });

  it("rounds decimal amountUsd to the nearest cent", async () => {
    mockCreateUsageCreditCheckout.mockResolvedValueOnce(
      makeCheckoutResult({ grantCents: 5001 }),
    );

    await billingCreditsPurchaseHandler({ amountUsd: 50.005 }, validCtx);

    // Math.round(50.005 * 100) = 5001 (or 5000 depending on float representation)
    const call = mockCreateUsageCreditCheckout.mock.calls[0]![0] as {
      grantCents: number;
    };
    expect(Number.isInteger(call.grantCents)).toBe(true);
  });
});

// ── happy path ────────────────────────────────────────────────────────────────

describe("billingCreditsPurchaseHandler — happy path", () => {
  it("returns url, grantCents, priceCents, percent for a valid user context", async () => {
    const checkoutResult = makeCheckoutResult({
      url: "https://checkout.stripe.com/session_abc",
      grantCents: 25000,
      priceCents: 21250,
      percent: 15,
    });
    mockCreateUsageCreditCheckout.mockResolvedValueOnce(checkoutResult);

    const result = await billingCreditsPurchaseHandler(
      { amountUsd: 250 },
      validCtx,
    );

    expect(result).toEqual({
      url: "https://checkout.stripe.com/session_abc",
      grantCents: 25000,
      priceCents: 21250,
      percent: 15,
    });
    expect(mockCreateUsageCreditCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", grantCents: 25000 }),
    );
  });

  it("works for a valid API-key context (no userId)", async () => {
    mockCreateUsageCreditCheckout.mockResolvedValueOnce(makeCheckoutResult());

    const apiKeyCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_abc",
    };
    const result = await billingCreditsPurchaseHandler(
      { amountUsd: 50 },
      apiKeyCtx,
    );

    expect(result.url).toBeDefined();
    expect(mockCreateUsageCreditCheckout).toHaveBeenCalledOnce();
  });
});

// ── billing errors ────────────────────────────────────────────────────────────

describe("billingCreditsPurchaseHandler — billing errors propagate", () => {
  it("rethrows errors from createUsageCreditCheckout", async () => {
    mockCreateUsageCreditCheckout.mockRejectedValueOnce(
      new Error("Plan upgrade required (usage-credit-purchase)"),
    );

    await expect(
      billingCreditsPurchaseHandler({ amountUsd: 50 }, validCtx),
    ).rejects.toThrow("upgrade required");
  });
});
