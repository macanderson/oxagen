// archive_workspace: the role gate, the refusals and the guarded write.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const { tenant, db, emitted } = vi.hoisted(() => ({
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
    /** The creator an API key resolves to, or none. */
    keyCreator: "00000000-0000-0000-0000-00000000000e" as string | null,
  },
  db: {
    /** The workspace row the select answers, or none. */
    workspace: null as Record<string, unknown> | null,
    /** How many registered agents the count answers. */
    agentCount: 0,
    /** The agent count's WHERE, rendered with its params. */
    agentQueries: [] as Array<{ sql: string; params: unknown[] }>,
    /** How many live API keys the count answers. */
    liveApiKeyCount: 0,
    /** The live-key count's WHERE, rendered with its params. */
    apiKeyQueries: [] as Array<{ sql: string; params: unknown[] }>,
    /** The workspace id of the tenant scope each transaction opened in. */
    scopes: [] as Array<string | undefined>,
    /** The tenant scope the write ran in. */
    writeScope: undefined as string | undefined,
    updates: [] as Array<Record<string, unknown>>,
    /** The workspace update's WHERE, rendered with its params. */
    updateQueries: [] as Array<{ sql: string; params: unknown[] }>,
    /** Whether the update's WHERE matches a row: false when a concurrent archive landed first. */
    updateMatches: true,
  },
  emitted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const { getScope } = await import("@oxagen/tenancy");
  const dialect = new PgDialect();
  // `auth.api_keys` is read twice with different projections: the role gate
  // asks who created the calling key, and the archival asks how many live keys
  // the workspace holds. The selected fields tell them apart.
  const rowsFor = (
    table: unknown,
    fields?: Record<string, unknown>,
  ): unknown[] => {
    if (table === real.schema.apiKeys) {
      if (fields && "n" in fields) return [{ n: db.liveApiKeyCount }];
      return tenant.keyCreator ? [{ createdById: tenant.keyCreator }] : [];
    }
    if (table === real.schema.principals)
      return tenant.principalId ? [{ id: tenant.principalId }] : [];
    if (table === real.schema.principalRoleAssignments)
      return tenant.roleName ? [{ roleName: tenant.roleName }] : [];
    if (table === real.schema.workspaces)
      return db.workspace ? [db.workspace] : [];
    if (table === real.schema.agents) return [{ n: db.agentCount }];
    throw new Error("unexpected table");
  };
  const fakeDb = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: (cond: SQL) => {
            if (table === real.schema.agents)
              db.agentQueries.push(dialect.sqlToQuery(cond));
            if (table === real.schema.apiKeys && fields && "n" in fields)
              db.apiKeyQueries.push(dialect.sqlToQuery(cond));
            const withFor = Object.assign(
              Promise.resolve(rowsFor(table, fields)),
              chain,
            );
            // `.for("update")` is a lock hint Postgres applies to the same
            // row set; the fake has no locking to model, so it just resolves
            // to the same rows the unlocked select would.
            return Object.assign(withFor, {
              for: () => Promise.resolve(rowsFor(table, fields)),
            });
          },
          limit: () => Promise.resolve(rowsFor(table, fields)),
        };
        return chain;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond: SQL) => ({
          returning: async () => {
            db.updateQueries.push(dialect.sqlToQuery(cond));
            db.writeScope = getScope()?.workspaceId;
            if (!db.updateMatches) return [];
            db.updates.push(values);
            return [{ id: "written" }];
          },
        }),
      }),
    }),
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      db.scopes.push(getScope()?.workspaceId);
      return fn(fakeDb);
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: vi.fn(async (e: Record<string, unknown>) => {
    emitted.push(e);
  }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { workspaceArchiveHandler } from "./workspace.archive";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-00000000000a",
  workspaceId: "00000000-0000-0000-0000-00000000000b",
  userId: "00000000-0000-0000-0000-00000000000c",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

const ACTIVE = {
  id: "00000000-0000-0000-0000-0000000000f1",
  publicId: "wrk_core",
  slug: "core",
  name: "Core",
  archivedAt: null,
};

const run = (workspaceId = "wrk_core", c = ctx) =>
  workspaceArchiveHandler(workspaceArchive.input.parse({ workspaceId }), c);

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  if (!isHandlerError(err))
    throw new Error(`expected a HandlerError, got ${err}`);
  return { code: err.code, reason: err.reason };
};

beforeEach(() => {
  tenant.principalId = "prn_1";
  tenant.roleName = "Owner";
  tenant.keyCreator = "00000000-0000-0000-0000-00000000000e";
  db.workspace = { ...ACTIVE };
  db.agentCount = 0;
  db.agentQueries.length = 0;
  db.liveApiKeyCount = 0;
  db.apiKeyQueries.length = 0;
  db.scopes.length = 0;
  db.writeScope = undefined;
  db.updates.length = 0;
  db.updateQueries.length = 0;
  db.updateMatches = true;
  emitted.length = 0;
});

describe("archive_workspace", () => {
  it("writes archived_at and archived_by together, answers with the row, and records the security event", async () => {
    const out = await run();
    expect(out).toMatchObject({ id: "wrk_core", slug: "core", name: "Core" });
    expect(workspaceArchive.output.safeParse(out).success).toBe(true);
    expect(db.updates).toHaveLength(1);
    const write = db.updates[0]!;
    expect(write.archivedAt).toBeInstanceOf(Date);
    expect(write.archivedByUserId).toBe(ctx.userId);
    expect(out.archivedAt).toBe((write.archivedAt as Date).toISOString());
    expect(emitted).toEqual([
      expect.objectContaining({
        eventType: "workspace.archived",
        actorUserId: ctx.userId,
        orgId: ctx.orgId,
        workspaceId: ACTIVE.id,
        capability: "archive_workspace",
        outcome: "success",
      }),
    ]);
  });

  it("lets an org Admin archive", async () => {
    tenant.roleName = "Admin";
    await expect(run()).resolves.toMatchObject({ id: "wrk_core" });
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required and writes nothing (negative)",
    async (roleName) => {
      tenant.roleName = roleName;
      await expect(refusal(run())).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(db.updates).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    },
  );

  it("refuses a context with no user (negative)", async () => {
    await expect(
      refusal(run("wrk_core", { ...ctx, userId: null })),
    ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
  });

  describe("an MCP call: an API key and no signed-in user", () => {
    const keyCtx: CapabilityContext = {
      ...ctx,
      userId: null,
      apiKeyId: "00000000-0000-0000-0000-00000000000d",
      surface: "mcp",
    };

    it("archives as the key's creator when the creator is an org Owner", async () => {
      await expect(run("wrk_core", keyCtx)).resolves.toMatchObject({
        id: "wrk_core",
      });
      expect(db.updates[0]?.archivedByUserId).toBe(tenant.keyCreator);
      expect(emitted[0]?.actorUserId).toBe(tenant.keyCreator);
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      tenant.roleName = "Member";
      await expect(refusal(run("wrk_core", keyCtx))).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(db.updates).toHaveLength(0);
    });

    it("refuses a key that resolves to no creator (negative)", async () => {
      tenant.keyCreator = null;
      await expect(refusal(run("wrk_core", keyCtx))).resolves.toEqual({
        code: "forbidden",
        reason: "no_principal",
      });
    });
  });

  it("refuses a workspace outside the org with not_found (negative)", async () => {
    db.workspace = null;
    await expect(refusal(run("wrk_elsewhere"))).resolves.toEqual({
      code: "not_found",
      reason: "workspace_not_found",
    });
    expect(db.updates).toHaveLength(0);
  });

  it("counts the target workspace's registered agents in that workspace's tenant scope, leaving out archived, deleted and the seeded qa-chat agent", async () => {
    await run();
    expect(db.agentQueries).toHaveLength(1);
    const { sql, params } = db.agentQueries[0]!;
    expect(sql).toMatch(/"agents"\."org_id" = \$1/);
    expect(sql).toMatch(/"agents"\."workspace_id" = \$2/);
    expect(sql).toMatch(/"agents"\."status" <> \$3/);
    expect(sql).toMatch(/"agents"\."slug" <> \$4/);
    expect(sql).toMatch(/"agents"\."deleted_at" is null/);
    expect(params).toEqual([ctx.orgId, ACTIVE.id, "archived", "qa-chat"]);
    expect(db.writeScope).toBe(ACTIVE.id);
  });

  it("refuses a workspace with registered agents with conflict / workspace_has_agents and writes nothing (negative)", async () => {
    db.agentCount = 2;
    const err = await run().catch((e) => e);
    expect(isHandlerError(err) && err.code).toBe("conflict");
    expect(isHandlerError(err) && err.reason).toBe("workspace_has_agents");
    expect(String(err.message)).toContain("Core has 2 registered agent(s)");
    expect(db.updates).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("writes only a row still unarchived", async () => {
    await run();
    expect(db.updateQueries).toHaveLength(1);
    const { sql, params } = db.updateQueries[0]!;
    expect(sql).toMatch(/"workspaces"\."id" = \$1/);
    expect(sql).toMatch(/"workspaces"\."archived_at" is null/);
    expect(params).toEqual([ACTIVE.id]);
  });

  it("refuses with conflict / already_archived when a concurrent archive changed the row first, and records no security event (negative)", async () => {
    db.updateMatches = false;
    await expect(refusal(run())).resolves.toEqual({
      code: "conflict",
      reason: "already_archived",
    });
    expect(db.updates).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("refuses a workspace already archived with conflict / already_archived (negative)", async () => {
    db.workspace = { ...ACTIVE, archivedAt: new Date("2026-09-01T00:00:00Z") };
    const err = await run().catch((e) => e);
    expect(isHandlerError(err) && err.code).toBe("conflict");
    expect(isHandlerError(err) && err.reason).toBe("already_archived");
    expect(String(err.message)).toContain("2026-09-01");
    expect(db.updates).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  // ADR-104: archival suspends the workspace's API keys and reports how many.

  it("reports no suspended keys for a workspace that holds none", async () => {
    const out = await run();
    expect(out.suspendedApiKeys).toBe(0);
  });

  it("reports the workspace's live keys, which stop authenticating, and revokes none of them", async () => {
    db.liveApiKeyCount = 3;
    const out = await run();
    expect(out.suspendedApiKeys).toBe(3);
    // One write, and it is the workspace row. No key row is touched.
    expect(db.updates).toHaveLength(1);
    expect(Object.keys(db.updates[0]!)).toEqual([
      "archivedAt",
      "archivedByUserId",
      "updatedAt",
      "updatedById",
    ]);
  });

  it("counts only keys that could still authenticate, in the workspace's tenant scope", async () => {
    // A revoked (soft-deleted) or already-expired key is dead already, so it
    // is not something this call took out of service.
    await run();
    expect(db.apiKeyQueries).toHaveLength(1);
    const { sql, params } = db.apiKeyQueries[0]!;
    expect(sql).toMatch(/"api_keys"\."org_id" = \$1/);
    expect(sql).toMatch(/"api_keys"\."workspace_id" = \$2/);
    expect(sql).toMatch(/"api_keys"\."deleted_at" is null/);
    expect(sql).toMatch(/"api_keys"\."expires_at" is null/);
    expect(sql).toMatch(/"api_keys"\."expires_at" > \$3/);
    expect(params.slice(0, 2)).toEqual([ctx.orgId, ACTIVE.id]);
    // The same instant the row is stamped with, so the count is the set of
    // keys live at the moment of archival.
    expect(String(params[2])).toBe(
      (db.updates[0]!.archivedAt as Date).toISOString(),
    );
  });

  it("counts no keys when the archival is refused (negative)", async () => {
    db.agentCount = 1;
    db.liveApiKeyCount = 5;
    await expect(refusal(run())).resolves.toMatchObject({
      reason: "workspace_has_agents",
    });
    expect(db.apiKeyQueries).toHaveLength(0);
  });
});
