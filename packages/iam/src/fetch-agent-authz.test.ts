// fetch-agent-authz.test.ts — unit tests for fetchAgentRunAuthz()
// (Agent RBAC Phase 2).
//
// Tests:
//   - happy path: roles + memberships for BOTH ceiling principals, role
//     grants across all capabilities (with conditionsJsonb passthrough),
//     grants/policies empty (tables dropped in migration 0027)
//   - null humanPrincipalId (no delegator) still resolves
//   - no roles in org → no role_grants query, empty snapshot
//   - 42P01 (IAM tables missing) THROWS after a loud error log — the kernel
//     fails closed on a check-fn throw (OXA-2056 posture)

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: mocks.dbFn,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: mocks.loggerWarn },
}));

import { fetchAgentRunAuthz } from "./fetch-agent-authz";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = "org_agent_authz";
const WS = "ws_agent_authz";
const AGENT_PRN = "prn_agent";
const HUMAN_PRN = "prn_human";

const ROLE_ROWS = [
  {
    id: "role_a",
    publicId: "rol_a",
    name: "Agent Observer",
    scopeKind: "workspace",
    orgId: ORG,
    isSystemDefault: true,
  },
  {
    id: "role_h",
    publicId: "rol_h",
    name: "Member",
    scopeKind: "workspace",
    orgId: ORG,
    isSystemDefault: true,
  },
];

/**
 * Fake tx: sequences results by select() call order. _fetchAgentRunAuthz
 * query order:
 *   1: roles (no limit)
 *   2: roleGrants (no limit — only when roleIds.length > 0)
 *   3: pra (no limit)
 * When there are no roles, query 2 never fires and the pra query becomes
 * select call 2 — the builder takes an explicit sequence instead of a switch.
 */
function buildDbMock(results: unknown[][]) {
  let selectCallIdx = 0;
  const makeChainNoLimit = (rows: unknown[]) => ({
    from: () => ({ where: () => Promise.resolve(rows) }),
  });
  return {
    select: () => {
      const rows = results[selectCallIdx] ?? [];
      selectCallIdx++;
      return makeChainNoLimit(rows);
    },
  };
}

const ARGS = {
  orgId: ORG,
  workspaceId: WS,
  agentPrincipalId: AGENT_PRN,
  humanPrincipalId: HUMAN_PRN as string | null,
};

describe("fetchAgentRunAuthz()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns roles with per-principal memberships and all role grants (conditionsJsonb passthrough)", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([
        ROLE_ROWS,
        [
          { roleId: "role_a", capabilityId: "cap.one", effect: "deny" },
          {
            roleId: "role_h",
            capabilityId: "cap.two",
            effect: "allow",
            conditionsJsonb: { resourceScope: { skills: { slugs: ["s1"] } } },
          },
        ],
        [
          { roleId: "role_a", principalId: AGENT_PRN },
          { roleId: "role_h", principalId: HUMAN_PRN },
          // Shared role membership: both principals hold role_h.
          { roleId: "role_h", principalId: AGENT_PRN },
        ],
      ]),
    );

    const snapshot = await fetchAgentRunAuthz(ARGS);

    expect(snapshot.grants).toEqual([]);
    expect(snapshot.policies).toEqual([]);

    const roleA = snapshot.roles.find((r) => r.id === "role_a");
    const roleH = snapshot.roles.find((r) => r.id === "role_h");
    expect(roleA?.principalIds).toEqual([AGENT_PRN]);
    expect(roleH?.principalIds).toEqual(
      expect.arrayContaining([HUMAN_PRN, AGENT_PRN]),
    );
    expect(roleA?.isSystemDefault).toBe(true);

    expect(snapshot.roleGrants).toHaveLength(2);
    expect(snapshot.roleGrants[0]).toMatchObject({
      roleId: "role_a",
      capabilityId: "cap.one",
      effect: "deny",
    });
    expect(snapshot.roleGrants[1]?.conditionsJsonb).toEqual({
      resourceScope: { skills: { slugs: ["s1"] } },
    });
  });

  it("resolves with a null humanPrincipalId (no delegator)", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([
        ROLE_ROWS,
        [{ roleId: "role_a", capabilityId: "cap.one", effect: "allow" }],
        [{ roleId: "role_a", principalId: AGENT_PRN }],
      ]),
    );

    const snapshot = await fetchAgentRunAuthz({
      ...ARGS,
      humanPrincipalId: null,
    });

    expect(snapshot.roles.find((r) => r.id === "role_a")?.principalIds).toEqual(
      [AGENT_PRN],
    );
  });

  it("skips the role_grants query when the org has no roles", async () => {
    // Only two selects fire: roles (empty) then pra.
    mocks.dbFn.mockReturnValue(buildDbMock([[], []]));

    const snapshot = await fetchAgentRunAuthz(ARGS);

    expect(snapshot.roles).toEqual([]);
    expect(snapshot.roleGrants).toEqual([]);
  });

  it("42P01 (IAM tables missing) THROWS after a loud SECURITY ALERT — the kernel fails closed", async () => {
    const pgErr = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    mocks.dbFn.mockReturnValue({
      select: () => ({
        from: () => ({ where: () => Promise.reject(pgErr) }),
      }),
    });

    await expect(fetchAgentRunAuthz(ARGS)).rejects.toBe(pgErr);

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    const [meta, message] = mocks.loggerError.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(meta["agentPrincipalId"]).toBe(AGENT_PRN);
    expect(message).toContain("SECURITY ALERT");
    expect(message).toContain("failing closed");
  });

  it("propagates a non-42P01 error without the missing-migration alert", async () => {
    const otherErr = new Error("connection refused");
    mocks.dbFn.mockReturnValue({
      select: () => ({
        from: () => ({ where: () => Promise.reject(otherErr) }),
      }),
    });

    await expect(fetchAgentRunAuthz(ARGS)).rejects.toBe(otherErr);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});
