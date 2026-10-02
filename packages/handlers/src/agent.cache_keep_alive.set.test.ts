import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentCacheKeepAliveSet } from "@oxagen/oxagen/contracts/agent.cache_keep_alive.set";
import { agentCacheKeepAliveSetHandler } from "./agent.cache_keep_alive.set";
import { makeTx, type TxDouble } from "./cost_center.test-support";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is the SAME function as the tenant seam (ADR-086), so a
  // suite that counts seam calls sees one identity.
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});

// The org-role gate (INV-29). Allows by default, an org Admin, so each case
// tests its own behaviour. The refusal case sets `roleGate.refuse`.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
}));

function useTx(double: TxDouble) {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(double.tx),
  );
}

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

describe("set_agent_cache_keep_alive", () => {
  it("refuses a member outside Owner and Admin before touching a row", async () => {
    roleGate.refuse = true;
    await expect(
      agentCacheKeepAliveSetHandler(
        { agent: "release-bot", cacheKeepAlive: false },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: CTX.orgId, userId: CTX.userId }),
      { org: ["Owner", "Admin"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("turns the keep-alive off for the agent the slug names in this workspace", async () => {
    const double = makeTx({ updates: [[{ id: "agt_releasebot" }]] });
    useTx(double);
    const out = await agentCacheKeepAliveSetHandler(
      { agent: "release-bot", cacheKeepAlive: false },
      CTX,
    );
    expect(double.calls.updates).toHaveLength(1);
    expect(double.calls.updates[0]?.table).toBe(schema.agents);
    expect(double.calls.updates[0]?.values).toMatchObject({
      cacheKeepAlive: false,
      updatedById: CTX.userId,
    });
    expect(double.calls.updates[0]?.values.updatedAt).toBeInstanceOf(Date);
    // Matched on the org, the workspace and the slug, and never a deleted row.
    const where = new PgDialect().sqlToQuery(
      double.calls.updates[0]?.where as SQL,
    );
    expect(where.params).toEqual([CTX.orgId, CTX.workspaceId, "release-bot"]);
    expect(where.sql).toContain('"deleted_at" is null');
    expect(agentCacheKeepAliveSet.output.parse(out)).toEqual({
      agentId: "agt_releasebot",
      cacheKeepAlive: false,
    });
  });

  it("turns the keep-alive back on", async () => {
    const double = makeTx({ updates: [[{ id: "agt_releasebot" }]] });
    useTx(double);
    const out = await agentCacheKeepAliveSetHandler(
      { agent: "release-bot", cacheKeepAlive: true },
      CTX,
    );
    expect(double.calls.updates[0]?.values).toMatchObject({
      cacheKeepAlive: true,
    });
    expect(out).toEqual({ agentId: "agt_releasebot", cacheKeepAlive: true });
  });

  it("answers not_found for an agent slug the workspace does not have (negative)", async () => {
    const double = makeTx({ updates: [[]] });
    useTx(double);
    await expect(
      agentCacheKeepAliveSetHandler(
        { agent: "ghost", cacheKeepAlive: false },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "agent_not_found" });
  });

  it("refuses the org-only sentinel before touching a row (negative)", async () => {
    await expect(
      agentCacheKeepAliveSetHandler(
        { agent: "release-bot", cacheKeepAlive: false },
        { ...CTX, workspaceId: ORG_ONLY_WORKSPACE_ID },
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_required",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
