// billing.handlers.test.ts — handler invocation tests for billing-domain tools.
//
// Pattern: vi.mock the kernel `invoke` and context seam `buildContext`.
// Each test asserts (a) buildContext called, (b) invoke called with correct
// contract name + args + { surface: "mcp" }, (c) result forwarded.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

// ── billing.credits.purchase ─────────────────────────────────────────────────

import handler_billingCreditsPurchase, {
  schema as billingCreditsPurchaseSchema,
  metadata as billingCreditsPurchaseMetadata,
} from "./billing.credits.purchase";

describe("billing.credits.purchase handler", () => {
  it("exports schema and metadata", () => {
    expect(billingCreditsPurchaseSchema).toBeDefined();
    expect(billingCreditsPurchaseMetadata.name).toBe("purchase_credits");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = {
      url: "https://checkout.stripe.com/pay/cs_test",
      grantCents: 5000,
      priceCents: 4250,
      percent: 15,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { amountUsd: 50, successUrl: undefined, cancelUrl: undefined };
    const result = await handler_billingCreditsPurchase(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "purchase_credits",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({
      url: "https://checkout.stripe.com/pay/cs_test",
      grantCents: 5000,
    });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("payment failed"));
    await expect(
      handler_billingCreditsPurchase({
        amountUsd: 10,
        successUrl: undefined,
        cancelUrl: undefined,
      }),
    ).rejects.toThrow("payment failed");
  });
});

// ── billing.subscription.read ────────────────────────────────────────────────

import handler_billingSubscriptionRead, {
  schema as billingSubscriptionReadSchema,
  metadata as billingSubscriptionReadMetadata,
} from "./billing.subscription.read";

describe("billing.subscription.read handler", () => {
  it("exports schema and metadata", () => {
    expect(billingSubscriptionReadSchema).toBeDefined();
    expect(billingSubscriptionReadMetadata.name).toBe("get_subscription");
  });

  it("calls invoke with empty args for read", async () => {
    const fakeOutput = {
      subscription: null,
      creditBalanceCents: 0,
      periodUsage: null,
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_billingSubscriptionRead({});

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("get_subscription", {}, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── billing.subscription.upgrade.start ───────────────────────────────────────

import handler_billingSubscriptionUpgradeStart, {
  schema as billingSubscriptionUpgradeStartSchema,
  metadata as billingSubscriptionUpgradeStartMetadata,
} from "./billing.subscription_upgrade.start";

describe("billing.subscription.upgrade.start handler", () => {
  it("exports schema and metadata", () => {
    expect(billingSubscriptionUpgradeStartSchema).toBeDefined();
    expect(billingSubscriptionUpgradeStartMetadata.name).toBe(
      "start_subscription_upgrade",
    );
  });

  it("calls invoke with upgrade args", async () => {
    const fakeOutput = {
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test",
      planSlug: "scale",
      interval: "month",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      planSlug: "scale",
      interval: "month" as const,
      successUrl: "https://app.oxagen.ai/billing?success=1",
      cancelUrl: "https://app.oxagen.ai/billing",
    };
    const result = await handler_billingSubscriptionUpgradeStart(args);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "start_subscription_upgrade",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test",
    });
  });
});

// ── api.key.create ────────────────────────────────────────────────────────────

import handler_apiKeyCreate, {
  schema as apiKeyCreateSchema,
  metadata as apiKeyCreateMetadata,
} from "./api.key.create";

describe("api.key.create handler", () => {
  it("exports schema and metadata", () => {
    expect(apiKeyCreateSchema).toBeDefined();
    expect(apiKeyCreateMetadata.name).toBe("create_api_key");
  });

  it("calls invoke with key creation args", async () => {
    const fakeOutput = {
      keyId: "uuid-1",
      publicId: "aky_test",
      name: "My Key",
      keyPrefix: "oxg_t",
      rawKey: "oxg_test_secret",
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { name: "My Key", scope: {}, expiresAt: undefined };
    await handler_apiKeyCreate(args);

    expect(mocks.invoke).toHaveBeenCalledWith("create_api_key", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── api.key.revoke ────────────────────────────────────────────────────────────

import handler_apiKeyRevoke, {
  schema as apiKeyRevokeSchema,
  metadata as apiKeyRevokeMetadata,
} from "./api.key.revoke";

describe("api.key.revoke handler", () => {
  it("exports schema and metadata", () => {
    expect(apiKeyRevokeSchema).toBeDefined();
    expect(apiKeyRevokeMetadata.name).toBe("revoke_api_key");
  });

  it("calls invoke with revoke args", async () => {
    const fakeOutput = {
      revoked: true,
      keyPublicId: "aky_test123",
      revokedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { keyPublicId: "aky_test123" };
    await handler_apiKeyRevoke(args);

    expect(mocks.invoke).toHaveBeenCalledWith("revoke_api_key", args, fakeCtx, {
      surface: "mcp",
    });
  });
});

// ── billing.usage.breakdown ──────────────────────────────────────────────────

import handler_billingUsageBreakdown, {
  schema as billingUsageBreakdownSchema,
  metadata as billingUsageBreakdownMetadata,
} from "./billing.usage.breakdown";

describe("billing.usage.breakdown handler", () => {
  it("exports schema and metadata", () => {
    expect(billingUsageBreakdownSchema).toBeDefined();
    expect(billingUsageBreakdownMetadata.name).toBe("get_usage_breakdown");
    expect(billingUsageBreakdownMetadata.annotations?.readOnlyHint).toBe(true);
  });

  it("calls buildContext then invoke with the window args", async () => {
    const fakeOutput = {
      range: {
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
      },
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        costMicros: 0,
        executions: 0,
        messages: 0,
      },
      cacheSavingsMicros: 0,
      series: [],
      byModel: [],
      bySurface: [],
      byWorkspace: [],
      byCapability: [],
      byPrincipal: [],
      byUser: [],
    };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = {
      start: "2026-06-01T00:00:00.000Z",
      end: "2026-07-01T00:00:00.000Z",
      workspaceId: undefined,
    };
    const result = await handler_billingUsageBreakdown(args);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_usage_breakdown",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ totals: { executions: 0 } });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("clickhouse down"));
    await expect(
      handler_billingUsageBreakdown({
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
        workspaceId: undefined,
      }),
    ).rejects.toThrow("clickhouse down");
  });
});
