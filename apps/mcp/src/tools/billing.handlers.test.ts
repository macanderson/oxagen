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

const fakeExtra = {} as Parameters<typeof import("./billing.credits.purchase")["default"]>[1];

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
    expect(billingCreditsPurchaseMetadata.name).toBe("billing.credits.purchase");
  });

  it("calls buildContext then invoke with correct args", async () => {
    const fakeOutput = { credits: 50, charged: 42.5, receiptUrl: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { amountUsd: 50 };
    const result = await handler_billingCreditsPurchase(args, fakeExtra);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "billing.credits.purchase",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ credits: 50 });
  });

  it("propagates invoke errors", async () => {
    mocks.invoke.mockRejectedValue(new Error("payment failed"));
    await expect(
      handler_billingCreditsPurchase({ amountUsd: 10 }, fakeExtra),
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
    expect(billingSubscriptionReadMetadata.name).toBe("billing.subscription.read");
  });

  it("calls invoke with empty args for read", async () => {
    const fakeOutput = { subscription: null };
    mocks.invoke.mockResolvedValue(fakeOutput);

    await handler_billingSubscriptionRead({}, fakeExtra);

    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "billing.subscription.read",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

// ── billing.subscription.upgrade.start ───────────────────────────────────────

import handler_billingSubscriptionUpgradeStart, {
  schema as billingSubscriptionUpgradeStartSchema,
  metadata as billingSubscriptionUpgradeStartMetadata,
} from "./billing.subscription.upgrade.start";

describe("billing.subscription.upgrade.start handler", () => {
  it("exports schema and metadata", () => {
    expect(billingSubscriptionUpgradeStartSchema).toBeDefined();
    expect(billingSubscriptionUpgradeStartMetadata.name).toBe("billing.subscription.upgrade.start");
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
    const result = await handler_billingSubscriptionUpgradeStart(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "billing.subscription.upgrade.start",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result).toMatchObject({ checkoutUrl: "https://checkout.stripe.com/pay/cs_test" });
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
    expect(apiKeyCreateMetadata.name).toBe("api.key.create");
  });

  it("calls invoke with key creation args", async () => {
    const fakeOutput = { publicId: "aky_test", token: "oxg_test_secret" };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { name: "My Key", scope: {}, expiresAt: undefined };
    await handler_apiKeyCreate(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "api.key.create",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
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
    expect(apiKeyRevokeMetadata.name).toBe("api.key.revoke");
  });

  it("calls invoke with revoke args", async () => {
    const fakeOutput = { revoked: true };
    mocks.invoke.mockResolvedValue(fakeOutput);

    const args = { keyPublicId: "aky_test123" };
    await handler_apiKeyRevoke(args, fakeExtra);

    expect(mocks.invoke).toHaveBeenCalledWith(
      "api.key.revoke",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
