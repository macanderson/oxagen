/**
 * iam.role.list handler tests.
 *
 * Strategy: mock withSystemDb with a chainable stub keyed by drizzle table
 * identity. drizzle-orm's `eq`/`and` are spied (not replaced — the real
 * implementations still run) so tenant-scoping and the scopeKind filter can
 * be asserted STRUCTURALLY (which columns/values were actually passed into
 * the WHERE builder), not just inferred from the mock being called — a mock
 * `.where()` that ignores its arguments would otherwise pass a test that
 * only checks call counts even if the org-id filter were dropped.
 *
 * Covers: org-scoping on every table read, system-default-first sort,
 * grants grouping per role, member counts, pagination + hasMore,
 * includeGrants=false skipping the grants query, and the scopeKind filter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  roleRows: [] as Record<string, unknown>[],
  countRows: [] as Record<string, unknown>[],
  grantRows: [] as Record<string, unknown>[],
  grantQueries: 0,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

// Spy on eq/and while keeping their real drizzle-orm behavior, so assertions
// can check exactly which (column, value) pairs were built into each WHERE
// — the only way to catch a regression that silently drops the org filter.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, eq: vi.fn(real.eq), and: vi.fn(real.and) };
});

import { schema } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { iamRoleListHandler } from "./iam.role.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const eqMock = eq as unknown as ReturnType<typeof vi.fn>;
const andMock = and as unknown as ReturnType<typeof vi.fn>;

function makeTx() {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.roles) {
          return { where: () => Promise.resolve(mocks.roleRows) };
        }
        if (table === schema.principalRoleAssignments) {
          return {
            where: () => ({
              groupBy: () => Promise.resolve(mocks.countRows),
            }),
          };
        }
        if (table === schema.roleGrants) {
          mocks.grantQueries += 1;
          return { where: () => Promise.resolve(mocks.grantRows) };
        }
        throw new Error("unexpected table");
      },
    }),
  };
}

const ROLE_FIXTURES = [
  {
    id: "uuid-member",
    publicId: "rol_member",
    name: "Member",
    description: null,
    scopeKind: "workspace",
    isSystemDefault: true,
    version: "1",
  },
  {
    id: "uuid-custom",
    publicId: "rol_custom",
    name: "Analyst",
    description: "custom analyst role",
    scopeKind: "org",
    isSystemDefault: false,
    version: "1",
  },
  {
    id: "uuid-owner",
    publicId: "rol_owner",
    name: "Owner",
    description: null,
    scopeKind: "org",
    isSystemDefault: true,
    version: "1",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roleRows = [...ROLE_FIXTURES];
  mocks.countRows = [];
  mocks.grantRows = [];
  mocks.grantQueries = 0;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  );
});

describe("iamRoleListHandler", () => {
  it("sorts system defaults first then alphabetical, mapping public ids", async () => {
    const out = await iamRoleListHandler(
      { includeGrants: true, limit: 100, offset: 0 },
      CTX,
    );
    expect(out.roles.map((r) => r.id)).toEqual([
      "rol_member",
      "rol_owner",
      "rol_custom",
    ]);
    expect(out.total).toBe(3);
    expect(out.hasMore).toBe(false);
  });

  it("maps member counts and grants per role", async () => {
    mocks.countRows = [{ roleId: "uuid-owner", count: 2 }];
    mocks.grantRows = [
      {
        roleId: "uuid-owner",
        capabilityId: "query_audit_log",
        effect: "allow",
      },
      { roleId: "uuid-owner", capabilityId: "create_api_key", effect: "allow" },
      {
        roleId: "uuid-member",
        capabilityId: "query_audit_log",
        effect: "deny",
      },
    ];
    const out = await iamRoleListHandler(
      { includeGrants: true, limit: 100, offset: 0 },
      CTX,
    );
    const owner = out.roles.find((r) => r.id === "rol_owner");
    expect(owner?.memberCount).toBe(2);
    // Grants sorted by capability name.
    expect(owner?.grants).toEqual([
      { capability: "create_api_key", effect: "allow" },
      { capability: "query_audit_log", effect: "allow" },
    ]);
    const member = out.roles.find((r) => r.id === "rol_member");
    expect(member?.memberCount).toBe(0);
    expect(member?.grants).toEqual([
      { capability: "query_audit_log", effect: "deny" },
    ]);
  });

  it("skips the grants query when includeGrants=false", async () => {
    const out = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(mocks.grantQueries).toBe(0);
    expect(out.roles.every((r) => r.grants.length === 0)).toBe(true);
  });

  it("paginates with hasMore", async () => {
    const page = await iamRoleListHandler(
      { includeGrants: false, limit: 2, offset: 0 },
      CTX,
    );
    expect(page.roles).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const last = await iamRoleListHandler(
      { includeGrants: false, limit: 2, offset: 2 },
      CTX,
    );
    expect(last.roles).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it("runs every read inside withSystemDb (tenant isolation enforced in-handler)", async () => {
    await iamRoleListHandler(
      { includeGrants: true, limit: 100, offset: 0 },
      CTX,
    );
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("scopes every table read to ctx.orgId (structural check, not just call count)", async () => {
    mocks.countRows = [{ roleId: "uuid-owner", count: 1 }];
    mocks.grantRows = [
      { roleId: "uuid-owner", capabilityId: "x", effect: "allow" },
    ];
    await iamRoleListHandler(
      { includeGrants: true, limit: 100, offset: 0 },
      CTX,
    );

    // A regression that dropped any of these org-id equality checks would
    // fail this assertion even though the mock's .where() ignores its args.
    expect(eqMock).toHaveBeenCalledWith(schema.roles.orgId, CTX.orgId);
    expect(eqMock).toHaveBeenCalledWith(
      schema.principalRoleAssignments.orgId,
      CTX.orgId,
    );
    expect(eqMock).toHaveBeenCalledWith(schema.roleGrants.orgId, CTX.orgId);
  });

  it("does not build a scopeKind condition when the filter is omitted", async () => {
    await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    const scopeKindCalls = eqMock.mock.calls.filter(
      (call: unknown[]) => call[0] === schema.roles.scopeKind,
    );
    expect(scopeKindCalls).toHaveLength(0);
    // Only the org-id condition is passed to and(...) for the roles query.
    expect(
      andMock.mock.calls.some((call: unknown[]) => call.length === 1),
    ).toBe(true);
  });

  it("applies the scopeKind filter when provided (structural check)", async () => {
    await iamRoleListHandler(
      { scopeKind: "org", includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(eqMock).toHaveBeenCalledWith(schema.roles.scopeKind, "org");
    // and() for the roles query now combines 2 conditions (org-id + scopeKind).
    expect(
      andMock.mock.calls.some((call: unknown[]) => call.length === 2),
    ).toBe(true);
  });
});
