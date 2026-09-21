// list_members with the database stubbed: which query each scope runs and how
// rows become contract output. The behaviour against real rows (cross-org
// isolation, a Member listing, expired pending invitations retained) is in
// workspace.member.list.pg.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";

const mocks = vi.hoisted(() => ({
  // One entry per query, in execution order: that query's rows, or the error
  // it fails with.
  results: [] as (unknown[] | Error)[],
  froms: [] as unknown[],
}));

// A drizzle query chain: select().from().[innerJoin()].where().orderBy().
// `from` records the table so a test can say which one a scope reads.
const makeTx = () => ({
  select: () => ({
    from: (table: unknown) => {
      mocks.froms.push(table);
      const rows = mocks.results.shift() ?? [];
      const tail = {
        orderBy: async () => {
          if (rows instanceof Error) throw rows;
          return rows;
        },
      };
      const where = { where: () => tail };
      return { innerJoin: () => where, ...where };
    },
  }),
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { schema } from "@oxagen/database";
import { listMembersHandler } from "./workspace.member.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const memberRow = (overrides: Record<string, unknown> = {}) => ({
  id: "usr_alice",
  name: "Alice",
  email: "alice@example.com",
  role: "Member",
  joinedAt: new Date("2024-01-15T00:00:00.000Z"),
  ...overrides,
});

const invitationRow = (overrides: Record<string, unknown> = {}) => ({
  id: "invi_bob",
  email: "bob@example.com",
  role: "Admin",
  invitedAt: new Date("2024-02-01T00:00:00.000Z"),
  expiresAt: new Date("2024-02-08T00:00:00.000Z"),
  ...overrides,
});

describe("listMembersHandler", () => {
  beforeEach(() => {
    mocks.results.length = 0;
    mocks.froms.length = 0;
  });

  it("workspace scope reads workspace_users and returns members only", async () => {
    mocks.results.push([memberRow()]);
    const out = await listMembersHandler({ scope: "workspace" }, CTX);
    expect(listMembers.output.safeParse(out).success).toBe(true);
    expect(mocks.froms).toEqual([schema.workspaceUsers]);
    expect(out).toEqual({
      scope: "workspace",
      members: [
        {
          id: "usr_alice",
          name: "Alice",
          email: "alice@example.com",
          role: "Member",
          joinedAt: "2024-01-15T00:00:00.000Z",
        },
      ],
    });
  });

  it("org scope reads org_users then invitations and returns both", async () => {
    mocks.results.push([memberRow({ name: null })], [invitationRow()]);
    const out = await listMembersHandler({ scope: "org" }, CTX);
    expect(listMembers.output.safeParse(out).success).toBe(true);
    expect(mocks.froms).toEqual([schema.orgUsers, schema.invitations]);
    expect(out).toEqual({
      scope: "org",
      members: [
        {
          id: "usr_alice",
          name: null,
          email: "alice@example.com",
          role: "Member",
          joinedAt: "2024-01-15T00:00:00.000Z",
        },
      ],
      invitations: [
        {
          id: "invi_bob",
          email: "bob@example.com",
          role: "Admin",
          invitedAt: "2024-02-01T00:00:00.000Z",
          expiresAt: "2024-02-08T00:00:00.000Z",
        },
      ],
    });
  });

  it("an invitation with no expiry is returned with expiresAt null", async () => {
    mocks.results.push([], [invitationRow({ expiresAt: null })]);
    const out = await listMembersHandler({ scope: "org" }, CTX);
    if (out.scope !== "org") throw new Error("unreachable");
    expect(out.invitations[0]?.expiresAt).toBeNull();
  });

  it("an empty org answers with two empty arrays", async () => {
    const out = await listMembersHandler({ scope: "org" }, CTX);
    expect(out).toEqual({ scope: "org", members: [], invitations: [] });
  });

  it("propagates a database failure", async () => {
    mocks.results.push(new Error("DB connection failed"));
    await expect(
      listMembersHandler({ scope: "workspace" }, CTX),
    ).rejects.toThrow("DB connection failed");
  });
});
