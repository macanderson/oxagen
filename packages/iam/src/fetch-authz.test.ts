// fetch-authz.test.ts — unit tests for fetchAuthz() (OXA-1524).
//
// Tests:
//   - 42P01 graceful fallback to EMPTY_AUTHZ
//   - !userId early return
//   - !principal early return when no matching principal row
//   - PRA workspace-scope + expiry filter (roles array has empty principalIds for expired/out-of-scope)
//   - Happy path principal + roles resolution

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  // Individual query chain results
  principalSelect: vi.fn(),
  grantsSelect: vi.fn(),
  rolesSelect: vi.fn(),
  policiesSelect: vi.fn(),
  roleGrantsSelect: vi.fn(),
  praSelect: vi.fn(),
  // db() factory
  dbFn: vi.fn(),
}));

// We mock @oxagen/database entirely. Each .select().from().where().limit()
// chain is represented by a single mock for the query that fires.
vi.mock("@oxagen/database", () => ({
  db: mocks.dbFn,
  // withTenantDb: pass-through — invokes the callback with the same fake tx
  // the handler expects. No scope GUC overhead in unit tests (OXA-1515).
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.dbFn()),
  schema: {
    principals: { orgId: "principals.orgId", parentUserId: "principals.parentUserId", id: "principals.id" },
    grants: { principalId: "grants.principalId", capabilityId: "grants.capabilityId", orgId: "grants.orgId" },
    roles: { orgId: "roles.orgId", id: "roles.id" },
    roleGrants: { roleId: "roleGrants.roleId", capabilityId: "roleGrants.capabilityId" },
    policies: { orgId: "policies.orgId", capabilityId: "policies.capabilityId" },
    principalRoleAssignments: {
      principalId: "pra.principalId",
      orgId: "pra.orgId",
      deletedAt: "pra.deletedAt",
      expiresAt: "pra.expiresAt",
      workspaceId: "pra.workspaceId",
      roleId: "pra.roleId",
    },
  },
}));

import { fetchAuthz } from "./fetch-authz";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRINCIPAL_ROW = {
  id: "prn_internal",
  orgId: "org_1",
  workspaceId: null,
  kind: "human",
  displayName: "Test User",
  status: "active",
  mfaStatus: "none",
  idpSubject: null,
  parentUserId: "usr_1",
  metadata: {},
};

function buildDbMock(overrides: {
  principals?: unknown[];
  grants?: unknown[];
  roles?: unknown[];
  policies?: unknown[];
  roleGrants?: unknown[];
  pra?: unknown[];
} = {}) {
  const principals = overrides.principals ?? [PRINCIPAL_ROW];
  const grants = overrides.grants ?? [];
  const roles = overrides.roles ?? [];
  const policies = overrides.policies ?? [];
  const roleGrants = overrides.roleGrants ?? [];
  const pra = overrides.pra ?? [];

  let selectCallIdx = 0;

  const makeChain = (rows: unknown[]) => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });

  const makeChainNoLimit = (rows: unknown[]) => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  });

  return {
    select: () => {
      selectCallIdx++;
      // Call order based on _fetchAuthz's query sequence:
      // 1: principals (with limit 1)
      // 2: grants (batch1)
      // 3: roles (batch1)
      // 4: policies (batch1)
      // 5: roleGrants (batch2)
      // 6: pra (batch2)
      switch (selectCallIdx) {
        case 1: return makeChain(principals);
        case 2: return makeChainNoLimit(grants);
        case 3: return makeChainNoLimit(roles);
        case 4: return makeChainNoLimit(policies);
        case 5: return makeChainNoLimit(roleGrants);
        case 6: return makeChainNoLimit(pra);
        default: return makeChain([]);
      }
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchAuthz()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 42P01 graceful fallback ──────────────────────────────────────────────

  it("returns EMPTY_AUTHZ when Postgres throws 42P01 (table missing)", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("relation does not exist"), { code: "42P01" });
        throw err;
      },
    });

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    expect(result.principal).toBeNull();
    expect(result.grants).toHaveLength(0);
    expect(result.roles).toHaveLength(0);
  });

  it("rethrows non-42P01 errors", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("connection refused"), { code: "08006" });
        throw err;
      },
    });

    await expect(
      fetchAuthz({
        userId: "usr_1",
        apiKeyId: null,
        orgId: "org_1",
        workspaceId: "ws_1",
        capability: "chat.message.send",
      }),
    ).rejects.toThrow("connection refused");
  });

  // ── !userId early return ─────────────────────────────────────────────────

  it("returns EMPTY_AUTHZ immediately when userId is null", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock());

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    // No selects should have fired — the function returns before any DB queries.
    expect(result.principal).toBeNull();
    expect(result.grants).toHaveLength(0);
    expect(result.roles).toHaveLength(0);
    expect(result.roleGrants).toHaveLength(0);
    expect(result.policies).toHaveLength(0);
  });

  // ── !principal early return ──────────────────────────────────────────────

  it("returns EMPTY_AUTHZ when no principal row matches the userId in this org", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ principals: [] }));

    const result = await fetchAuthz({
      userId: "usr_unknown",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    expect(result.principal).toBeNull();
    expect(result.grants).toHaveLength(0);
  });

  // ── PRA expiry + workspace scope filter ──────────────────────────────────

  it("maps PRA rows to role principalIds — assigned roles get principalId in list", async () => {
    const roleRow = { id: "role_owner", orgId: "org_1", name: "Owner", scopeKind: "org" };
    const praRow = { roleId: "role_owner" };

    mocks.dbFn.mockReturnValue(
      buildDbMock({
        roles: [roleRow],
        pra: [praRow],
        roleGrants: [{ roleId: "role_owner", capabilityId: "chat.message.send", effect: "allow" }],
      }),
    );

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    expect(result.principal?.id).toBe("prn_internal");
    // The role should include the principal because the PRA exists.
    const ownerRole = result.roles.find((r) => r.id === "role_owner");
    expect(ownerRole?.principalIds).toContain("prn_internal");
  });

  it("excludes principalId from role when no PRA row matches", async () => {
    const roleRow = { id: "role_member", orgId: "org_1", name: "Member", scopeKind: "workspace" };
    // No PRA rows for this principal.
    mocks.dbFn.mockReturnValue(buildDbMock({ roles: [roleRow], pra: [] }));

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    const memberRole = result.roles.find((r) => r.id === "role_member");
    // No PRA → principalIds is empty → deny-by-default via role path.
    expect(memberRole?.principalIds).toHaveLength(0);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("returns a correctly shaped AuthzData on the happy path", async () => {
    const roleRow = { id: "role_admin", orgId: "org_1", name: "Admin", scopeKind: "org" };
    const praRow = { roleId: "role_admin" };
    const roleGrantRow = {
      roleId: "role_admin",
      capabilityId: "chat.message.send",
      effect: "allow",
    };
    const grantRow = {
      principalId: "prn_internal",
      capabilityId: "chat.message.send",
      scopeKind: "org",
      scopeId: "org_1",
      effect: "allow",
      conditionsJsonb: null,
      expiresAt: null,
    };
    const policyRow = {
      capabilityId: "chat.message.send",
      scopeKind: "org",
      scopeId: "org_1",
      effect: "allow",
      enforced: false,
      conditionsJsonb: null,
    };

    mocks.dbFn.mockReturnValue(
      buildDbMock({
        roles: [roleRow],
        pra: [praRow],
        roleGrants: [roleGrantRow],
        grants: [grantRow],
        policies: [policyRow],
      }),
    );

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "chat.message.send",
    });

    expect(result.principal?.id).toBe("prn_internal");
    expect(result.principal?.kind).toBe("human");
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]?.effect).toBe("allow");
    expect(result.roleGrants).toHaveLength(1);
    expect(result.roleGrants[0]?.effect).toBe("allow");
    expect(result.policies).toHaveLength(1);
    expect(result.roles).toHaveLength(1);
  });
});
