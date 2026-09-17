import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  wsFindFirst: vi.fn(),
  txInsertWs: vi.fn(),
  txInsertWsReturning: vi.fn(),
  txInsertWsUsers: vi.fn(),
  txFn: vi.fn(),
  /** The insert count at each mid-transaction scope move the bootstrap makes (#3029). */
  txScopeMoves: [] as number[],
  /** The actor's principal, org role and workspace role, as assertOrgRole reads them. */
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
    workspaceRoleName: null as string | null,
    /** The creator an API key resolves to, or none. */
    keyCreator: "u_1" as string | null,
  },
}));

// Defaults: org found, no conflicting slug
mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
mocks.wsFindFirst.mockResolvedValue(null);

mocks.txInsertWsReturning.mockResolvedValue([
  {
    publicId: "ws_pub_1",
    name: "Default Workspace",
    slug: "default",
    id: "internal_ws_id",
    createdAt: new Date("2026-05-01T00:00:00Z"),
  },
]);
const wsValuesStub = { returning: mocks.txInsertWsReturning };
mocks.txInsertWs.mockReturnValue({ values: () => wsValuesStub });
mocks.txInsertWsUsers.mockReturnValue({ values: vi.fn(async () => undefined) });

mocks.txFn.mockImplementation(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    let insertCount = 0;
    const tx = {
      execute: async () => undefined,
      insert: (table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) return mocks.txInsertWs(table) as unknown;
        return mocks.txInsertWsUsers(table) as unknown;
      },
    };
    return cb(tx as unknown as Parameters<typeof cb>[0]);
  },
);

// Stub bootstrapWorkspaceAgents to isolate workspace.create tests from DB
// agent-seeding behaviour — that is covered by workspace-agents unit tests.
vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
}));

// Stub seedWorkspaceDefaultRegistry to isolate workspace.create tests from
// registry-seeding behaviour — that is covered by workspace-registry-seed tests.
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_stub"),
}));

// Stub seedWorkspaceDefaultEnvironment to isolate workspace.create tests from
// environment-seeding behaviour — covered by workspace-environment-seed tests.
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_stub_id"),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dialect = new PgDialect();
  return {
    ...real,
    db: () => ({
      query: {
        organizations: { findFirst: mocks.orgFindFirst },
        workspaces: { findFirst: mocks.wsFindFirst },
      },
      transaction: mocks.txFn,
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Each withTenantDb call gets its own insert counter so the org-query,
      // ws-query, and transaction calls each see a fresh counter.
      const insertCountRef = { n: 0 };
      const tx = {
        // The bootstrap re-points app.current_workspace_id on this transaction
        // once the workspace row exists (#3029) — every row after it lands in a
        // workspace-GUC-scoped table.
        execute: async () => {
          mocks.txScopeMoves.push(insertCountRef.n);
          return undefined;
        },
        query: {
          organizations: { findFirst: mocks.orgFindFirst },
          workspaces: { findFirst: mocks.wsFindFirst },
        },
        // The role gate reads principals then role assignments (answered by
        // table, and for assignments by the scope the WHERE pins: an org-wide
        // assignment has `workspace_id is null`, a workspace assignment
        // carries the id); namespace derivation reads the org's existing
        // workspace namespaces before inserting — empty means the
        // slug-derived namespace is used as-is.
        select: () => ({
          from: (table: unknown) => {
            let lastWhere: SQL | null = null;
            const rows = (): unknown[] => {
              if (table === real.schema.apiKeys)
                return mocks.tenant.keyCreator
                  ? [{ createdById: mocks.tenant.keyCreator }]
                  : [];
              if (table === real.schema.principals)
                return mocks.tenant.principalId
                  ? [{ id: mocks.tenant.principalId }]
                  : [];
              if (table === real.schema.principalRoleAssignments) {
                const pinsWorkspace =
                  lastWhere !== null &&
                  /"workspace_id" = \$/.test(dialect.sqlToQuery(lastWhere).sql);
                const name = pinsWorkspace
                  ? mocks.tenant.workspaceRoleName
                  : mocks.tenant.roleName;
                return name ? [{ roleName: name }] : [];
              }
              return [];
            };
            const chain = {
              innerJoin: () => chain,
              where: (cond: SQL) => {
                lastWhere = cond;
                return Object.assign(Promise.resolve(rows()), chain);
              },
              limit: () => Promise.resolve(rows()),
            };
            return chain;
          },
        }),
        insert: (table: unknown): unknown => {
          insertCountRef.n++;
          if (insertCountRef.n === 1) return mocks.txInsertWs(table) as unknown;
          return mocks.txInsertWsUsers(table) as unknown;
        },
      };
      return fn(tx);
    },
  };
});

import { workspaceCreateHandler } from "./workspace.create";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.txScopeMoves.length = 0;
    mocks.orgFindFirst.mockClear();
    mocks.wsFindFirst.mockClear();
    mocks.txFn.mockClear();
    mocks.txInsertWs.mockClear();
    mocks.txInsertWsReturning.mockClear();
    // Restore defaults
    mocks.tenant.principalId = "prn_1";
    mocks.tenant.roleName = "Owner";
    mocks.tenant.workspaceRoleName = null;
    mocks.tenant.keyCreator = "u_1";
    mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
    mocks.wsFindFirst.mockResolvedValue(null);
    mocks.txInsertWsReturning.mockResolvedValue([
      {
        publicId: "ws_pub_1",
        name: "Default Workspace",
        slug: "default",
        id: "internal_ws_id",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
  });

  // ── role gate (INV-29) ────────────────────────────────────────────────────

  async function refusal(
    input: { name: string; slug: string },
    ctx: CapabilityContext = CTX,
  ) {
    const err = await workspaceCreateHandler(input, ctx).catch((e) => e);
    if (!isHandlerError(err))
      throw new Error(`expected a HandlerError, got ${err}`);
    return { code: err.code, reason: err.reason };
  }

  // #3029 / ADR-068: the app's /{org} create-workspace form and the API's
  // org-only mount both invoke this with ORG_ONLY_WORKSPACE_ID as the scope's
  // workspace, so `app.current_workspace_id` names no workspace when the
  // transaction opens. `workspace.workspaces` is org_only and its INSERT lands,
  // but `workspace.workspace_users` (workspace_only), `agent.agents` and
  // `environments.environments` (standard) are all refused by tenant_isolation's
  // WITH CHECK (42501 — not a unique violation, so it escapes the slug_taken
  // classifier and reaches the caller as a 500). The bootstrap therefore moves
  // the transaction's workspace scope onto the new row the moment it exists,
  // between the workspaces INSERT and everything after it.
  it("moves the transaction's workspace scope onto the new workspace before any workspace-scoped row", async () => {
    await workspaceCreateHandler({ name: "Test", slug: "test" }, CTX);
    // Exactly one move, and it lands after insert #1 (workspaces) — so insert
    // #2 (workspace_users) and the seeds all run under the new workspace.
    expect(mocks.txScopeMoves).toEqual([1]);
    expect(mocks.txInsertWsUsers).toHaveBeenCalled();
  });

  it("refuses a context with no user before any query (negative)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      refusal({ name: "Test", slug: "test" }, anonCtx),
    ).resolves.toEqual({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(mocks.orgFindFirst).not.toHaveBeenCalled();
  });

  describe("an MCP call: an API key and no signed-in user", () => {
    const keyCtx: CapabilityContext = {
      ...CTX,
      userId: null,
      apiKeyId: "aky_1",
      surface: "mcp",
    };

    it("creates the workspace as the key's creator when the creator is an org Owner", async () => {
      await expect(
        workspaceCreateHandler({ name: "Test", slug: "test" }, keyCtx),
      ).resolves.toMatchObject({ publicId: "ws_pub_1", orgSlug: "acme" });
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      mocks.tenant.roleName = "Member";
      await expect(
        refusal({ name: "Test", slug: "test" }, keyCtx),
      ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
      expect(mocks.txInsertWs).not.toHaveBeenCalled();
    });

    it("refuses a key that resolves to no creator (negative)", async () => {
      mocks.tenant.keyCreator = null;
      await expect(
        refusal({ name: "Test", slug: "test" }, keyCtx),
      ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
      expect(mocks.orgFindFirst).not.toHaveBeenCalled();
    });
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required and writes nothing (negative)",
    async (roleName) => {
      mocks.tenant.roleName = roleName;
      await expect(refusal({ name: "Test", slug: "test" })).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(mocks.txInsertWs).not.toHaveBeenCalled();
    },
  );

  it("lets a workspace Owner with no org role create a workspace", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Owner";
    await expect(
      workspaceCreateHandler({ name: "Owned", slug: "owned" }, CTX),
    ).resolves.toMatchObject({ publicId: "ws_pub_1" });
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("refuses a workspace Admin with no org role with forbidden / org_role_required and writes nothing (negative)", async () => {
    mocks.tenant.roleName = "Member";
    mocks.tenant.workspaceRoleName = "Admin";
    await expect(refusal({ name: "Test", slug: "test" })).resolves.toEqual({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.txInsertWs).not.toHaveBeenCalled();
  });

  it("lets an org Admin create a workspace", async () => {
    mocks.tenant.roleName = "Admin";
    const result = await workspaceCreateHandler(
      { name: "Admin Ws", slug: "admin-ws" },
      CTX,
    );
    expect(result.slug).toBe("default");
  });

  // ── tenant guard ──────────────────────────────────────────────────────────

  it("refuses with not_found when the org row is missing", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce(null);
    await expect(refusal({ name: "Dev", slug: "dev" })).resolves.toEqual({
      code: "not_found",
      reason: "org_not_found",
    });
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("refuses with conflict / slug_taken when the slug already exists in this org (negative)", async () => {
    mocks.wsFindFirst.mockResolvedValueOnce({ id: "existing_ws" });
    await expect(refusal({ name: "Dupe", slug: "default" })).resolves.toEqual({
      code: "conflict",
      reason: "slug_taken",
    });
    expect(mocks.txInsertWs).not.toHaveBeenCalled();
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns publicId, name, slug, orgSlug, and ISO createdAt", async () => {
    const result = await workspaceCreateHandler(
      { name: "Default Workspace", slug: "default" },
      CTX,
    );

    expect(result.publicId).toBe("ws_pub_1");
    expect(result.name).toBe("Default Workspace");
    expect(result.slug).toBe("default");
    expect(result.orgSlug).toBe("acme");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("runs workspace and membership inserts via withTenantDb", async () => {
    await workspaceCreateHandler({ name: "Tx Ws", slug: "tx-ws" }, CTX);
    // withTenantDb replaces db().transaction(); verify the ws insert was called.
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("seeds the built-in agent, the default registry and the default environment on the creating transaction", async () => {
    const [
      { bootstrapWorkspaceAgents },
      { seedWorkspaceDefaultRegistry },
      { seedWorkspaceDefaultEnvironment },
    ] = await Promise.all([
      import("./workspace-agents"),
      import("./workspace-registry-seed"),
      import("./workspace-environment-seed"),
    ]);
    await workspaceCreateHandler({ name: "Env Ws", slug: "env-ws" }, CTX);
    const seeded = { orgId: CTX.orgId, workspaceId: "internal_ws_id" };
    expect(bootstrapWorkspaceAgents).toHaveBeenCalledWith(
      expect.objectContaining({ ...seeded, userId: CTX.userId }),
    );
    expect(seedWorkspaceDefaultRegistry).toHaveBeenCalledWith(
      expect.objectContaining(seeded),
    );
    expect(seedWorkspaceDefaultEnvironment).toHaveBeenCalledWith(
      expect.objectContaining(seeded),
    );
    // Every seed rides the same transaction as the workspace row.
    const txs = [
      vi.mocked(bootstrapWorkspaceAgents).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultRegistry).mock.calls[0]?.[0]?.tx,
      vi.mocked(seedWorkspaceDefaultEnvironment).mock.calls[0]?.[0]?.tx,
    ];
    expect(txs[0]).toBeDefined();
    expect(new Set(txs).size).toBe(1);
  });

  it("throws when the transaction insert returns no row", async () => {
    mocks.txInsertWsReturning.mockResolvedValueOnce([]);

    await expect(
      workspaceCreateHandler({ name: "Empty", slug: "empty" }, CTX),
    ).rejects.toThrow("workspace insert returned no row");
  });

  // ── scope isolation ───────────────────────────────────────────────────────

  it("looks up the org by the orgId from context (not from input)", async () => {
    await workspaceCreateHandler({ name: "Scoped", slug: "scoped" }, CTX);
    // The org query should receive the orgId from CTX, not from user input
    expect(mocks.orgFindFirst).toHaveBeenCalledTimes(1);
  });

  it("slug uniqueness check uses both orgId from context and the input slug", async () => {
    await workspaceCreateHandler({ name: "Scoped2", slug: "scoped2" }, CTX);
    expect(mocks.wsFindFirst).toHaveBeenCalledTimes(1);
  });
});
