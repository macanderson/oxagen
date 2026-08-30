/**
 * Unit tests for billing route handlers:
 *   billing.credits.purchase, billing.subscription.read,
 *   billing.subscription.upgrade.start
 *
 * Also covers api.key.create and api.key.revoke (billing/org admin surface).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

const BASE = "/v1/test-org/test-ws";

function authHeaders() {
  return { authorization: bearerHeader("oxk_key") };
}

function post(path: string, body: unknown): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string): Request {
  return makeRequest(`${BASE}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue({ ok: true });
});

// ── billing.subscription.read ─────────────────────────────────────────────

describe("billing.subscription.read route", () => {
  const PATH = "/billing/subscription";

  it("happy path GET: 200 with subscription", async () => {
    const invokeResult = {
      subscription: null,
      creditBalanceCents: 500,
      periodUsage: {},
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(get(PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'get_subscription' and empty input", async () => {
    await app.fetch(get(PATH));
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("get_subscription");
    expect(mocks.invoke.mock.calls[0]?.[1]).toEqual({});
    expect(mocks.invoke.mock.calls[0]?.[3]).toEqual({ surface: "api" });
  });
});

// ── billing.subscription.upgrade.start ────────────────────────────────────

describe("billing.subscription.upgrade.start route", () => {
  const PATH = "/billing/subscription/upgrade/start";
  const VALID_BODY = {
    planSlug: "build",
    interval: "month",
    successUrl: "https://app.example.com/billing?success=1",
    cancelUrl: "https://app.example.com/billing?cancel=1",
  };

  it("happy path: 200 with checkout URL", async () => {
    const invokeResult = {
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test_123",
      planSlug: "build",
      interval: "month",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, VALID_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'start_subscription_upgrade'", async () => {
    await app.fetch(post(PATH, VALID_BODY));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("start_subscription_upgrade");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.planSlug).toBe("build");
    expect(body.interval).toBe("month");
  });

  it("invalid interval → 400", async () => {
    const res = await app.fetch(
      post(PATH, { ...VALID_BODY, interval: "weekly" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("missing successUrl → 400", async () => {
    const { successUrl: _omitted, ...rest } = VALID_BODY;
    const res = await app.fetch(post(PATH, rest));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── billing.credits.purchase ──────────────────────────────────────────────

describe("billing.credits.purchase route", () => {
  const PATH = "/billing/credits/purchase";

  it("happy path: 200 with checkout URL", async () => {
    const invokeResult = { checkoutUrl: "https://stripe.com/pay/cs_abc" };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { amountUsd: 50 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'purchase_credits' and amountUsd", async () => {
    await app.fetch(post(PATH, { amountUsd: 20 }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("purchase_credits");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.amountUsd).toBe(20);
  });

  it("amountUsd below minimum → 400", async () => {
    // Schema: min(5)
    const res = await app.fetch(post(PATH, { amountUsd: 2 }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("negative amountUsd → 400", async () => {
    const res = await app.fetch(post(PATH, { amountUsd: -10 }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── api.key.create ────────────────────────────────────────────────────────

describe("api.key.create route", () => {
  const PATH = "/api-keys";

  it("happy path: 201 with key", async () => {
    const invokeResult = {
      publicId: "aky_abc",
      rawKey: "oxk_abc123",
      name: "CI key",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(post(PATH, { name: "CI key" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'create_api_key'", async () => {
    await app.fetch(post(PATH, { name: "My Key" }));
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("create_api_key");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.name).toBe("My Key");
  });

  it("empty name → 400", async () => {
    const res = await app.fetch(post(PATH, { name: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── api.key.revoke ────────────────────────────────────────────────────────

describe("api.key.revoke route", () => {
  const PATH = "/api-keys/revoke";

  it("happy path DELETE: 200 with revoked result", async () => {
    const invokeResult = {
      revoked: true,
      keyPublicId: "aky_abc",
      revokedAt: "2024-01-01T00:00:00Z",
    };
    mocks.invoke.mockResolvedValue(invokeResult);

    const res = await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ keyPublicId: "aky_abc" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(invokeResult);
  });

  it("calls invoke with 'revoke_api_key'", async () => {
    await app.fetch(
      makeRequest(`${BASE}${PATH}`, {
        method: "DELETE",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ keyPublicId: "aky_xyz" }),
      }),
    );
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("revoke_api_key");
    const body = mocks.invoke.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.keyPublicId).toBe("aky_xyz");
  });
});
