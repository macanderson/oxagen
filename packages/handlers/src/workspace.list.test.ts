/**
 * Unit tests for the workspace.list handler.
 *
 * Mirrors org.list.test.ts: workspace.list received the same API-key auth fix
 * (the CLI calls it immediately after org.list and would otherwise hit the
 * identical IAM-no_grant / null-userId 403). Covers session auth, API-key
 * creator resolution, and the fail-closed paths. The upstream contract fix is
 * defaultEffect:"deny" -> "allow" on workspace.list; this exercises the handler
 * in isolation (IAM is not invoked here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted stubs ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { workspaceListHandler } from "./workspace.list";
import { makeCTX } from "./test-utils/fixtures";

// ── shared fixtures ────────────────────────────────────────────────────────────

const LIST_RESULT = {
  organization: {
    id: "org_1",
    publicId: "pub_1",
    slug: "acme",
    namespace: "acme",
    name: "Acme Corp",
  },
  workspaces: [
    {
      id: "ws_1",
      publicId: "wpub_1",
      slug: "core",
      namespace: "core",
      name: "Core",
      role: "admin",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe("workspaceListHandler", () => {
  // ── session auth ────────────────────────────────────────────────────────────

  it("returns workspaces for a session-auth caller (ctx.userId set)", async () => {
    // One withSystemDb call: the org+membership+listing transaction. No API-key lookup.
    mocks.withSystemDb.mockResolvedValueOnce(LIST_RESULT);

    const result = await workspaceListHandler(
      { orgSlug: "acme", includeArchived: false },
      makeCTX({
        userId: "usr_session",
        apiKeyId: null,
        orgId: "",
        workspaceId: "",
      }),
    );

    expect(result.workspaces).toHaveLength(1);
    expect(result.organization.slug).toBe("acme");
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── API-key auth ─────────────────────────────────────────────────────────────

  it("resolves the effective user from the API key and returns their workspaces", async () => {
    // Call 1: API-key lookup returns the key's creator.
    mocks.withSystemDb.mockResolvedValueOnce({
      createdById: "usr_key_creator",
    });
    // Call 2: org+membership+listing transaction.
    mocks.withSystemDb.mockResolvedValueOnce(LIST_RESULT);

    const result = await workspaceListHandler(
      { orgSlug: "acme", includeArchived: false },
      makeCTX({
        userId: null,
        apiKeyId: "aky_test",
        orgId: "org_bound",
        workspaceId: "ws_bound",
      }),
    );

    expect(result.workspaces[0]?.name).toBe("Core");
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("throws when the API key row has no createdById (fail-closed)", async () => {
    mocks.withSystemDb.mockResolvedValueOnce({ createdById: null });

    await expect(
      workspaceListHandler(
        { orgSlug: "acme", includeArchived: false },
        makeCTX({ userId: null, apiKeyId: "aky_no_creator" }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    // Should not proceed to the listing transaction.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("throws when the API key row cannot be found (soft-deleted or missing)", async () => {
    mocks.withSystemDb.mockResolvedValueOnce(null);

    await expect(
      workspaceListHandler(
        { orgSlug: "acme", includeArchived: false },
        makeCTX({ userId: null, apiKeyId: "aky_deleted" }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  // ── no auth ───────────────────────────────────────────────────────────────────

  it("throws immediately when neither userId nor apiKeyId is set (unauthenticated)", async () => {
    await expect(
      workspaceListHandler(
        { orgSlug: "acme", includeArchived: false },
        makeCTX({ userId: null, apiKeyId: null }),
      ),
    ).rejects.toThrow("workspace.list requires an authenticated user");

    // No DB calls for unauthenticated requests.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  // ── membership gate ──────────────────────────────────────────────────────────

  describe("membership gate", () => {
    const org = {
      id: "org_1",
      publicId: "pub_1",
      slug: "acme",
      namespace: "acme",
      name: "Acme Corp",
      avatarUrl: null as string | null,
    };

    function runInTx(found: {
      org: typeof org | undefined;
      membership: { role: string } | undefined;
    }) {
      const tx = {
        query: {
          organizations: { findFirst: vi.fn().mockResolvedValue(found.org) },
          orgUsers: { findFirst: vi.fn().mockResolvedValue(found.membership) },
        },
        select: vi.fn(),
      };
      mocks.withSystemDb.mockImplementationOnce(
        (fn: (t: typeof tx) => unknown) => fn(tx),
      );
      return tx;
    }

    const session = makeCTX({
      userId: "usr_session",
      apiKeyId: null,
      orgId: "",
      workspaceId: "",
    });

    it("lists the organization's workspaces in creation order, so the first is its first workspace", async () => {
      const { schema } = await import("@oxagen/database");
      const { asc } = await import("drizzle-orm");
      const orderBy = vi.fn().mockResolvedValue([]);
      const tx = runInTx({ org, membership: { role: "owner" } });
      tx.select.mockReturnValue({
        from: () => ({ leftJoin: () => ({ where: () => ({ orderBy }) }) }),
      });
      await workspaceListHandler(
        { includeArchived: false, orgSlug: "acme" },
        session,
      );
      expect(orderBy).toHaveBeenCalledWith(
        asc(schema.workspaces.createdAt),
        asc(schema.workspaces.slug),
      );
    });

    // One row as the select answers it, without the avatar column, which each
    // test adds.
    const row = {
      id: "ws_1",
      publicId: "wpub_1",
      slug: "core",
      namespace: "core",
      name: "Core",
      role: "owner",
      archivedAt: null,
      costCenter: null,
    };

    it("returns the stored avatar of the organization and of each workspace, and null where the column is null", async () => {
      const { schema } = await import("@oxagen/database");
      const link = "https://cdn.example.test/acme.png";
      const designed = 'avatar:v1:{"kind":"initials","text":"C","font":"sans","tone":"gold"}';
      const orderBy = vi.fn().mockResolvedValue([
        { ...row, avatarUrl: designed },
        {
          ...row,
          id: "ws_2",
          publicId: "wpub_2",
          slug: "labs",
          namespace: "labs",
          name: "Labs",
          avatarUrl: null,
        },
      ]);
      const tx = runInTx({
        org: { ...org, avatarUrl: link },
        membership: { role: "owner" },
      });
      tx.select.mockReturnValue({
        from: () => ({ leftJoin: () => ({ where: () => ({ orderBy }) }) }),
      });
      const result = await workspaceListHandler(
        { includeArchived: false, orgSlug: "acme" },
        session,
      );
      expect(result.organization.avatarUrl).toBe(link);
      expect(result.workspaces.map((w) => w.avatarUrl)).toEqual([
        designed,
        null,
      ]);
      // The fakes answer whatever the test hands them, so the reads must also
      // be shown to ask for the column.
      expect(tx.query.organizations.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          columns: expect.objectContaining({ avatarUrl: true }),
        }),
      );
      expect(tx.select).toHaveBeenCalledWith(
        expect.objectContaining({ avatarUrl: schema.workspaces.avatarUrl }),
      );
    });

    it("returns null for an organization whose avatar column is null", async () => {
      const orderBy = vi.fn().mockResolvedValue([{ ...row, avatarUrl: null }]);
      const tx = runInTx({ org, membership: { role: "owner" } });
      tx.select.mockReturnValue({
        from: () => ({ leftJoin: () => ({ where: () => ({ orderBy }) }) }),
      });
      const result = await workspaceListHandler(
        { includeArchived: false, orgSlug: "acme" },
        session,
      );
      expect(result.organization.avatarUrl).toBeNull();
      expect(result.workspaces[0]?.avatarUrl).toBeNull();
    });

    it("refuses an organization the caller is not a member of as forbidden, listing nothing (negative)", async () => {
      const tx = runInTx({ org, membership: undefined });
      await expect(
        workspaceListHandler(
          { includeArchived: false, orgSlug: "acme" },
          session,
        ),
      ).rejects.toMatchObject({ code: "forbidden", reason: "not_a_member" });
      expect(tx.select).not.toHaveBeenCalled();
    });

    it("refuses an unknown organization with the same refusal (negative)", async () => {
      const tx = runInTx({ org: undefined, membership: undefined });
      await expect(
        workspaceListHandler(
          { includeArchived: false, orgSlug: "nope" },
          session,
        ),
      ).rejects.toMatchObject({ code: "forbidden", reason: "not_a_member" });
      expect(tx.query.orgUsers.findFirst).not.toHaveBeenCalled();
    });
  });
});
