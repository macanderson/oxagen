// fetch-agent-authz.test.ts — unit tests for the LIVE authority read
// (Agent RBAC Phase 2; run-evidence Task 5).
//
// Tests:
//   - fetchAgentRunLiveAuthority preserves assignment ids, expiries, grant
//     conditions, principal status, and the deny-generation vector — the
//     columns a pinned ceiling is built from
//   - fetchAgentRunAuthz flattens that into pure-resolver inputs, dropping
//     expired assignments
//   - null humanPrincipalId (no delegator) still resolves
//   - no roles in the org → no role_grants query, empty inputs
//   - 42P01 (IAM tables missing) THROWS after a loud error log — the kernel
//     fails closed on a check-fn throw

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

vi.mock("@oxagen/database/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database/tenant")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
    withRepeatableReadTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(mocks.dbFn()),
  };
});

vi.mock("./logger", () => ({
  logger: { error: mocks.loggerError, warn: mocks.loggerWarn, info: vi.fn() },
}));

import {
  fetchAgentRunAuthz,
  fetchAgentRunLiveAuthority,
} from "./fetch-agent-authz";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = "org_agent_authz";
const WS = "ws_agent_authz";
const AGENT_PRN = "prn_agent";
const HUMAN_PRN = "prn_human";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const PAST = new Date("2026-07-21T11:00:00.000Z");
const FUTURE = new Date("2026-07-21T13:00:00.000Z");

const ROLE_ROWS = [
  {
    id: "role_a",
    name: "Agent Observer",
    scopeKind: "workspace",
    isSystemDefault: true,
  },
  {
    id: "role_h",
    name: "Member",
    scopeKind: "workspace",
    isSystemDefault: true,
  },
];

const GRANT_ROWS = [
  {
    id: "rlg_1",
    roleId: "role_a",
    capabilityId: "cap.one",
    effect: "deny",
    conditionsJsonb: null,
  },
  {
    id: "rlg_2",
    roleId: "role_h",
    capabilityId: "cap.two",
    effect: "allow",
    conditionsJsonb: { resourceScope: { skills: { slugs: ["s1"] } } },
  },
];

const ASSIGNMENT_ROWS = [
  {
    id: "pra_a",
    principalId: AGENT_PRN,
    roleId: "role_a",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: FUTURE,
  },
  {
    id: "pra_h",
    principalId: HUMAN_PRN,
    roleId: "role_h",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: null,
  },
];

const PRINCIPAL_ROWS = [
  { id: AGENT_PRN, status: "active" },
  { id: HUMAN_PRN, status: "active" },
];

const GENERATION_ROWS = [
  { workspaceId: null, generation: 2 },
  { workspaceId: WS, generation: 11 },
];

/**
 * Fake tx: sequences results by select() call order. `readLiveAuthority`'s
 * query order is roles → role_grants → assignments → principals →
 * deny_generations. When the org has no roles, query 2 never fires and every
 * later query shifts up one — hence an explicit sequence rather than a switch.
 */
function buildDbMock(results: unknown[][]) {
  let idx = 0;
  return {
    select: () => {
      const rows = results[idx] ?? [];
      idx += 1;
      return { from: () => ({ where: () => Promise.resolve(rows) }) };
    },
  };
}

function fullSequence(): unknown[][] {
  return [
    ROLE_ROWS,
    GRANT_ROWS,
    ASSIGNMENT_ROWS,
    PRINCIPAL_ROWS,
    GENERATION_ROWS,
  ];
}

const ARGS = {
  orgId: ORG,
  workspaceId: WS,
  agentPrincipalId: AGENT_PRN,
  humanPrincipalId: HUMAN_PRN as string | null,
  now: NOW,
};

describe("fetchAgentRunLiveAuthority()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves assignment ids, expiries, grant conditions, and the generation vector", async () => {
    mocks.dbFn.mockReturnValue(buildDbMock(fullSequence()));

    const authority = await fetchAgentRunLiveAuthority(ARGS);

    expect(authority.assignments).toEqual([
      {
        assignmentId: "pra_a",
        principalId: AGENT_PRN,
        roleId: "role_a",
        workspaceId: WS,
        assignedAt: PAST,
        expiresAt: FUTURE,
      },
      {
        assignmentId: "pra_h",
        principalId: HUMAN_PRN,
        roleId: "role_h",
        workspaceId: WS,
        assignedAt: PAST,
        expiresAt: null,
      },
    ]);
    expect(authority.roleGrants[1]).toMatchObject({
      grantId: "rlg_2",
      conditions: { resourceScope: { skills: { slugs: ["s1"] } } },
    });
    expect(authority.principals).toEqual([
      { principalId: AGENT_PRN, status: "active" },
      { principalId: HUMAN_PRN, status: "active" },
    ]);
    expect(authority.denyGeneration).toEqual({ org: 2, workspace: 11 });
  });

  it("reports a missing generation row as 0 rather than inventing one", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([ROLE_ROWS, GRANT_ROWS, ASSIGNMENT_ROWS, PRINCIPAL_ROWS, []]),
    );
    const authority = await fetchAgentRunLiveAuthority(ARGS);
    expect(authority.denyGeneration).toEqual({ org: 0, workspace: 0 });
  });
});

describe("fetchAgentRunAuthz()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flattens live rows into resolver inputs with per-principal memberships", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([
        ROLE_ROWS,
        GRANT_ROWS,
        [
          ...ASSIGNMENT_ROWS,
          // Shared role membership: the agent also holds the human's role.
          {
            id: "pra_shared",
            principalId: AGENT_PRN,
            roleId: "role_h",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: null,
          },
        ],
        PRINCIPAL_ROWS,
        GENERATION_ROWS,
      ]),
    );

    const inputs = await fetchAgentRunAuthz(ARGS);

    expect(inputs.grants).toEqual([]);
    expect(inputs.policies).toEqual([]);

    const roleA = inputs.roles.find((r) => r.id === "role_a");
    const roleH = inputs.roles.find((r) => r.id === "role_h");
    expect(roleA?.principalIds).toEqual([AGENT_PRN]);
    expect(roleH?.principalIds).toEqual(
      expect.arrayContaining([HUMAN_PRN, AGENT_PRN]),
    );
    expect(roleA?.isSystemDefault).toBe(true);

    expect(inputs.roleGrants).toHaveLength(2);
    expect(inputs.roleGrants[0]).toMatchObject({
      roleId: "role_a",
      capabilityId: "cap.one",
      effect: "deny",
    });
    expect(inputs.roleGrants[1]?.conditionsJsonb).toEqual({
      resourceScope: { skills: { slugs: ["s1"] } },
    });
  });

  it("drops an assignment that has already expired", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([
        ROLE_ROWS,
        GRANT_ROWS,
        [{ ...ASSIGNMENT_ROWS[0], expiresAt: PAST }, ASSIGNMENT_ROWS[1]],
        PRINCIPAL_ROWS,
        GENERATION_ROWS,
      ]),
    );

    const inputs = await fetchAgentRunAuthz(ARGS);
    expect(inputs.roles.find((r) => r.id === "role_a")?.principalIds).toEqual(
      [],
    );
  });

  it("resolves with a null humanPrincipalId (no delegator)", async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock([
        ROLE_ROWS,
        GRANT_ROWS,
        [ASSIGNMENT_ROWS[0]],
        [PRINCIPAL_ROWS[0]],
        GENERATION_ROWS,
      ]),
    );

    const inputs = await fetchAgentRunAuthz({
      ...ARGS,
      humanPrincipalId: null,
    });

    expect(inputs.roles.find((r) => r.id === "role_a")?.principalIds).toEqual([
      AGENT_PRN,
    ]);
  });

  it("skips the role_grants query when the org has no roles", async () => {
    // Four selects fire: roles (empty), assignments, principals, generations.
    mocks.dbFn.mockReturnValue(
      buildDbMock([[], ASSIGNMENT_ROWS, PRINCIPAL_ROWS, GENERATION_ROWS]),
    );

    const inputs = await fetchAgentRunAuthz(ARGS);

    expect(inputs.roles).toEqual([]);
    expect(inputs.roleGrants).toEqual([]);
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
