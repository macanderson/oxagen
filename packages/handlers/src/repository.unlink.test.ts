// `unlink_repository` (Mission Control spec §10.1; ADR-099): the head goes,
// the binding versions stay, and the main repository is never the head that
// goes — a workspace without a main repo cannot exist.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { schema } from "@oxagen/database";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { repositoryUnlinkHandler } from "./repository.unlink";

const INPUT = { bindingId: "rpb_0123abcd" };

interface Writes {
  locks: number;
  deletes: Array<{ table: unknown }>;
  updates: number;
  inserts: number;
}

/**
 * The one transaction: the lock, one select (from → innerJoin → where → limit)
 * answering the head whose current binding carries the id, and the delete.
 * Updates and inserts are counted so a test can say nothing else moved.
 */
function wire(opts: { head?: unknown[] }): Writes {
  const writes: Writes = { locks: 0, deletes: [], updates: 0, inserts: 0 };
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async () => {
          writes.locks += 1;
          return [];
        },
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => opts.head ?? [] }),
            }),
          }),
        }),
        delete: (table: unknown) => ({
          where: async () => {
            writes.deletes.push({ table });
            return [];
          },
        }),
        update: () => {
          writes.updates += 1;
          return { set: () => ({ where: async () => [] }) };
        },
        insert: () => {
          writes.inserts += 1;
          return { values: async () => [] };
        },
      }),
  );
  return writes;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("unlink_repository", () => {
  it("refuses a caller who is not an org Owner/Admin or the workspace Owner, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    await expect(repositoryUnlinkHandler(INPUT, makeCTX())).rejects.toThrow(
      "org_role_required",
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses a binding id no head in this workspace points at, and deletes nothing", async () => {
    const writes = wire({ head: [] });
    await expect(
      repositoryUnlinkHandler(INPUT, makeCTX()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_linked",
    });
    expect(writes.locks).toBe(1);
    expect(writes.deletes).toHaveLength(0);
  });

  it("refuses the main repository with main_repo_unlink_refused, and deletes nothing", async () => {
    const writes = wire({
      head: [{ id: "head-main", role: "main", fullName: "Acme/Widgets" }],
    });
    const err = await repositoryUnlinkHandler(INPUT, makeCTX()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    expect((err as Error).message).toContain("Acme/Widgets");
    expect(writes.deletes).toHaveLength(0);
    expect(writes.updates).toBe(0);
    expect(writes.inserts).toBe(0);
  });

  it("deletes only the linked head — the binding versions it pointed at stay — and answers the contract's shape", async () => {
    const writes = wire({
      head: [{ id: "head-linked", role: "linked", fullName: "Acme/Docs" }],
    });
    const before = Date.now();
    const out = await repositoryUnlinkHandler(INPUT, makeCTX());

    expect(writes.locks).toBe(1);
    // Exactly one delete, and it is the head: `repository_bindings` is
    // immutable evidence admitted runs cite, so it is never touched.
    expect(writes.deletes).toEqual([{ table: schema.repositoryBindingHeads }]);
    expect(writes.updates).toBe(0);
    expect(writes.inserts).toBe(0);

    expect(out).toMatchObject({
      bindingId: "rpb_0123abcd",
      fullName: "Acme/Docs",
    });
    expect(Date.parse(out.unlinkedAt)).toBeGreaterThanOrEqual(before);
    expect(repositoryUnlink.output.safeParse(out).success).toBe(true);
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ head: [{ id: "h", role: "linked", fullName: "Acme/Docs" }] });
    await repositoryUnlinkHandler(INPUT, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
  });
});
