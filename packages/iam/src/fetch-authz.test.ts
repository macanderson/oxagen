// fetch-authz.test.ts — unit tests for fetchAuthz().
//
// Tests:
//   - 42P01 fails closed (deny) for BOTH human sessions and API keys, with a
//     loud logger.error alert — never a silent EMPTY_AUTHZ/defaultEffect
//     degradation
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
  // logger spy — asserts the loud alert on 42P01.
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

// We mock @oxagen/database entirely. Each .select().from().where().limit()
// chain is represented by a single mock for the query that fires.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: mocks.dbFn,
    // withTenantDb: pass-through — invokes the callback with the same fake tx
    // the handler expects. No scope GUC overhead in unit tests.
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

// Spy on the module logger so we can assert the 42P01 alert is logged loudly
// (error, not warn).
vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: mocks.loggerWarn },
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
  idpSubject: null,
  parentUserId: "usr_1",
  metadata: {},
};

// Mock for the API-key path, where _fetchAuthz fires an EXTRA leading query to
// resolve the key's creator before the principal lookup. Query order:
//   1: api_keys (created_by_user_id, with limit 1)
//   2: principals (with limit 1)
//   3: roles (no limit)
//   4: roleGrants (no limit, only if roleIds.length > 0)
//   5: pra (no limit)
function buildApiKeyDbMock(
  overrides: {
    apiKey?: unknown[];
    principals?: unknown[];
    roles?: unknown[];
    roleGrants?: unknown[];
    pra?: unknown[];
  } = {},
) {
  const apiKey = overrides.apiKey ?? [{ createdByUserId: "usr_creator" }];
  const principals = overrides.principals ?? [
    { ...PRINCIPAL_ROW, parentUserId: "usr_creator" },
  ];
  const roles = overrides.roles ?? [];
  const roleGrants = overrides.roleGrants ?? [];
  const pra = overrides.pra ?? [];

  let selectCallIdx = 0;

  const makeChain = (rows: unknown[]) => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
  const makeChainNoLimit = (rows: unknown[]) => ({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });

  return {
    select: () => {
      selectCallIdx++;
      switch (selectCallIdx) {
        case 1:
          return makeChain(apiKey);
        case 2:
          return makeChain(principals);
        case 3:
          return makeChainNoLimit(roles);
        case 4:
          return makeChainNoLimit(roleGrants);
        case 5:
          return makeChainNoLimit(pra);
        default:
          return makeChain([]);
      }
    },
  };
}

function buildDbMock(
  overrides: {
    principals?: unknown[];
    grants?: unknown[];
    roles?: unknown[];
    policies?: unknown[];
    roleGrants?: unknown[];
    pra?: unknown[];
  } = {},
) {
  // grants/policies tables were dropped in migration 0027 — _fetchAuthz returns
  // [] for both unconditionally (never a DB query), so this mock has no chain
  // for them. The override keys remain accepted but are intentionally unused.
  const principals = overrides.principals ?? [PRINCIPAL_ROW];
  const roles = overrides.roles ?? [];
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
      // 2: roles (batch1 — grants/policies are Promise.resolve([]), not DB queries)
      // 3: roleGrants (batch2, only if roleIds.length > 0)
      // 4: pra (batch2, always)
      switch (selectCallIdx) {
        case 1:
          return makeChain(principals);
        case 2:
          return makeChainNoLimit(roles);
        case 3:
          return makeChainNoLimit(roleGrants);
        case 4:
          return makeChainNoLimit(pra);
        default:
          return makeChain([]);
      }
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchAuthz()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 42P01 fails closed ─────────────────────────────────────────────────────
  // Previously a human-session caller degraded to EMPTY_AUTHZ (→ resolver
  // falls through to each contract's defaultEffect) when the IAM tables were
  // missing — a silent "IAM enforcement is off" bypass. It must now fail
  // closed (a synthetic org-enforced deny policy) exactly like the API-key
  // path always did, and the incident must be logged loudly (error, not warn).

  it("fails closed (deny policy, not EMPTY_AUTHZ) for a HUMAN SESSION when Postgres throws 42P01", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("relation does not exist"), {
          code: "42P01",
        });
        throw err;
      },
    });

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    // Must NOT degrade to EMPTY_AUTHZ/defaultEffect — a synthetic deny policy
    // that resolve()'s rule 2 (org enforced deny) treats as a hard stop.
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      capabilityId: "send_message",
      scopeKind: "org",
      scopeId: "org_1",
      effect: "deny",
      enforced: true,
    });
    expect(result.principal?.kind).toBe("service");
  });

  it("logs the 42P01 fallback at ERROR level (loud alert), not warn", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("relation does not exist"), {
          code: "42P01",
        });
        throw err;
      },
    });

    await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    expect(mocks.loggerError).toHaveBeenCalledOnce();
    const [, message] = mocks.loggerError.mock.calls[0] as [unknown, string];
    expect(message).toMatch(/SECURITY ALERT/i);
    expect(message).toMatch(/42P01/);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("rethrows non-42P01 errors", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("connection refused"), {
          code: "08006",
        });
        throw err;
      },
    });

    await expect(
      fetchAuthz({
        userId: "usr_1",
        apiKeyId: null,
        orgId: "org_1",
        workspaceId: "ws_1",
        capability: "send_message",
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
      capability: "send_message",
    });

    // No selects should have fired — the function returns before any DB queries.
    expect(result.principal).toBeNull();
    expect(result.grants).toHaveLength(0);
    expect(result.roles).toHaveLength(0);
    expect(result.roleGrants).toHaveLength(0);
    expect(result.policies).toHaveLength(0);
  });

  // ── API-key caller authorizes AS ITS CREATOR ─────────────────────────────

  it("resolves an API key to its creator's principal + role grants", async () => {
    const roleRow = {
      id: "role_admin",
      orgId: "org_1",
      name: "Admin",
      scopeKind: "org",
    };
    mocks.dbFn.mockReturnValue(
      buildApiKeyDbMock({
        apiKey: [{ createdByUserId: "usr_creator" }],
        principals: [{ ...PRINCIPAL_ROW, parentUserId: "usr_creator" }],
        roles: [roleRow],
        pra: [{ roleId: "role_admin" }],
        roleGrants: [
          {
            roleId: "role_admin",
            capabilityId: "generate_markdown",
            effect: "allow",
          },
        ],
      }),
    );

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: "aky_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "generate_markdown",
    });

    // The key acts as its creator — a real principal, with the creator's grants.
    expect(result.principal?.id).toBe("prn_internal");
    expect(result.policies).toHaveLength(0);
    expect(result.roleGrants).toHaveLength(1);
    expect(result.roleGrants[0]?.effect).toBe("allow");
    const adminRole = result.roles.find((r) => r.id === "role_admin");
    expect(adminRole?.principalIds).toContain("prn_internal");
  });

  it("fails closed when the API key row is missing / soft-deleted / foreign-org", async () => {
    mocks.dbFn.mockReturnValue(buildApiKeyDbMock({ apiKey: [] }));

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: "aky_gone",
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "generate_markdown",
    });

    expect(result.principal?.kind).toBe("service");
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      capabilityId: "generate_markdown",
      scopeKind: "org",
      scopeId: "org_1",
      effect: "deny",
      enforced: true,
    });
  });

  it("fails closed when the API key has no recorded creator", async () => {
    mocks.dbFn.mockReturnValue(
      buildApiKeyDbMock({ apiKey: [{ createdByUserId: null }] }),
    );

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: "aky_nocreator",
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "generate_markdown",
    });

    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      effect: "deny",
      enforced: true,
    });
  });

  it("fails closed when the key's creator has no principal in this org", async () => {
    mocks.dbFn.mockReturnValue(
      buildApiKeyDbMock({
        apiKey: [{ createdByUserId: "usr_creator" }],
        principals: [],
      }),
    );

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: "aky_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "generate_markdown",
    });

    expect(result.principal?.kind).toBe("service");
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      effect: "deny",
      enforced: true,
    });
  });

  it("fails closed for an API-key caller when IAM tables are missing (42P01)", async () => {
    mocks.dbFn.mockReturnValue({
      select: () => {
        const err = Object.assign(new Error("relation does not exist"), {
          code: "42P01",
        });
        throw err;
      },
    });

    const result = await fetchAuthz({
      userId: null,
      apiKeyId: "aky_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "generate_markdown",
    });

    // Must NOT degrade to EMPTY_AUTHZ (defaultEffect) on the m2m surface.
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0]).toMatchObject({
      effect: "deny",
      enforced: true,
    });
  });

  // ── !principal early return ──────────────────────────────────────────────

  it("returns EMPTY_AUTHZ when no principal row matches the userId in this org", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ principals: [] }));

    const result = await fetchAuthz({
      userId: "usr_unknown",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    expect(result.principal).toBeNull();
    expect(result.grants).toHaveLength(0);
  });

  // ── PRA expiry + workspace scope filter ──────────────────────────────────

  it("maps PRA rows to role principalIds — assigned roles get principalId in list", async () => {
    const roleRow = {
      id: "role_owner",
      orgId: "org_1",
      name: "Owner",
      scopeKind: "org",
    };
    const praRow = { roleId: "role_owner" };

    mocks.dbFn.mockReturnValue(
      buildDbMock({
        roles: [roleRow],
        pra: [praRow],
        roleGrants: [
          {
            roleId: "role_owner",
            capabilityId: "send_message",
            effect: "allow",
          },
        ],
      }),
    );

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    expect(result.principal?.id).toBe("prn_internal");
    // The role should include the principal because the PRA exists.
    const ownerRole = result.roles.find((r) => r.id === "role_owner");
    expect(ownerRole?.principalIds).toContain("prn_internal");
  });

  it("excludes principalId from role when no PRA row matches", async () => {
    const roleRow = {
      id: "role_member",
      orgId: "org_1",
      name: "Member",
      scopeKind: "workspace",
    };
    // No PRA rows for this principal.
    mocks.dbFn.mockReturnValue(buildDbMock({ roles: [roleRow], pra: [] }));

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    const memberRole = result.roles.find((r) => r.id === "role_member");
    // No PRA → principalIds is empty → deny-by-default via role path.
    expect(memberRole?.principalIds).toHaveLength(0);
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it("returns a correctly shaped AuthzData on the happy path", async () => {
    const roleRow = {
      id: "role_admin",
      orgId: "org_1",
      name: "Admin",
      scopeKind: "org",
    };
    const praRow = { roleId: "role_admin" };
    const roleGrantRow = {
      roleId: "role_admin",
      capabilityId: "send_message",
      effect: "allow",
    };
    // grants/policies tables were dropped in migration 0027 (replaced by
    // role-based IAM). fetchAuthz() returns [] for both unconditionally.
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        roles: [roleRow],
        pra: [praRow],
        roleGrants: [roleGrantRow],
      }),
    );

    const result = await fetchAuthz({
      userId: "usr_1",
      apiKeyId: null,
      orgId: "org_1",
      workspaceId: "ws_1",
      capability: "send_message",
    });

    expect(result.principal?.id).toBe("prn_internal");
    expect(result.principal?.kind).toBe("human");
    expect(result.grants).toHaveLength(0);
    expect(result.roleGrants).toHaveLength(1);
    expect(result.roleGrants[0]?.effect).toBe("allow");
    expect(result.policies).toHaveLength(0);
    expect(result.roles).toHaveLength(1);
  });
});
