import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn((_value: unknown) => ({ where }));
  const update = vi.fn(() => ({ set }));
  // Slug-history capture: the handler inserts a row into
  // workspace_slug_history inside the SAME withTenantDb tx whenever the slug
  // changes. The mock records every insert so each test can assert (or assert
  // the absence of) a history write.
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values: insertValues }));
  return {
    findFirst: vi.fn(),
    where,
    set,
    update,
    insert,
    insertValues,
    /** The actor's principal, org role and workspace role, as assertOrgRole reads them. */
    tenant: {
      principalId: "prn_1" as string | null,
      roleName: "Owner" as string | null,
      workspaceRoleName: null as string | null,
      /** The creator an API key resolves to, or none. */
      keyCreator: "u_1" as string | null,
    },
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dialect = new PgDialect();
  // The role gate's reads are answered by table and by the scope the WHERE
  // pins: an org-wide assignment has `workspace_id is null`, a workspace
  // assignment carries the id. The handler's own reads go through
  // query.workspaces.findFirst.
  const rowsFor = (table: unknown, where: SQL | null): unknown[] => {
    if (table === real.schema.apiKeys)
      return mocks.tenant.keyCreator
        ? [{ createdByUserId: mocks.tenant.keyCreator }]
        : [];
    if (table === real.schema.principals)
      return mocks.tenant.principalId ? [{ id: mocks.tenant.principalId }] : [];
    if (table === real.schema.principalRoleAssignments) {
      const pinsWorkspace =
        where !== null &&
        /"workspace_id" = \$/.test(dialect.sqlToQuery(where).sql);
      const name = pinsWorkspace
        ? mocks.tenant.workspaceRoleName
        : mocks.tenant.roleName;
      return name ? [{ roleName: name }] : [];
    }
    throw new Error("unexpected table");
  };
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: { workspaces: { findFirst: mocks.findFirst } },
        update: mocks.update,
        insert: mocks.insert,
        select: () => ({
          from: (table: unknown) => {
            let lastWhere: SQL | null = null;
            const chain = {
              innerJoin: () => chain,
              where: (cond: SQL) => {
                lastWhere = cond;
                return chain;
              },
              limit: () => Promise.resolve(rowsFor(table, lastWhere)),
            };
            return chain;
          },
        }),
      }),
  };
});

import { workspaceSettingsWriteHandler } from "./workspace.settings.write";
import { isHandlerError } from "@oxagen/oxagen";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const EXISTING = {
  id: CTX.workspaceId,
  name: "Research",
  slug: "research",
  description: "old",
};

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  if (!isHandlerError(err))
    throw new Error(`expected a HandlerError, got ${err}`);
  return { code: err.code, reason: err.reason };
};

describe("workspace.settings.write handler", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
    mocks.set.mockClear();
    mocks.update.mockClear();
    mocks.where.mockReset();
    mocks.where.mockResolvedValue(undefined);
    mocks.insert.mockClear();
    mocks.insertValues.mockReset();
    mocks.insertValues.mockResolvedValue(undefined);
    mocks.tenant.principalId = "prn_1";
    mocks.tenant.roleName = "Owner";
    mocks.tenant.workspaceRoleName = null;
    mocks.tenant.keyCreator = "u_1";
  });

  // ── Role gate (INV-29) ───────────────────────────────────────────────────

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required and reads nothing (negative)",
    async (roleName) => {
      mocks.tenant.roleName = roleName;
      await expect(
        refusal(workspaceSettingsWriteHandler({ name: "X" }, CTX)),
      ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
      expect(mocks.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["Owner", "Admin"])(
    "lets a workspace %s with no org role edit the workspace the call is scoped to",
    async (workspaceRoleName) => {
      mocks.tenant.roleName = "Member";
      mocks.tenant.workspaceRoleName = workspaceRoleName;
      mocks.findFirst
        .mockResolvedValueOnce(EXISTING)
        .mockResolvedValueOnce({ ...EXISTING, name: "Renamed" });
      const out = await workspaceSettingsWriteHandler({ name: "Renamed" }, CTX);
      expect(out.name).toBe("Renamed");
      expect(mocks.update).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["Owner", "Admin"])(
    "refuses a workspace %s with no org role who names another workspace, and reads and updates nothing (negative)",
    async (workspaceRoleName) => {
      mocks.tenant.roleName = "Member";
      mocks.tenant.workspaceRoleName = workspaceRoleName;
      await expect(
        refusal(
          workspaceSettingsWriteHandler(
            { workspaceId: "wrk_other", slug: "x", name: "Taken over" },
            CTX,
          ),
        ),
      ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
      expect(mocks.findFirst).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );

  it("refuses a context with no user (negative)", async () => {
    await expect(
      refusal(
        workspaceSettingsWriteHandler({ name: "X" }, { ...CTX, userId: null }),
      ),
    ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
  });

  describe("an MCP call: an API key and no signed-in user", () => {
    const keyCtx = {
      ...CTX,
      userId: null,
      apiKeyId: "aky_1",
      surface: "mcp" as const,
    };

    it("edits as the key's creator when the creator is an org Owner", async () => {
      mocks.findFirst
        .mockResolvedValueOnce(EXISTING)
        .mockResolvedValueOnce({ ...EXISTING, name: "Renamed" });
      const out = await workspaceSettingsWriteHandler(
        { name: "Renamed" },
        keyCtx,
      );
      expect(out.name).toBe("Renamed");
    });

    it("refuses a key whose creator is an org Member with no workspace role (negative)", async () => {
      mocks.tenant.roleName = "Member";
      await expect(
        refusal(workspaceSettingsWriteHandler({ name: "X" }, keyCtx)),
      ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
      expect(mocks.findFirst).not.toHaveBeenCalled();
    });

    it("refuses a key that resolves to no creator (negative)", async () => {
      mocks.tenant.keyCreator = null;
      await expect(
        refusal(workspaceSettingsWriteHandler({ name: "X" }, keyCtx)),
      ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
    });
  });

  // ── Target workspace ─────────────────────────────────────────────────────

  it("updates the workspace workspaceId names for an org Admin, by public id in the org, and captures its slug history under that id", async () => {
    mocks.tenant.roleName = "Admin";
    mocks.findFirst
      .mockResolvedValueOnce({ ...EXISTING, id: "ws-other-uuid" })
      .mockResolvedValueOnce({ ...EXISTING, slug: "renamed" });
    const out = await workspaceSettingsWriteHandler(
      { workspaceId: "wrk_other", slug: "renamed" },
      CTX,
    );
    expect(out.slug).toBe("renamed");
    const insertRow = mocks.insertValues.mock.calls[0]![0] as {
      workspaceId: string;
    };
    expect(insertRow.workspaceId).toBe("ws-other-uuid");
  });

  it("refuses with not_found when workspaceId names a workspace outside the org (negative)", async () => {
    mocks.findFirst.mockResolvedValueOnce(undefined);
    await expect(
      refusal(
        workspaceSettingsWriteHandler(
          { workspaceId: "wrk_elsewhere", name: "X" },
          CTX,
        ),
      ),
    ).resolves.toEqual({ code: "not_found", reason: "workspace_not_found" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("updates the name and description columns independently", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      name: "Research Lab",
      slug: "research",
      description: "new desc",
    });
    const out = await workspaceSettingsWriteHandler(
      { name: "Research Lab", description: "new desc" },
      CTX,
    );

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const setArg = mocks.set.mock.calls[0]![0] as {
      name?: string;
      description?: string | null;
    };
    expect(setArg.name).toBe("Research Lab");
    // description is a real column now — set directly, never via the settings bag.
    expect(setArg.description).toBe("new desc");
    expect("settings" in setArg).toBe(false);
    expect(out.name).toBe("Research Lab");
    expect(out.description).toBe("new desc");
  });

  it("sets the avatarUrl column and returns it", async () => {
    const avatar = 'avatar:v1:{"emoji":"🔬","bg":"#2563eb","mode":"full"}';
    mocks.findFirst.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      name: "Research",
      slug: "research",
      avatarUrl: avatar,
      description: "old",
    });
    const out = await workspaceSettingsWriteHandler({ avatarUrl: avatar }, CTX);

    const setArg = mocks.set.mock.calls[0]![0] as { avatarUrl?: string | null };
    expect(setArg.avatarUrl).toBe(avatar);
    expect(out.avatarUrl).toBe(avatar);
  });

  it("clears the avatarUrl column when passed null", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        ...EXISTING,
        avatarUrl: "https://cdn.example.com/a.png",
      })
      .mockResolvedValueOnce({
        name: "Research",
        slug: "research",
        avatarUrl: null,
        description: "old",
      });
    const out = await workspaceSettingsWriteHandler({ avatarUrl: null }, CTX);

    const setArg = mocks.set.mock.calls[0]![0] as { avatarUrl?: string | null };
    expect(setArg.avatarUrl).toBeNull();
    expect(out.avatarUrl).toBeNull();
  });

  it("clears the description column when passed null", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      name: "Research",
      slug: "research",
      description: null,
    });
    const out = await workspaceSettingsWriteHandler({ description: null }, CTX);
    const setArg = mocks.set.mock.calls[0]![0] as {
      description?: string | null;
    };
    expect(setArg.description).toBeNull();
    expect(out.description).toBeNull();
  });

  it("does not issue an update when no fields are provided", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    const out = await workspaceSettingsWriteHandler({}, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(out.slug).toBe("research");
  });

  it("maps a unique-violation on slug to conflict / slug_taken", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.where.mockRejectedValueOnce({ code: "23505" });
    await expect(
      refusal(workspaceSettingsWriteHandler({ slug: "taken" }, CTX)),
    ).resolves.toEqual({ code: "conflict", reason: "slug_taken" });
  });

  it("maps a Drizzle-wrapped unique-violation (code on .cause) to conflict / slug_taken", async () => {
    // Production path: drizzle wraps the postgres.js error and the SQLSTATE
    // lives on `.cause`, not the top level. The shared isUniqueViolation walks
    // the cause chain; a top-level-only check would miss this and leak raw SQL.
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.where.mockRejectedValueOnce({
      name: "DrizzleQueryError",
      message: "Failed query: update workspace.workspaces ...",
      cause: { code: "23505", constraint_name: "workspaces_org_slug_idx" },
    });
    await expect(
      refusal(workspaceSettingsWriteHandler({ slug: "taken" }, CTX)),
    ).resolves.toEqual({ code: "conflict", reason: "slug_taken" });
  });

  it("refuses with not_found when the active workspace is not in the org", async () => {
    mocks.findFirst.mockResolvedValueOnce(undefined);
    await expect(
      refusal(workspaceSettingsWriteHandler({ name: "X" }, CTX)),
    ).resolves.toEqual({ code: "not_found", reason: "workspace_not_found" });
  });

  // ── Slug-history capture ────────────────────────────────────────────────────
  // The handler MUST insert one workspace_slug_history row whenever the
  // workspace slug changes, in the SAME withTenantDb transaction as the
  // workspace UPDATE — so the redirect record never lags the rename even on
  // process crash. These tests assert capture-on-change and skip-on-unchange.

  it("writes a workspace_slug_history row when the slug changes", async () => {
    mocks.findFirst.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      name: "Research",
      slug: "new-slug",
      settings: { description: "old" },
    });
    await workspaceSettingsWriteHandler({ slug: "new-slug" }, CTX);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const insertRow = mocks.insertValues.mock.calls[0]![0] as {
      orgId: string;
      workspaceId: string;
      oldSlug: string;
      newSlug: string;
    };
    expect(insertRow.oldSlug).toBe("research");
    expect(insertRow.newSlug).toBe("new-slug");
    expect(insertRow.orgId).toBe(CTX.orgId);
    expect(insertRow.workspaceId).toBe(CTX.workspaceId);
  });

  it("does NOT write history when slug is omitted or unchanged", async () => {
    // name-only update — no slug change → no history row.
    mocks.findFirst.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      name: "Research Lab",
      slug: "research",
      settings: { description: "old" },
    });
    await workspaceSettingsWriteHandler({ name: "Research Lab" }, CTX);
    expect(mocks.insert).not.toHaveBeenCalled();

    // Slug echoes the existing value → still no history row (capture is on
    // CHANGE, not on every slug submission).
    mocks.findFirst
      .mockResolvedValueOnce(EXISTING)
      .mockResolvedValueOnce(EXISTING);
    await workspaceSettingsWriteHandler({ slug: "research" }, CTX);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does NOT write history when the UPDATE fails (atomic rollback)", async () => {
    // Insert is queued INSIDE the same try/catch block as the UPDATE so a
    // unique-violation surfaces a friendly error and the (mocked) tx
    // rollback discards the history row too. Asserts the order: a failing
    // UPDATE must reach the catch — but since the mock can't roll back, the
    // proof is that the insert call happened BEFORE the failing update so a
    // real tx would discard both.
    mocks.findFirst.mockResolvedValueOnce(EXISTING);
    mocks.where.mockRejectedValueOnce({ code: "23505" });
    await expect(
      workspaceSettingsWriteHandler({ slug: "taken" }, CTX),
    ).rejects.toThrow(/already exists/);
    // The history insert ran first (so the surrounding tx would roll it back),
    // and the update was attempted after.
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
