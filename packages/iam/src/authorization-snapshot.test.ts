// authorization-snapshot.test.ts — unit tests for the PINNED grant ceiling
// (run-evidence 02-run-attempt-foundation-plan.md Task 5).
//
// Written FIRST, per the plan. The properties under test are the ones the spec
// states as acceptance criteria, not implementation details:
//
//   - the ceiling binds the AUTHENTICATED initiating principal
//   - it preserves assignment ids, role ids, conditions, resource scopes, and
//     each per-binding expiry — never a flattened capability allowlist
//   - the whole read (grants + both generation counters) is ONE repeatable-read
//     transaction
//   - a child ceiling is `still-valid parent ∩ current live ∩ child narrowing`:
//     it cannot widen or outlive its parent, and never snapshots fresh grants
//   - a non-active principal cannot anchor a ceiling
//
// The DB is mocked following this package's existing pattern (fetch-authz.test,
// fetch-agent-authz.test): a fake `tx` that returns queued row sets in query
// order. No database is touched.

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  tx: { select: vi.fn(), insert: vi.fn() },
  repeatableReadCalls: 0,
}));

vi.mock("@oxagen/database/tenant", () => ({
  withRepeatableReadTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    mocks.repeatableReadCalls += 1;
    return fn(mocks.tx);
  },
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx),
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  AuthorizationSnapshotError,
  createAgentRunAuthorizationSnapshot,
  createChildRunAuthorizationSnapshot,
  loadAuthorizationSnapshot,
  parseStoredCeiling,
} from "./authorization-snapshot";
import { canonicalGrantCeiling } from "@oxagen/oxagen/iam";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000a2";
const HUMAN_PRN = "00000000-0000-0000-0000-0000000000b1";
const AGENT_PRN = "00000000-0000-0000-0000-0000000000b2";
/** The agent's CREATOR — deliberately never the ceiling's human side. */
const CREATOR_PRN = "00000000-0000-0000-0000-0000000000b9";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const PAST = new Date("2026-07-21T11:00:00.000Z");
const SOON = new Date("2026-07-21T13:00:00.000Z");
const LATER = new Date("2026-07-22T13:00:00.000Z");

const ROLE_ROWS = [
  {
    id: "role_agent",
    name: "Agent Observer",
    scopeKind: "workspace",
    isSystemDefault: true,
  },
  {
    id: "role_human",
    name: "Member",
    scopeKind: "workspace",
    isSystemDefault: true,
  },
  {
    id: "role_unheld",
    name: "Nobody Holds This",
    scopeKind: "org",
    isSystemDefault: false,
  },
];

const GRANT_ROWS = [
  {
    id: "rlg_a_read",
    roleId: "role_agent",
    capabilityId: "test.read",
    effect: "allow",
    conditionsJsonb: { resourceScope: { skills: { slugs: ["s1"] } } },
  },
  {
    id: "rlg_h_read",
    roleId: "role_human",
    capabilityId: "test.read",
    effect: "allow",
    conditionsJsonb: null,
  },
  {
    id: "rlg_unheld",
    roleId: "role_unheld",
    capabilityId: "test.secret",
    effect: "allow",
    conditionsJsonb: null,
  },
];

const ASSIGNMENT_ROWS = [
  {
    id: "pra_agent",
    principalId: AGENT_PRN,
    roleId: "role_agent",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: SOON,
  },
  {
    id: "pra_human",
    principalId: HUMAN_PRN,
    roleId: "role_human",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: null,
  },
];

const ACTIVE_PRINCIPALS = [
  { id: AGENT_PRN, status: "active" },
  { id: HUMAN_PRN, status: "active" },
];

const GENERATION_ROWS = [
  { workspaceId: null, generation: 4 },
  { workspaceId: WS, generation: 9 },
];

/**
 * Queue row sets in query order and record every INSERT. `readLiveAuthority`
 * issues: roles → role_grants → assignments → principals → deny_generations.
 */
function primeDb(resultSets: unknown[][]): { inserts: unknown[] } {
  let idx = 0;
  const inserts: unknown[] = [];
  mocks.tx.select.mockImplementation(() => {
    const rows = resultSets[idx] ?? [];
    idx += 1;
    const terminal = Promise.resolve(rows);
    const where = () =>
      Object.assign(terminal, { limit: () => Promise.resolve(rows) });
    return { from: () => ({ where }) };
  });
  mocks.tx.insert.mockImplementation(() => ({
    values: (v: unknown) => {
      inserts.push(v);
      return {
        returning: () =>
          Promise.resolve([{ id: "uuid-snapshot", publicId: "ras_new" }]),
      };
    },
  }));
  return { inserts };
}

function rootResultSets(
  overrides: {
    roles?: unknown[];
    grants?: unknown[];
    assignments?: unknown[];
    principals?: unknown[];
    generations?: unknown[];
  } = {},
): unknown[][] {
  return [
    overrides.roles ?? ROLE_ROWS,
    overrides.grants ?? GRANT_ROWS,
    overrides.assignments ?? ASSIGNMENT_ROWS,
    overrides.principals ?? ACTIVE_PRINCIPALS,
    overrides.generations ?? GENERATION_ROWS,
  ];
}

const ROOT_ARGS = {
  orgId: ORG,
  workspaceId: WS,
  initiatingPrincipalId: HUMAN_PRN,
  agentPrincipalId: AGENT_PRN,
  now: NOW,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.repeatableReadCalls = 0;
});

// ── Root ceilings ───────────────────────────────────────────────────────────

describe("createAgentRunAuthorizationSnapshot()", () => {
  it("binds the AUTHENTICATED initiating principal, not the agent's creator", async () => {
    primeDb(rootResultSets());
    const binding = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    expect(binding.ceiling.initiatingPrincipalId).toBe(HUMAN_PRN);
    expect(binding.ceiling.initiatingPrincipalId).not.toBe(CREATOR_PRN);
    expect(binding.ceiling.agentPrincipalId).toBe(AGENT_PRN);
  });

  it("reads grants AND both generation counters in ONE repeatable-read transaction", async () => {
    primeDb(rootResultSets());
    const binding = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    // One transaction for the whole read + the insert. Two would mean the
    // ceiling and its generation vector could describe different instants.
    expect(mocks.repeatableReadCalls).toBe(1);
    expect(binding.denyGenerationAtAdmission).toEqual({ org: 4, workspace: 9 });
  });

  it("preserves assignment ids, role ids, conditions, and per-binding expiries", async () => {
    primeDb(rootResultSets());
    const { ceiling } = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    expect(ceiling.assignments).toEqual([
      {
        assignmentId: "pra_agent",
        principalId: AGENT_PRN,
        roleId: "role_agent",
        workspaceId: WS,
        assignedAt: PAST.toISOString(),
        expiresAt: SOON.toISOString(),
      },
      {
        assignmentId: "pra_human",
        principalId: HUMAN_PRN,
        roleId: "role_human",
        workspaceId: WS,
        assignedAt: PAST.toISOString(),
        expiresAt: null,
      },
    ]);

    const readGrant = ceiling.roleGrants.find(
      (g) => g.grantId === "rlg_a_read",
    );
    expect(readGrant?.conditions).toEqual({
      resourceScope: { skills: { slugs: ["s1"] } },
    });
  });

  it("is NOT a flattened capability allowlist — role and grant identity survive", async () => {
    primeDb(rootResultSets());
    const { ceiling } = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    expect(ceiling.roleGrants.map((g) => g.grantId).sort()).toEqual([
      "rlg_a_read",
      "rlg_h_read",
    ]);
    expect(ceiling.roles.map((r) => r.roleId).sort()).toEqual([
      "role_agent",
      "role_human",
    ]);
  });

  it("excludes org roles no ceiling principal holds", async () => {
    primeDb(rootResultSets());
    const { ceiling } = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);
    expect(ceiling.roles.some((r) => r.roleId === "role_unheld")).toBe(false);
    expect(
      ceiling.roleGrants.some((g) => g.capabilityId === "test.secret"),
    ).toBe(false);
  });

  it("drops an assignment that had ALREADY expired — it was never authority", async () => {
    primeDb(
      rootResultSets({
        assignments: [
          { ...ASSIGNMENT_ROWS[0], expiresAt: PAST },
          ASSIGNMENT_ROWS[1],
        ],
      }),
    );
    const { ceiling } = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);
    expect(ceiling.assignments.map((a) => a.assignmentId)).toEqual([
      "pra_human",
    ]);
  });

  it("computes the next validity boundary from the earliest future expiry", async () => {
    primeDb(rootResultSets());
    const binding = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);
    expect(binding.nextValidityBoundaryAt).toBe(SOON.toISOString());
  });

  it("persists the canonical ceiling and both sha256 digests", async () => {
    const { inserts } = primeDb(rootResultSets());
    const binding = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    expect(binding.grantCeilingDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(binding.snapshotPublicId).toBe("ras_new");

    const row = inserts[0] as Record<string, unknown>;
    expect(row["grantCeiling"]).toEqual(canonicalGrantCeiling(binding.ceiling));
    expect(row["orgDenyGeneration"]).toBe(4);
    expect(row["workspaceDenyGeneration"]).toBe(9);
  });

  it("treats a missing generation row as 0 (the app role cannot insert one)", async () => {
    primeDb(rootResultSets({ generations: [] }));
    const binding = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);
    expect(binding.denyGenerationAtAdmission).toEqual({ org: 0, workspace: 0 });
  });

  it("refuses to pin a ceiling for a SUSPENDED principal", async () => {
    primeDb(
      rootResultSets({
        principals: [
          { id: AGENT_PRN, status: "suspended" },
          { id: HUMAN_PRN, status: "active" },
        ],
      }),
    );
    await expect(
      createAgentRunAuthorizationSnapshot(ROOT_ARGS),
    ).rejects.toBeInstanceOf(AuthorizationSnapshotError);
  });

  it("refuses to pin a ceiling for a principal that does not exist", async () => {
    primeDb(
      rootResultSets({ principals: [{ id: AGENT_PRN, status: "active" }] }),
    );
    await expect(
      createAgentRunAuthorizationSnapshot(ROOT_ARGS),
    ).rejects.toMatchObject({ code: "principal_not_found" });
  });

  it("refuses to admit a run when the snapshot INSERT returns no row", async () => {
    primeDb(rootResultSets());
    mocks.tx.insert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }));
    await expect(
      createAgentRunAuthorizationSnapshot(ROOT_ARGS),
    ).rejects.toMatchObject({ code: "insert_failed" });
  });
});

// ── Child ceilings ──────────────────────────────────────────────────────────

/**
 * A parent snapshot row whose stored ceiling holds both principals' bindings
 * and two grants: `test.read` (allow) and `test.mutate` (allow).
 */
function parentRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "uuid-parent",
    publicId: "ras_parent",
    orgId: ORG,
    workspaceId: WS,
    snapshotDigest: `sha256:${"1".repeat(64)}`,
    grantCeilingDigest: `sha256:${"2".repeat(64)}`,
    orgDenyGeneration: 4,
    workspaceDenyGeneration: 9,
    nextValidityBoundaryAt: LATER,
    resolvedAt: PAST,
    grantCeiling: {
      version: 1,
      initiating_principal_id: HUMAN_PRN,
      agent_principal_id: AGENT_PRN,
      roles: [
        {
          role_id: "role_agent",
          name: "Agent Observer",
          scope_kind: "workspace",
          is_system_default: true,
        },
        {
          role_id: "role_human",
          name: "Member",
          scope_kind: "workspace",
          is_system_default: true,
        },
      ],
      assignments: [
        {
          assignment_id: "pra_agent",
          principal_id: AGENT_PRN,
          role_id: "role_agent",
          workspace_id: WS,
          assigned_at: PAST.toISOString(),
          expires_at: null,
        },
        {
          assignment_id: "pra_human",
          principal_id: HUMAN_PRN,
          role_id: "role_human",
          workspace_id: WS,
          assigned_at: PAST.toISOString(),
          expires_at: null,
        },
      ],
      role_grants: [
        {
          grant_id: "rlg_a_read",
          role_id: "role_agent",
          capability_id: "test.read",
          effect: "allow",
          conditions: null,
        },
        {
          grant_id: "rlg_a_mutate",
          role_id: "role_agent",
          capability_id: "test.mutate",
          effect: "allow",
          conditions: null,
        },
      ],
      parent_snapshot_id: null,
      narrowing: null,
    },
    ...overrides,
  };
}

const LIVE_ASSIGNMENTS_FOR_CHILD = [
  {
    id: "pra_agent",
    principalId: AGENT_PRN,
    roleId: "role_agent",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: null,
  },
  {
    id: "pra_human",
    principalId: HUMAN_PRN,
    roleId: "role_human",
    workspaceId: WS,
    assignedAt: PAST,
    expiresAt: null,
  },
];

function childResultSets(
  overrides: {
    parent?: Record<string, unknown>;
    grants?: unknown[];
    assignments?: unknown[];
    principals?: unknown[];
  } = {},
): unknown[][] {
  return [
    [overrides.parent ?? parentRow()],
    ROLE_ROWS,
    overrides.grants ?? [
      {
        id: "rlg_a_read",
        roleId: "role_agent",
        capabilityId: "test.read",
        effect: "allow",
        conditionsJsonb: null,
      },
      {
        id: "rlg_a_mutate",
        roleId: "role_agent",
        capabilityId: "test.mutate",
        effect: "allow",
        conditionsJsonb: null,
      },
    ],
    overrides.assignments ?? LIVE_ASSIGNMENTS_FOR_CHILD,
    overrides.principals ?? ACTIVE_PRINCIPALS,
    GENERATION_ROWS,
  ];
}

describe("createChildRunAuthorizationSnapshot()", () => {
  it("records the parent and never resolves fresh grants: a NEW live grant does not enter the child", async () => {
    primeDb(
      childResultSets({
        grants: [
          {
            id: "rlg_a_read",
            roleId: "role_agent",
            capabilityId: "test.read",
            effect: "allow",
            conditionsJsonb: null,
          },
          {
            id: "rlg_a_mutate",
            roleId: "role_agent",
            capabilityId: "test.mutate",
            effect: "allow",
            conditionsJsonb: null,
          },
          // Granted AFTER the parent was admitted.
          {
            id: "rlg_a_LATE",
            roleId: "role_agent",
            capabilityId: "test.late",
            effect: "allow",
            conditionsJsonb: null,
          },
        ],
      }),
    );

    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: {},
      now: NOW,
    });

    expect(child.ceiling.parentSnapshotId).toBe("ras_parent");
    expect(
      child.ceiling.roleGrants.some((g) => g.capabilityId === "test.late"),
    ).toBe(false);
  });

  it("drops a parent binding whose live assignment has been revoked", async () => {
    primeDb(
      childResultSets({
        assignments: [LIVE_ASSIGNMENTS_FOR_CHILD[1]], // agent assignment gone
      }),
    );

    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: {},
      now: NOW,
    });

    expect(child.ceiling.assignments.map((a) => a.assignmentId)).toEqual([
      "pra_human",
    ]);
    // With the agent's role no longer held, its grants leave the ceiling too.
    expect(child.ceiling.roleGrants).toEqual([]);
  });

  it("takes the NARROWER effect when a live grant has been tightened", async () => {
    primeDb(
      childResultSets({
        grants: [
          {
            id: "rlg_a_read",
            roleId: "role_agent",
            capabilityId: "test.read",
            effect: "allow",
            conditionsJsonb: null,
          },
          {
            id: "rlg_a_mutate",
            roleId: "role_agent",
            capabilityId: "test.mutate",
            // Parent pinned `allow`; live says `deny`.
            effect: "deny",
            conditionsJsonb: null,
          },
        ],
      }),
    );

    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: {},
      now: NOW,
    });

    expect(
      child.ceiling.roleGrants.find((g) => g.grantId === "rlg_a_mutate")
        ?.effect,
    ).toBe("deny");
  });

  it("ADDS a live deny that the parent never had — denies narrow", async () => {
    primeDb(
      childResultSets({
        grants: [
          {
            id: "rlg_a_read",
            roleId: "role_agent",
            capabilityId: "test.read",
            effect: "allow",
            conditionsJsonb: null,
          },
          {
            id: "rlg_a_mutate",
            roleId: "role_agent",
            capabilityId: "test.mutate",
            effect: "allow",
            conditionsJsonb: null,
          },
          {
            id: "rlg_a_NEW_DENY",
            roleId: "role_agent",
            capabilityId: "test.read",
            effect: "deny",
            conditionsJsonb: null,
          },
        ],
      }),
    );

    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: {},
      now: NOW,
    });

    expect(
      child.ceiling.roleGrants.find((g) => g.grantId === "rlg_a_NEW_DENY")
        ?.effect,
    ).toBe("deny");
  });

  it("applies the child's capability allowlist", async () => {
    primeDb(childResultSets());
    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: { capabilityAllowlist: ["test.read"] },
      now: NOW,
    });

    expect(child.ceiling.roleGrants.map((g) => g.capabilityId)).toEqual([
      "test.read",
    ]);
    expect(child.ceiling.narrowing?.capabilityAllowlist).toEqual(["test.read"]);
  });

  it("cannot outlive its parent: the boundary is the EARLIER of the two", async () => {
    primeDb(childResultSets());
    const beyondParent = new Date("2026-07-30T00:00:00.000Z").toISOString();
    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: { expiresAt: beyondParent },
      now: NOW,
    });

    expect(child.ceiling.narrowing?.expiresAt).toBe(LATER.toISOString());
    expect(child.nextValidityBoundaryAt).toBe(LATER.toISOString());
  });

  it("honours a child expiry EARLIER than the parent's", async () => {
    primeDb(childResultSets());
    const child = await createChildRunAuthorizationSnapshot({
      parentSnapshotId: "ras_parent",
      narrowingPolicy: { expiresAt: SOON.toISOString() },
      now: NOW,
    });
    expect(child.nextValidityBoundaryAt).toBe(SOON.toISOString());
  });

  it("refuses to derive from a parent whose validity boundary has passed", async () => {
    primeDb(
      childResultSets({ parent: parentRow({ nextValidityBoundaryAt: PAST }) }),
    );
    await expect(
      createChildRunAuthorizationSnapshot({
        parentSnapshotId: "ras_parent",
        narrowingPolicy: {},
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "parent_expired" });
  });

  it("refuses when the parent snapshot does not exist", async () => {
    primeDb([[]]);
    await expect(
      createChildRunAuthorizationSnapshot({
        parentSnapshotId: "ras_missing",
        narrowingPolicy: {},
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "parent_snapshot_not_found" });
  });

  it("refuses when a ceiling principal has been suspended since admission", async () => {
    primeDb(
      childResultSets({
        principals: [
          { id: AGENT_PRN, status: "suspended" },
          { id: HUMAN_PRN, status: "active" },
        ],
      }),
    );
    await expect(
      createChildRunAuthorizationSnapshot({
        parentSnapshotId: "ras_parent",
        narrowingPolicy: {},
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "principal_inactive" });
  });
});

// ── Reading a stored ceiling back ───────────────────────────────────────────

describe("parseStoredCeiling()", () => {
  it("round-trips a canonical ceiling", async () => {
    primeDb(rootResultSets());
    const { ceiling } = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);
    expect(parseStoredCeiling(canonicalGrantCeiling(ceiling))).toEqual(ceiling);
  });

  it("degrades a corrupt effect to the NARROWER reading rather than throwing", () => {
    const parsed = parseStoredCeiling({
      version: 1,
      initiating_principal_id: HUMAN_PRN,
      agent_principal_id: AGENT_PRN,
      roles: [],
      assignments: [],
      role_grants: [
        {
          grant_id: "rlg_x",
          role_id: "role_x",
          capability_id: "test.read",
          effect: "SOMETHING_ELSE",
          conditions: null,
        },
      ],
      parent_snapshot_id: null,
      narrowing: null,
    });
    expect(parsed.roleGrants[0]?.effect).toBe("deny");
  });

  it("returns an empty ceiling for a non-object payload (fails closed)", () => {
    const parsed = parseStoredCeiling("nonsense");
    expect(parsed.roles).toEqual([]);
    expect(parsed.assignments).toEqual([]);
    expect(parsed.roleGrants).toEqual([]);
    expect(parsed.initiatingPrincipalId).toBe("");
  });
});

// ── Loading a persisted binding back ────────────────────────────────────────

describe("loadAuthorizationSnapshot()", () => {
  // The worker hydrating a claimed run reads its ceiling back from the ROW —
  // it never rebuilds one from current grants, which is what stops a run from
  // silently re-acquiring authority it was not admitted with.

  it("rehydrates the immutable binding from a persisted row", async () => {
    primeDb([[parentRow()]]);

    const binding = await loadAuthorizationSnapshot("ras_parent");

    expect(binding).not.toBeNull();
    expect(binding?.snapshotId).toBe("uuid-parent");
    expect(binding?.snapshotPublicId).toBe("ras_parent");
    expect(binding?.denyGenerationAtAdmission).toEqual({
      org: 4,
      workspace: 9,
    });
    expect(binding?.nextValidityBoundaryAt).toBe(LATER.toISOString());
    // The ceiling comes back as the domain shape, with binding identity intact.
    expect(binding?.ceiling.assignments.map((a) => a.assignmentId)).toEqual([
      "pra_agent",
      "pra_human",
    ]);
    expect(binding?.ceiling.roleGrants.map((g) => g.grantId)).toEqual([
      "rlg_a_read",
      "rlg_a_mutate",
    ]);
  });

  it("accepts an internal UUID as well as a ras_ public id", async () => {
    primeDb([[parentRow()]]);
    const binding = await loadAuthorizationSnapshot("uuid-parent");
    expect(binding?.snapshotPublicId).toBe("ras_parent");
  });

  it("returns null for an unknown snapshot rather than inventing a ceiling", async () => {
    primeDb([[]]);
    expect(await loadAuthorizationSnapshot("ras_missing")).toBeNull();
  });

  it("reads under one repeatable-read snapshot", async () => {
    primeDb([[parentRow()]]);
    await loadAuthorizationSnapshot("ras_parent");
    expect(mocks.repeatableReadCalls).toBe(1);
  });

  it("round-trips a ceiling this module itself persisted", async () => {
    primeDb(rootResultSets());
    const created = await createAgentRunAuthorizationSnapshot(ROOT_ARGS);

    primeDb([
      [
        {
          id: "uuid-snapshot",
          publicId: created.snapshotPublicId,
          orgId: ORG,
          workspaceId: WS,
          snapshotDigest: created.snapshotDigest,
          grantCeilingDigest: created.grantCeilingDigest,
          orgDenyGeneration: 4,
          workspaceDenyGeneration: 9,
          nextValidityBoundaryAt: SOON,
          resolvedAt: NOW,
          grantCeiling: canonicalGrantCeiling(created.ceiling),
        },
      ],
    ]);

    const loaded = await loadAuthorizationSnapshot(created.snapshotPublicId);
    expect(loaded?.ceiling).toEqual(created.ceiling);
    expect(loaded?.grantCeilingDigest).toBe(created.grantCeilingDigest);
  });
});
