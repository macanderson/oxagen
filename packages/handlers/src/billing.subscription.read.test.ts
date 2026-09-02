import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// vi.hoisted runs before module resolution, so these refs are safe to use
// inside vi.mock factories (which are also hoisted).
const { subFindFirst, planFindFirst, balanceFindFirst } = vi.hoisted(() => ({
  subFindFirst: vi.fn(),
  planFindFirst: vi.fn().mockResolvedValue({ slug: "pro" }),
  balanceFindFirst: vi.fn().mockResolvedValue({ balanceCents: 0n }),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

// Stub column objects that drizzle's eq/inArray/and will receive without
// blowing up — the findFirst mock ignores the where arg entirely.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const stubCol = { _: {} };
  const fakeDb = {
    query: {
      subscriptions: { findFirst: subFindFirst },
      plans: { findFirst: planFindFirst },
      creditBalances: { findFirst: balanceFindFirst },
    },
  };
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    sumTokenUsage: vi.fn(),
  };
});

vi.mock("./logger", () => ({
  logger: { warn: vi.fn() },
}));

// ── imports after mocks ───────────────────────────────────────────────────────
import { sumTokenUsage } from "@oxagen/telemetry";
import { logger } from "./logger";
import { billingSubscriptionReadHandler } from "./billing.subscription.read";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const mockSumTokenUsage = vi.mocked(sumTokenUsage);
const mockLoggerWarn = vi.mocked(logger.warn);

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const activeSub = {
  publicId: "sub_123",
  status: "active" as const,
  billingInterval: "month" as const,
  currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
  currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  seatCount: 1,
  planId: "plan-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Restore defaults after clearAllMocks() clears return values.
  planFindFirst.mockResolvedValue({ slug: "pro" });
  balanceFindFirst.mockResolvedValue({ balanceCents: 0n });
});

// ── authz guard tests ─────────────────────────────────────────────────────────

describe("billingSubscriptionReadHandler — authorization guards", () => {
  it("throws when no principal is present (no userId and no apiKeyId)", async () => {
    const unauthenticatedCtx: CapabilityContext = {
      ...ctx,
      userId: null,
      apiKeyId: null,
    };
    await expect(
      billingSubscriptionReadHandler({}, unauthenticatedCtx),
    ).rejects.toThrow(/Unauthorized/);
  });

  it("throws when orgId is empty (session-authenticated, unscoped)", async () => {
    const unscopedCtx: CapabilityContext = {
      ...ctx,
      userId: "usr-scoped",
      apiKeyId: null,
      orgId: "",
    };
    await expect(
      billingSubscriptionReadHandler({}, unscopedCtx),
    ).rejects.toThrow(/Forbidden/);
  });

  it("does not throw when authenticated via userId with a valid orgId", async () => {
    subFindFirst.mockResolvedValue(null);
    const result = await billingSubscriptionReadHandler({}, ctx);
    expect(result.subscription).toBeNull();
  });

  it("does not throw when authenticated via apiKeyId with a valid orgId", async () => {
    subFindFirst.mockResolvedValue(null);
    const apiKeyCtx: CapabilityContext = {
      ...ctx,
      userId: null,
      apiKeyId: "aky_abc",
    };
    const result = await billingSubscriptionReadHandler({}, apiKeyCtx);
    expect(result.subscription).toBeNull();
  });
});

// ── ClickHouse failure path ───────────────────────────────────────────────────

describe("billingSubscriptionReadHandler — ClickHouse failure path", () => {
  it("returns periodUsage=null and logs at warn when sumTokenUsage throws", async () => {
    subFindFirst.mockResolvedValue(activeSub);
    mockSumTokenUsage.mockRejectedValue(new Error("CH connection refused"));

    const result = await billingSubscriptionReadHandler({}, ctx);

    expect(result.periodUsage).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledOnce();

    const [bindings, msg] = mockLoggerWarn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(bindings.orgId).toBe("org-1");
    expect(bindings.err).toBeInstanceOf(Error);
    expect(msg).toMatch(/ClickHouse/i);
  });

  it("still returns subscription and balance when CH is down", async () => {
    subFindFirst.mockResolvedValue(activeSub);
    mockSumTokenUsage.mockRejectedValue(new Error("timeout"));

    const result = await billingSubscriptionReadHandler({}, ctx);

    expect(result.subscription).not.toBeNull();
    expect(result.subscription?.status).toBe("active");
    expect(result.creditBalanceCents).toBe(0);
  });

  it("returns periodUsage when CH succeeds", async () => {
    subFindFirst.mockResolvedValue(activeSub);
    mockSumTokenUsage.mockResolvedValue([
      { metric: "tokens_input", quantity: 100, costMicros: 0n },
      { metric: "tokens_output", quantity: 200, costMicros: 0n },
      { metric: "tokens_cached", quantity: 50, costMicros: 0n },
      { metric: "executions", quantity: 10, costMicros: 5000n },
    ]);

    const result = await billingSubscriptionReadHandler({}, ctx);

    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(result.periodUsage).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cachedTokens: 50,
      costMicros: 5000,
      executions: 10,
    });
  });
});
