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

// The handler's role gate (#4194). This suite spies on drizzle's `eq` and
// `and` to prove the handler's own WHERE clauses, and the real gate builds
// the same conditions on `roles.scopeKind`, so the gate is stubbed here: it
// passes the org roles `mocks.callerOrgRoles` holds when the requirement names
// one, and refuses with the real gate's error shape otherwise.
vi.mock("@oxagen/iam/org-role", async () => {
  const { HandlerError } = await import("@oxagen/oxagen");
  return {
    resolveActingUserId: async (ctx: { userId: string | null }) => ctx.userId,
    assertOrgRole: vi.fn(
      async (_ctx: unknown, required: { org: readonly string[] }) => {
        const match = mocks.callerOrgRoles.find((r) =>
          required.org.includes(r),
        );
        if (match) return match;
        throw new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message: "Requires one of the org roles",
        });
      },
    ),
  };
});

const mocks = vi.hoisted(() => ({
  callerOrgRoles: ["Owner"] as string[],
  withSystemDb: vi.fn(),
  roleRows: [] as Record<string, unknown>[],
  countRows: [] as Record<string, unknown>[],
  grantRows: [] as Record<string, unknown>[],
  userRows: [] as Record<string, unknown>[],
  grantQueries: 0,
  userQueries: 0,
  tier: "free" as string,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

// The org's tier decides `enforcement.enforced`; the real canAccessACL runs.
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, resolveOrgTier: vi.fn(async () => mocks.tier) };
});

// Spy on eq/and while keeping their real drizzle-orm behavior, so assertions
// can check exactly which (column, value) pairs were built into each WHERE
// — the only way to catch a regression that silently drops the org filter.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, eq: vi.fn(real.eq), and: vi.fn(real.and) };
});

import { schema } from "@oxagen/database";
import { assertOrgRole } from "@oxagen/iam/org-role";
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
        if (table === schema.users) {
          mocks.userQueries += 1;
          return { where: () => Promise.resolve(mocks.userRows) };
        }
        throw new Error("unexpected table");
      },
    }),
  };
}

const CREATED_AT = new Date("2026-09-01T00:00:00.000Z");

const ROLE_FIXTURES = [
  {
    id: "uuid-member",
    publicId: "rol_member",
    name: "Member",
    description: null,
    scopeKind: "workspace",
    isSystemDefault: true,
    version: "1",
    createdAt: CREATED_AT,
    createdById: "usr-bootstrap",
  },
  {
    id: "uuid-custom",
    publicId: "rol_custom",
    name: "Analyst",
    description: "custom analyst role",
    scopeKind: "org",
    isSystemDefault: false,
    version: "1",
    createdAt: CREATED_AT,
    createdById: "usr-priya",
  },
  {
    id: "uuid-owner",
    publicId: "rol_owner",
    name: "Owner",
    description: null,
    scopeKind: "org",
    isSystemDefault: true,
    version: "1",
    createdAt: CREATED_AT,
    createdById: "usr-bootstrap",
  },
  {
    id: "uuid-agent-op",
    publicId: "rol_agent_op",
    name: "Agent Operator",
    description: null,
    scopeKind: "workspace",
    isSystemDefault: true,
    version: "1",
    createdAt: CREATED_AT,
    createdById: "usr-bootstrap",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.roleRows = [...ROLE_FIXTURES];
  mocks.countRows = [];
  mocks.grantRows = [];
  mocks.userRows = [];
  mocks.grantQueries = 0;
  mocks.userQueries = 0;
  mocks.tier = "free";
  mocks.callerOrgRoles = ["Owner"];
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
      "rol_agent_op",
      "rol_member",
      "rol_owner",
      "rol_custom",
    ]);
    expect(out.total).toBe(4);
    expect(out.hasMore).toBe(false);
  });

  it("reports the kind: seeded membership roles are human, the seeded agent roles and every custom role are agent roles", async () => {
    const out = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    const kinds = Object.fromEntries(out.roles.map((r) => [r.id, r.kind]));
    expect(kinds).toEqual({
      rol_agent_op: "agent",
      rol_member: "human",
      rol_owner: "human",
      rol_custom: "agent",
    });
  });

  it("folds allow grants into catalogue permissions: a permission is held only when every capability it names is allowed", async () => {
    mocks.grantRows = [
      {
        roleId: "uuid-custom",
        capabilityId: "dispatch_command",
        effect: "allow",
      },
      { roleId: "uuid-custom", capabilityId: "list_runs", effect: "allow" },
      {
        roleId: "uuid-owner",
        capabilityId: "dispatch_command",
        effect: "deny",
      },
    ];
    const out = await iamRoleListHandler(
      { includeGrants: true, limit: 100, offset: 0 },
      CTX,
    );
    const byId = Object.fromEntries(
      out.roles.map((r) => [r.id, r.permissions]),
    );
    expect(byId.rol_custom).toEqual(["run.control"]);
    expect(byId.rol_owner).toEqual([]);
  });

  it("names the creator of a custom role and leaves a system role's origin as built-in (createdBy null), reading users once for the page", async () => {
    mocks.userRows = [
      { id: "usr-priya", displayName: "Priya Natarajan", email: "p@x.test" },
    ];
    const out = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    const custom = out.roles.find((r) => r.id === "rol_custom");
    expect(custom?.createdBy).toBe("Priya Natarajan");
    expect(custom?.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(out.roles.find((r) => r.id === "rol_owner")?.createdBy).toBeNull();
    expect(mocks.userQueries).toBe(1);
  });

  it("carries the catalogue and reports enforcement from the org's tier (free: not enforced; enterprise: enforced)", async () => {
    const free = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(free.enforcement).toEqual({ tier: "free", enforced: false });
    expect(free.catalog.map((p) => p.id)).toContain("run.control");
    expect(free.catalog.every((p) => p.capabilities.length > 0)).toBe(true);

    mocks.tier = "enterprise";
    const enterprise = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(enterprise.enforcement).toEqual({
      tier: "enterprise",
      enforced: true,
    });
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
      { includeGrants: false, limit: 2, offset: 3 },
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

// The contract grants org Owner, Admin, or Compliance. The kernel's IAM check
// allows every capability for a non-enterprise org, so the handler is the
// only gate there (#4194). The grant map it returns is the org's whole
// permission model.
describe("iamRoleListHandler role gate", () => {
  it("asks for the roles the contract grants", async () => {
    await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(vi.mocked(assertOrgRole)).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CTX.userId }),
      { org: ["Owner", "Admin", "Compliance"] },
    );
  });

  it("refuses a workspace Member, who holds no org role, as forbidden, reading nothing", async () => {
    mocks.callerOrgRoles = [];
    await expect(
      iamRoleListHandler({ includeGrants: true, limit: 100, offset: 0 }, CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("allows an org Compliance member", async () => {
    mocks.callerOrgRoles = ["Compliance"];
    const out = await iamRoleListHandler(
      { includeGrants: false, limit: 100, offset: 0 },
      CTX,
    );
    expect(out.total).toBe(4);
  });
});
