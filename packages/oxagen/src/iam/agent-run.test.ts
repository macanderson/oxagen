// agent-run.test.ts — unit tests for the PINNED ceiling + LIVE cache primitives
// (run-evidence 02-run-attempt-foundation-plan.md Task 5; Agent RBAC §3.4/§3.5).
//
// Covers, in the order the spec's guarantees are stated:
//   - canonical ceiling ordering → a stable digest input
//   - pinned expiries retire bindings, and a live replacement cannot revive one
//   - the delegation ceiling itself (agent ∩ human, deny-wins) still holds
//   - pinned ∩ live is an intersection: a later grant cannot widen an admitted
//     run, a live deny narrows it
//   - the live cache re-keys on the generation vector and expires on the clock

import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "../types";
import {
  agentRunLiveCacheKey,
  canonicalGrantCeiling,
  ceilingHumanPrincipal,
  createAgentRunLiveCache,
  evaluatePinnedAndLiveAuthorization,
  narrowerOutcome,
  nextValidityBoundary,
  pinnedCeilingResolverInputs,
  readAgentRunLiveDecision,
  SENTINEL_PRINCIPAL_ID,
  type AgentRunIAMContext,
  type AuthorizationGrantCeiling,
  type CeilingResolverInputs,
} from "./agent-run";

const ORG = "00000000-0000-0000-0000-00000000aa01";
const WS = "00000000-0000-0000-0000-00000000aa02";
const AGENT_PRN = "00000000-0000-0000-0000-00000000ab01";
const HUMAN_PRN = "00000000-0000-0000-0000-00000000ab02";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const PAST = new Date("2026-07-21T11:00:00.000Z").toISOString();
const FUTURE = new Date("2026-07-21T13:00:00.000Z").toISOString();
const FAR_FUTURE = new Date("2026-07-22T13:00:00.000Z").toISOString();

const agentPrincipal: ResolvedPrincipal = {
  id: AGENT_PRN,
  kind: "agent",
  orgId: ORG,
  workspaceId: WS,
};
const humanPrincipal: ResolvedPrincipal = {
  id: HUMAN_PRN,
  kind: "human",
  orgId: ORG,
  workspaceId: WS,
};

const SCOPE = { kind: "workspace" as const, orgId: ORG, workspaceId: WS };

/**
 * Agent is an "Agent Observer" (read allow, mutate deny, deploy
 * require_approval); the human is a "Member" (allow on everything except
 * `test.human_denied`).
 */
function ceiling(
  overrides: Partial<AuthorizationGrantCeiling> = {},
): AuthorizationGrantCeiling {
  return {
    version: 1,
    initiatingPrincipalId: HUMAN_PRN,
    agentPrincipalId: AGENT_PRN,
    roles: [
      {
        roleId: "role_agent",
        name: "Agent Observer",
        scopeKind: "workspace",
        isSystemDefault: true,
      },
      {
        roleId: "role_human",
        name: "Member",
        scopeKind: "workspace",
        isSystemDefault: true,
      },
    ],
    assignments: [
      {
        assignmentId: "pra_agent",
        principalId: AGENT_PRN,
        roleId: "role_agent",
        workspaceId: WS,
        assignedAt: PAST,
        expiresAt: null,
      },
      {
        assignmentId: "pra_human",
        principalId: HUMAN_PRN,
        roleId: "role_human",
        workspaceId: WS,
        assignedAt: PAST,
        expiresAt: null,
      },
    ],
    roleGrants: [
      {
        grantId: "rlg_a_read",
        roleId: "role_agent",
        capabilityId: "test.read",
        effect: "allow",
        conditions: null,
      },
      {
        grantId: "rlg_h_read",
        roleId: "role_human",
        capabilityId: "test.read",
        effect: "allow",
        conditions: null,
      },
      {
        grantId: "rlg_a_mutate",
        roleId: "role_agent",
        capabilityId: "test.mutate",
        effect: "deny",
        conditions: null,
      },
      {
        grantId: "rlg_h_mutate",
        roleId: "role_human",
        capabilityId: "test.mutate",
        effect: "allow",
        conditions: null,
      },
      {
        grantId: "rlg_a_deploy",
        roleId: "role_agent",
        capabilityId: "test.deploy",
        effect: "require_approval",
        conditions: null,
      },
      {
        grantId: "rlg_h_deploy",
        roleId: "role_human",
        capabilityId: "test.deploy",
        effect: "allow",
        conditions: null,
      },
      {
        grantId: "rlg_a_hd",
        roleId: "role_agent",
        capabilityId: "test.human_denied",
        effect: "allow",
        conditions: null,
      },
      {
        grantId: "rlg_h_hd",
        roleId: "role_human",
        capabilityId: "test.human_denied",
        effect: "deny",
        conditions: null,
      },
    ],
    parentSnapshotId: null,
    narrowing: null,
    ...overrides,
  };
}

function evaluate(args: {
  capability: string;
  defaultEffect: "allow" | "deny";
  pinned: CeilingResolverInputs | null;
  live: CeilingResolverInputs;
  human?: ResolvedPrincipal;
}) {
  return evaluatePinnedAndLiveAuthorization({
    capability: args.capability,
    scope: SCOPE,
    defaultEffect: args.defaultEffect,
    agentPrincipal,
    humanPrincipal: args.human ?? humanPrincipal,
    pinned: args.pinned,
    live: args.live,
    now: NOW,
    clientIp: null,
  });
}

// ── Canonical ordering ──────────────────────────────────────────────────────

describe("canonicalGrantCeiling()", () => {
  it("sorts roles, assignments, and grants so the digest input is stable", () => {
    const base = ceiling();
    const shuffled = ceiling({
      roles: [...base.roles].reverse(),
      assignments: [...base.assignments].reverse(),
      roleGrants: [...base.roleGrants].reverse(),
    });
    expect(canonicalGrantCeiling(shuffled)).toEqual(
      canonicalGrantCeiling(base),
    );
  });

  it("preserves assignment ids, expiries, and grant conditions verbatim", () => {
    const canonical = canonicalGrantCeiling(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: FUTURE,
          },
        ],
        roleGrants: [
          {
            grantId: "rlg_a_read",
            roleId: "role_agent",
            capabilityId: "test.read",
            effect: "allow",
            conditions: { resourceScope: { skills: { slugs: ["s1"] } } },
          },
        ],
      }),
    );

    expect(canonical["assignments"]).toEqual([
      {
        assignment_id: "pra_agent",
        principal_id: AGENT_PRN,
        role_id: "role_agent",
        workspace_id: WS,
        assigned_at: PAST,
        expires_at: FUTURE,
      },
    ]);
    expect(
      (canonical["role_grants"] as Record<string, unknown>[])[0]?.[
        "conditions"
      ],
    ).toEqual({ resourceScope: { skills: { slugs: ["s1"] } } });
  });

  it("emits null (never undefined) for an absent narrowing — undefined is not canonicalizable", () => {
    expect(canonicalGrantCeiling(ceiling())["narrowing"]).toBeNull();
  });
});

// ── Pinned projection ───────────────────────────────────────────────────────

describe("pinnedCeilingResolverInputs()", () => {
  it("keeps an assignment whose expiry is still in the future", () => {
    const inputs = pinnedCeilingResolverInputs(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: FUTURE,
          },
        ],
      }),
      NOW,
    );
    expect(
      inputs.roles.find((r) => r.id === "role_agent")?.principalIds,
    ).toEqual([AGENT_PRN]);
  });

  it("drops an expired assignment", () => {
    const inputs = pinnedCeilingResolverInputs(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: PAST,
          },
        ],
      }),
      NOW,
    );
    expect(
      inputs.roles.find((r) => r.id === "role_agent")?.principalIds,
    ).toEqual([]);
  });

  it("drops an assignment whose pinned expiry is unparseable (fails closed)", () => {
    const inputs = pinnedCeilingResolverInputs(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: "not-a-date",
          },
        ],
      }),
      NOW,
    );
    expect(
      inputs.roles.find((r) => r.id === "role_agent")?.principalIds,
    ).toEqual([]);
  });

  it("applies a child narrowing's capability allowlist", () => {
    const inputs = pinnedCeilingResolverInputs(
      ceiling({ narrowing: { capabilityAllowlist: ["test.read"] } }),
      NOW,
    );
    expect(inputs.roleGrants.every((g) => g.capabilityId === "test.read")).toBe(
      true,
    );
  });
});

describe("nextValidityBoundary()", () => {
  it("returns the earliest FUTURE expiry across assignments and narrowing", () => {
    const boundary = nextValidityBoundary(
      ceiling({
        assignments: [
          {
            assignmentId: "a1",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: FAR_FUTURE,
          },
          {
            assignmentId: "a2",
            principalId: HUMAN_PRN,
            roleId: "role_human",
            workspaceId: WS,
            assignedAt: PAST,
            // Already gone — must not become the boundary.
            expiresAt: PAST,
          },
        ],
        narrowing: { expiresAt: FUTURE },
      }),
      NOW,
    );
    expect(boundary).toBe(FUTURE);
  });

  it("returns null when nothing in the ceiling expires on a clock", () => {
    expect(nextValidityBoundary(ceiling(), NOW)).toBeNull();
  });
});

// ── The delegation ceiling still holds ──────────────────────────────────────

describe("evaluatePinnedAndLiveAuthorization() — agent ∩ human", () => {
  const inputs = () => pinnedCeilingResolverInputs(ceiling(), NOW);

  it("allows when both sides of the delegation ceiling allow", () => {
    const result = evaluate({
      capability: "test.read",
      defaultEffect: "deny",
      pinned: inputs(),
      live: inputs(),
    });
    expect(result.outcome).toBe("allow");
  });

  it("deny-wins: the agent's role deny beats the human's allow", () => {
    const result = evaluate({
      capability: "test.mutate",
      defaultEffect: "allow",
      pinned: inputs(),
      live: inputs(),
    });
    expect(result.outcome).toBe("deny");
    expect(result.pinnedPermissions?.agentResolution.outcome).toBe("deny");
    expect(result.pinnedPermissions?.humanResolution.outcome).toBe("allow");
  });

  it("the human's deny caps an agent allow", () => {
    const result = evaluate({
      capability: "test.human_denied",
      defaultEffect: "allow",
      pinned: inputs(),
      live: inputs(),
    });
    expect(result.outcome).toBe("deny");
    expect(result.pinnedPermissions?.agentResolution.outcome).toBe("allow");
    expect(result.pinnedPermissions?.humanResolution.outcome).toBe("deny");
  });

  it("require_approval survives the merge as pending_approval", () => {
    const result = evaluate({
      capability: "test.deploy",
      defaultEffect: "allow",
      pinned: inputs(),
      live: inputs(),
    });
    expect(result.outcome).toBe("pending_approval");
  });

  it("a null human principal resolves as the unprivileged sentinel", () => {
    const runCtx: AgentRunIAMContext = {
      principalKind: "agent",
      agentPrincipal,
      humanPrincipal: null,
      agentId: "agt_test",
      runId: "run_test",
    };
    const sentinel = ceilingHumanPrincipal(runCtx);
    expect(sentinel.id).toBe(SENTINEL_PRINCIPAL_ID);

    // defaultEffect deny: the agent's own role allows, but the sentinel human
    // side falls through to deny — fail closed without a delegator.
    const result = evaluate({
      capability: "test.read",
      defaultEffect: "deny",
      pinned: inputs(),
      live: inputs(),
      human: sentinel,
    });
    expect(result.outcome).toBe("deny");
  });
});

// ── The asymmetry: later grants cannot widen, live denies narrow ────────────

describe("evaluatePinnedAndLiveAuthorization() — pinned ∩ live", () => {
  it("a grant issued AFTER admission cannot widen an active run", () => {
    // Pinned ceiling has no grant for test.late; live has an explicit allow.
    const pinned = pinnedCeilingResolverInputs(ceiling(), NOW);
    const live = pinnedCeilingResolverInputs(
      ceiling({
        roleGrants: [
          ...ceiling().roleGrants,
          {
            grantId: "rlg_late_a",
            roleId: "role_agent",
            capabilityId: "test.late",
            effect: "allow",
            conditions: null,
          },
          {
            grantId: "rlg_late_h",
            roleId: "role_human",
            capabilityId: "test.late",
            effect: "allow",
            conditions: null,
          },
        ],
      }),
      NOW,
    );

    const result = evaluate({
      capability: "test.late",
      defaultEffect: "deny",
      pinned,
      live,
    });
    expect(result.outcome).toBe("deny");
    expect(result.narrowedBy).toBe("pinned");
    expect(result.livePermissions.outcome).toBe("allow");
  });

  it("a live deny narrows a capability the pinned ceiling allowed", () => {
    const pinned = pinnedCeilingResolverInputs(ceiling(), NOW);
    const live = pinnedCeilingResolverInputs(
      ceiling({
        roleGrants: ceiling().roleGrants.map((g) =>
          g.grantId === "rlg_a_read" ? { ...g, effect: "deny" as const } : g,
        ),
      }),
      NOW,
    );

    const result = evaluate({
      capability: "test.read",
      defaultEffect: "deny",
      pinned,
      live,
    });
    expect(result.outcome).toBe("deny");
    expect(result.narrowedBy).toBe("live");
    expect(result.pinnedPermissions?.outcome).toBe("allow");
  });

  it("a REPLACEMENT assignment cannot revive an expired member of the ceiling", () => {
    // The pinned agent assignment expired an hour ago. A brand-new live
    // assignment (different id) grants the same role again.
    const pinned = pinnedCeilingResolverInputs(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: PAST,
          },
          {
            assignmentId: "pra_human",
            principalId: HUMAN_PRN,
            roleId: "role_human",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: null,
          },
        ],
      }),
      NOW,
    );
    const live = pinnedCeilingResolverInputs(
      ceiling({
        assignments: [
          {
            assignmentId: "pra_agent_REISSUED",
            principalId: AGENT_PRN,
            roleId: "role_agent",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: null,
          },
          {
            assignmentId: "pra_human",
            principalId: HUMAN_PRN,
            roleId: "role_human",
            workspaceId: WS,
            assignedAt: PAST,
            expiresAt: null,
          },
        ],
      }),
      NOW,
    );

    const result = evaluate({
      capability: "test.read",
      defaultEffect: "deny",
      pinned,
      live,
    });
    expect(result.livePermissions.outcome).toBe("allow");
    expect(result.outcome).toBe("deny");
    expect(result.narrowedBy).toBe("pinned");
  });

  it("resolves live-only when the run carries no pinned ceiling (legacy V1)", () => {
    const live = pinnedCeilingResolverInputs(ceiling(), NOW);
    const result = evaluate({
      capability: "test.read",
      defaultEffect: "deny",
      pinned: null,
      live,
    });
    expect(result.outcome).toBe("allow");
    expect(result.narrowedBy).toBe("live");
    expect(result.pinnedPermissions).toBeNull();
  });
});

describe("narrowerOutcome()", () => {
  it("never widens", () => {
    expect(narrowerOutcome("allow", "deny")).toBe("deny");
    expect(narrowerOutcome("deny", "allow")).toBe("deny");
    expect(narrowerOutcome("allow", "pending_approval")).toBe(
      "pending_approval",
    );
    expect(narrowerOutcome("pending_approval", "deny")).toBe("deny");
    expect(narrowerOutcome("allow", "allow")).toBe("allow");
  });
});

// ── The live cache ──────────────────────────────────────────────────────────

describe("agentRunLiveCacheKey() / readAgentRunLiveDecision()", () => {
  const keyArgs = {
    denyGeneration: { org: 4, workspace: 7 },
    capability: "test.read",
    resourceScopeDigest: null,
    clientIp: null,
    nextValidityBoundaryAt: null,
  };

  it("changes when the deny generation moves — a bump forces re-evaluation", () => {
    const before = agentRunLiveCacheKey(keyArgs);
    const afterOrgBump = agentRunLiveCacheKey({
      ...keyArgs,
      denyGeneration: { org: 5, workspace: 7 },
    });
    const afterWsBump = agentRunLiveCacheKey({
      ...keyArgs,
      denyGeneration: { org: 4, workspace: 8 },
    });
    expect(afterOrgBump).not.toBe(before);
    expect(afterWsBump).not.toBe(before);
  });

  it("changes on capability, resource scope, client IP, and validity boundary", () => {
    const before = agentRunLiveCacheKey(keyArgs);
    expect(
      agentRunLiveCacheKey({ ...keyArgs, capability: "test.mutate" }),
    ).not.toBe(before);
    expect(
      agentRunLiveCacheKey({
        ...keyArgs,
        resourceScopeDigest: `sha256:${"a".repeat(64)}`,
      }),
    ).not.toBe(before);
    expect(agentRunLiveCacheKey({ ...keyArgs, clientIp: "1.2.3.4" })).not.toBe(
      before,
    );
    expect(
      agentRunLiveCacheKey({ ...keyArgs, nextValidityBoundaryAt: FUTURE }),
    ).not.toBe(before);
  });

  it("serves an entry inside its validity window and drops it once crossed", () => {
    const cache = createAgentRunLiveCache();
    const key = agentRunLiveCacheKey({
      ...keyArgs,
      nextValidityBoundaryAt: FUTURE,
    });
    cache.set(key, {
      outcome: "allow",
      resourceScope: {},
      decision: null,
      evaluatedAt: NOW,
      validUntil: new Date(FUTURE),
    });

    expect(readAgentRunLiveDecision(cache, key, NOW)?.outcome).toBe("allow");

    // One millisecond past the boundary: gone, and evicted so it cannot be
    // served again even if the clock jitters back.
    const past = new Date(Date.parse(FUTURE) + 1);
    expect(readAgentRunLiveDecision(cache, key, past)).toBeUndefined();
    expect(cache.has(key)).toBe(false);
  });

  it("keeps an entry with no boundary until its key stops matching", () => {
    const cache = createAgentRunLiveCache();
    const key = agentRunLiveCacheKey(keyArgs);
    cache.set(key, {
      outcome: "allow",
      resourceScope: {},
      decision: null,
      evaluatedAt: NOW,
      validUntil: null,
    });
    const muchLater = new Date("2027-01-01T00:00:00.000Z");
    expect(readAgentRunLiveDecision(cache, key, muchLater)?.outcome).toBe(
      "allow",
    );
  });
});
