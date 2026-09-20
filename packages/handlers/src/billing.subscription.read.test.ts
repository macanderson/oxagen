import { beforeEach, describe, expect, it, vi } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// vi.hoisted runs before module resolution, so these refs are safe to use
// inside vi.mock factories (which are also hoisted).
const { subFindFirst, planFindFirst, balanceFindFirst, liveBalance, tenant } =
  vi.hoisted(() => ({
    subFindFirst: vi.fn(),
    planFindFirst: vi.fn().mockResolvedValue({ slug: "pro" }),
    balanceFindFirst: vi.fn().mockResolvedValue({ balanceCents: 0n }),
    liveBalance: vi.fn().mockResolvedValue(0n),
    /** The actor's org principal and role, as assertOrgRole reads them. */
    tenant: {
      principalId: "prn_1" as string | null,
      roleName: "Owner" as string | null,
      /** The creator an API key resolves to, or none. */
      keyCreator: "u-creator" as string | null,
    },
  }));

// ── module mocks ──────────────────────────────────────────────────────────────

// The findFirst mocks ignore the where arg entirely. The select chain answers
// by table for the role gate's two reads (principals, then role assignments),
// so the test does not depend on the order they are issued in.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === real.schema.apiKeys)
      return tenant.keyCreator ? [{ createdById: tenant.keyCreator }] : [];
    if (table === real.schema.principals)
      return tenant.principalId ? [{ id: tenant.principalId }] : [];
    if (table === real.schema.principalRoleAssignments)
      return tenant.roleName ? [{ roleName: tenant.roleName }] : [];
    throw new Error("unexpected table");
  };
  const fakeDb = {
    query: {
      subscriptions: { findFirst: subFindFirst },
      plans: { findFirst: planFindFirst },
      creditBalances: { findFirst: balanceFindFirst },
    },
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/billing", () => ({ effectiveBalance: liveBalance }));

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
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";

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
  liveBalance.mockResolvedValue(0n);
  tenant.principalId = "prn_1";
  tenant.roleName = "Owner";
  tenant.keyCreator = "u-creator";
});

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

// ── authz guard tests ─────────────────────────────────────────────────────────
// The org is tier-free in every case: the kernel's IAM check allows every
// capability there, so the refusals below come from the handler alone
// (ARCHITECTURE.md §3.2, INV-29).

describe("billingSubscriptionReadHandler — authorization guards", () => {
  it("refuses a context with no signed-in user (no userId and no apiKeyId) as forbidden", async () => {
    const unauthenticatedCtx: CapabilityContext = {
      ...ctx,
      userId: null,
      apiKeyId: null,
    };
    await expect(
      billingSubscriptionReadHandler({}, unauthenticatedCtx),
    ).rejects.toSatisfy(forbidden);
    expect(subFindFirst).not.toHaveBeenCalled();
  });

  describe("an API-key call acts as the key's creator", () => {
    const apiKeyCtx: CapabilityContext = {
      ...ctx,
      userId: null,
      apiKeyId: "aky_abc",
      surface: "mcp",
    };
    const refused = (reason: string) => (e: unknown) =>
      forbidden(e) && isHandlerError(e) && e.reason === reason;

    it("reads the subscription for a creator who is an org Owner", async () => {
      subFindFirst.mockResolvedValue(null);
      const result = await billingSubscriptionReadHandler({}, apiKeyCtx);
      expect(result.subscription).toBeNull();
      expect(subFindFirst).toHaveBeenCalledOnce();
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      tenant.roleName = "Member";
      await expect(
        billingSubscriptionReadHandler({}, apiKeyCtx),
      ).rejects.toSatisfy(refused("org_role_required"));
      expect(subFindFirst).not.toHaveBeenCalled();
    });

    it("refuses a key with no creator (negative)", async () => {
      tenant.keyCreator = null;
      await expect(
        billingSubscriptionReadHandler({}, apiKeyCtx),
      ).rejects.toSatisfy(refused("no_principal"));
      expect(subFindFirst).not.toHaveBeenCalled();
    });
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

  it("refuses a user with no principal in the org", async () => {
    tenant.principalId = null;
    tenant.roleName = null;
    await expect(billingSubscriptionReadHandler({}, ctx)).rejects.toSatisfy(
      forbidden,
    );
    expect(subFindFirst).not.toHaveBeenCalled();
  });

  it.each(["Member", "Viewer", "Compliance"])(
    "refuses an org %s and reads nothing",
    async (roleName) => {
      tenant.roleName = roleName;
      await expect(billingSubscriptionReadHandler({}, ctx)).rejects.toSatisfy(
        forbidden,
      );
      expect(subFindFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["Owner", "Admin", "Billing"])(
    "an org %s reads the subscription",
    async (roleName) => {
      tenant.roleName = roleName;
      subFindFirst.mockResolvedValue(null);
      const result = await billingSubscriptionReadHandler({}, ctx);
      expect(result.subscription).toBeNull();
    },
  );
});

// ── INV-27: reading the bill is never refused for lack of GAUs ───────────────

describe("billingSubscriptionReadHandler — a prepaid org with remaining = 0", () => {
  it("still reads its subscription: the contract is noBillingGate and the handler consults no bucket", async () => {
    // The kernel skips the admission gate for a noBillingGate contract, so
    // an org whose month bucket is at remaining = 0 reaches the handler; the
    // handler itself reads the subscription and the balance only.
    expect(billingSubscriptionRead.noBillingGate).toBe(true);
    subFindFirst.mockResolvedValue(activeSub);
    mockSumTokenUsage.mockResolvedValue([]);
    const result = await billingSubscriptionReadHandler({}, ctx);
    expect(result.subscription?.status).toBe("active");
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

describe("live credit display", () => {
  it("returns live-lot credit even when the cached mirror is higher", async () => {
    subFindFirst.mockResolvedValue(null);
    balanceFindFirst.mockResolvedValue({ balanceCents: 999n });
    liveBalance.mockResolvedValue(50n);
    const result = await billingSubscriptionReadHandler({}, ctx);
    expect(result.creditBalanceCents).toBe(50);
    expect(liveBalance).toHaveBeenCalledWith(ctx.orgId);
    expect(balanceFindFirst).not.toHaveBeenCalled();
  });

  it("does not substitute the stale mirror when the authoritative read fails", async () => {
    subFindFirst.mockResolvedValue(null);
    liveBalance.mockRejectedValueOnce(new Error("lot store unavailable"));
    await expect(billingSubscriptionReadHandler({}, ctx)).rejects.toThrow(
      "lot store unavailable",
    );
    expect(balanceFindFirst).not.toHaveBeenCalled();
  });
});
