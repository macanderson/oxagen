// live-agent-run-authorization.test.ts — unit tests for the LIVE deny check
// (run-evidence 02-run-attempt-foundation-plan.md Task 5).
//
// The properties under test are the spec's acceptance criteria for a governed
// run's authorization (§"Security and retention rules", criterion 19):
//
//   - a suspension / revocation / emergency deny narrows BEFORE the next
//     operation, because the cache is keyed by the deny-generation vector
//   - a pinned expiry narrows on the clock, with no generation bump to notice
//   - a later grant cannot widen an admitted run
//   - EVERY outcome persists one immutable decision row, and a failed insert
//     denies rather than proceeding
//   - any refresh failure denies
//
// The two I/O seams (`readAuthority`, `persistDecision`) are injected, so these
// tests exercise the real evaluation and caching logic with no DB. The DB is
// mocked only for `persistAuthorizationDecision`'s own row-shape tests.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock("@oxagen/database/tenant", () => ({
  withRepeatableReadTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(mocks.tx),
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks.tx),
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  evaluateAgentRunAuthorization,
  matchEmergencyDeny,
  persistAuthorizationDecision,
  persistedOutcomeOf,
  type ActiveEmergencyDeny,
  type LiveAgentRunAuthority,
  type PersistAuthorizationDecisionArgs,
} from "./live-agent-run-authorization";
import type { LiveAuthorityState } from "./authorization-snapshot";
import type {
  AgentRunIAMContext,
  AuthorizationDecisionRef,
  AuthorizationGrantCeiling,
  DenyGenerationVector,
} from "@oxagen/oxagen/iam";
import type { ResolvedPrincipal } from "@oxagen/oxagen";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000a2";
const HUMAN_PRN = "00000000-0000-0000-0000-0000000000b1";
const AGENT_PRN = "00000000-0000-0000-0000-0000000000b2";
const RUN_ID = "00000000-0000-0000-0000-0000000000c1";
const ATTEMPT_ID = "00000000-0000-0000-0000-0000000000c2";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const PAST = new Date("2026-07-21T11:00:00.000Z");
const SOON = new Date("2026-07-21T13:00:00.000Z");

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
const INPUT_DIGEST = `sha256:${"e".repeat(64)}`;

function ceilingOf(
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
        assignedAt: PAST.toISOString(),
        expiresAt: null,
      },
      {
        assignmentId: "pra_human",
        principalId: HUMAN_PRN,
        roleId: "role_human",
        workspaceId: WS,
        assignedAt: PAST.toISOString(),
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
    ],
    parentSnapshotId: null,
    narrowing: null,
    ...overrides,
  };
}

function runCtx(
  overrides: Partial<AgentRunIAMContext> = {},
): AgentRunIAMContext {
  return {
    principalKind: "agent",
    agentPrincipal,
    humanPrincipal,
    agentId: "agt_test",
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    authorization: {
      snapshotId: "uuid-snapshot",
      snapshotPublicId: "ras_test",
      snapshotDigest: `sha256:${"1".repeat(64)}`,
      grantCeilingDigest: `sha256:${"2".repeat(64)}`,
      ceiling: ceilingOf(),
      denyGenerationAtAdmission: { org: 4, workspace: 9 },
      nextValidityBoundaryAt: null,
      resolvedAt: PAST.toISOString(),
    },
    ...overrides,
  };
}

/** Live rows that mirror the ceiling exactly — nothing has changed since. */
function liveAuthority(
  overrides: Partial<LiveAuthorityState> = {},
): LiveAuthorityState {
  return {
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
    ],
    principals: [
      { principalId: AGENT_PRN, status: "active" },
      { principalId: HUMAN_PRN, status: "active" },
    ],
    denyGeneration: { org: 4, workspace: 9 },
    readAt: NOW,
    ...overrides,
  };
}

function authorityFixture(
  overrides: Partial<LiveAgentRunAuthority> = {},
): LiveAgentRunAuthority {
  return {
    authority: liveAuthority(),
    emergencyDenies: [],
    agentDisabled: false,
    ...overrides,
  };
}

/** Records every persisted decision and mints a distinct reference for each. */
function decisionRecorder() {
  const rows: PersistAuthorizationDecisionArgs[] = [];
  let n = 0;
  const persistDecision = async (
    args: PersistAuthorizationDecisionArgs,
  ): Promise<AuthorizationDecisionRef> => {
    rows.push(args);
    n += 1;
    return {
      publicId: `azd_${n}`,
      outcome: args.outcome,
      decisionDigest: `sha256:${String(n).repeat(64).slice(0, 64)}`,
      denyGeneration: args.denyGeneration,
      decidedAt: NOW.toISOString(),
    };
  };
  return { rows, persistDecision };
}

function evaluate(args: {
  agentRun?: AgentRunIAMContext;
  capability?: string;
  authority?: LiveAgentRunAuthority | (() => Promise<LiveAgentRunAuthority>);
  persistDecision?: ReturnType<typeof decisionRecorder>["persistDecision"];
  now?: Date;
  defaultEffect?: "allow" | "deny";
}) {
  const authority = args.authority ?? authorityFixture();
  return evaluateAgentRunAuthorization({
    agentRun: args.agentRun ?? runCtx(),
    capability: args.capability ?? "test.read",
    scope: SCOPE,
    defaultEffect: args.defaultEffect ?? "deny",
    requestId: "req_1",
    inputDigest: INPUT_DIGEST,
    now: args.now ?? NOW,
    readAuthority:
      typeof authority === "function" ? authority : async () => authority,
    persistDecision: args.persistDecision ?? decisionRecorder().persistDecision,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Happy path + decision persistence ───────────────────────────────────────

describe("evaluateAgentRunAuthorization() — decisions", () => {
  it("allows when the pinned ceiling and live authority both allow", async () => {
    const rec = decisionRecorder();
    const result = await evaluate({ persistDecision: rec.persistDecision });

    expect(result.outcome).toBe("allow");
    expect(result.reason).toBeNull();
    expect(result.decision?.publicId).toBe("azd_1");
    expect(rec.rows).toHaveLength(1);
  });

  it("persists a decision row for an ALLOW as well as a deny", async () => {
    const rec = decisionRecorder();
    await evaluate({ persistDecision: rec.persistDecision });
    expect(rec.rows[0]).toMatchObject({
      outcome: "allow",
      capability: "test.read",
      actorPrincipalId: AGENT_PRN,
      onBehalfOfPrincipalId: HUMAN_PRN,
      inputDigest: INPUT_DIGEST,
    });
  });

  it("binds run + attempt + snapshot together, or none of the three", async () => {
    const rec = decisionRecorder();
    await evaluate({ persistDecision: rec.persistDecision });
    expect(rec.rows[0]?.runBinding).toEqual({
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      authorizationSnapshotId: "uuid-snapshot",
    });

    // Admission-time check: no attempt exists yet, so no partial binding.
    const rec2 = decisionRecorder();
    await evaluate({
      agentRun: runCtx({ attemptId: null }),
      persistDecision: rec2.persistDecision,
    });
    expect(rec2.rows[0]?.runBinding).toBeNull();
  });

  it("records the generation vector it evaluated against", async () => {
    const rec = decisionRecorder();
    const result = await evaluate({ persistDecision: rec.persistDecision });
    expect(rec.rows[0]?.denyGeneration).toEqual({ org: 4, workspace: 9 });
    expect(result.denyGeneration).toEqual({ org: 4, workspace: 9 });
  });

  it("DENIES when the decision row cannot be written", async () => {
    const result = await evaluate({
      persistDecision: async () => {
        throw new Error("insert exploded");
      },
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("decision_not_persisted");
    expect(result.decision).toBeNull();
  });
});

// ── Live narrowing ──────────────────────────────────────────────────────────

describe("evaluateAgentRunAuthorization() — live narrowing", () => {
  it("a SUSPENDED agent principal denies before the next operation", async () => {
    const rec = decisionRecorder();
    const result = await evaluate({
      persistDecision: rec.persistDecision,
      authority: authorityFixture({
        authority: liveAuthority({
          principals: [
            { principalId: AGENT_PRN, status: "suspended" },
            { principalId: HUMAN_PRN, status: "active" },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("principal_suspended");
    expect(rec.rows[0]?.outcome).toBe("deny");
    expect(rec.rows[0]?.reasonCode).toBe("principal_suspended");
  });

  it("a DELETED initiating human denies", async () => {
    const result = await evaluate({
      authority: authorityFixture({
        authority: liveAuthority({
          principals: [
            { principalId: AGENT_PRN, status: "active" },
            { principalId: HUMAN_PRN, status: "deleted" },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("principal_deleted");
  });

  it("a soft-deleted agent row denies even while its principal is active", async () => {
    const result = await evaluate({
      authority: authorityFixture({ agentDisabled: true }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("agent_disabled");
  });

  it("an active emergency deny on the capability denies", async () => {
    const deny: ActiveEmergencyDeny = {
      publicId: "emd_1",
      denyKind: "capability",
      capabilityId: "test.read",
      resourceScopeDigest: null,
      principalId: null,
      reason: "incident 42",
    };
    const result = await evaluate({
      authority: authorityFixture({ emergencyDenies: [deny] }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("emergency_deny");
  });

  it("a revoked live grant narrows a capability the ceiling still pins", async () => {
    const result = await evaluate({
      authority: authorityFixture({
        authority: liveAuthority({
          roleGrants: [
            {
              grantId: "rlg_a_read",
              roleId: "role_agent",
              capabilityId: "test.read",
              effect: "deny",
              conditions: null,
            },
            {
              grantId: "rlg_h_read",
              roleId: "role_human",
              capabilityId: "test.read",
              effect: "allow",
              conditions: null,
            },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("live_denies");
  });

  it("a grant issued AFTER admission cannot widen the run", async () => {
    const result = await evaluate({
      capability: "test.late",
      authority: authorityFixture({
        authority: liveAuthority({
          roleGrants: [
            {
              grantId: "rlg_a_late",
              roleId: "role_agent",
              capabilityId: "test.late",
              effect: "allow",
              conditions: null,
            },
            {
              grantId: "rlg_h_late",
              roleId: "role_human",
              capabilityId: "test.late",
              effect: "allow",
              conditions: null,
            },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("ceiling_denies");
  });

  it("a pinned expiry narrows even though it bumps no generation", async () => {
    const expiredCeiling = ceilingOf({
      assignments: [
        {
          assignmentId: "pra_agent",
          principalId: AGENT_PRN,
          roleId: "role_agent",
          workspaceId: WS,
          assignedAt: PAST.toISOString(),
          expiresAt: PAST.toISOString(),
        },
        {
          assignmentId: "pra_human",
          principalId: HUMAN_PRN,
          roleId: "role_human",
          workspaceId: WS,
          assignedAt: PAST.toISOString(),
          expiresAt: PAST.toISOString(),
        },
      ],
    });
    const ctx = runCtx();
    const result = await evaluate({
      agentRun: {
        ...ctx,
        authorization: { ...ctx.authorization!, ceiling: expiredCeiling },
      },
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("pinned_expired");
  });

  it("ANY refresh failure denies", async () => {
    const rec = decisionRecorder();
    const result = await evaluate({
      persistDecision: rec.persistDecision,
      authority: async () => {
        throw new Error("db unreachable");
      },
    });
    expect(result.outcome).toBe("deny");
    expect(result.reason).toBe("refresh_failed");
    // Still recorded: an unreadable ceiling is a decision, not a silent gap.
    expect(rec.rows[0]?.outcome).toBe("deny");
    expect(rec.rows[0]?.denyGeneration).toEqual({ org: 0, workspace: 0 });
  });
});

// ── The live cache ──────────────────────────────────────────────────────────

describe("evaluateAgentRunAuthorization() — live cache", () => {
  it("serves a repeat check from cache without persisting a second decision", async () => {
    const rec = decisionRecorder();
    const ctx = runCtx();
    const first = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
    });
    const second = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
    });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.decision?.publicId).toBe(first.decision?.publicId);
    expect(rec.rows).toHaveLength(1);
  });

  it("a deny-generation BUMP invalidates the cached allow before the next operation", async () => {
    const rec = decisionRecorder();
    const ctx = runCtx();

    const allowed = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
    });
    expect(allowed.outcome).toBe("allow");

    // The revocation lands: the grant flips to deny AND the trigger bumps the
    // workspace generation in the same transaction.
    const afterRevocation = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
      authority: authorityFixture({
        authority: liveAuthority({
          denyGeneration: { org: 4, workspace: 10 },
          roleGrants: [
            {
              grantId: "rlg_a_read",
              roleId: "role_agent",
              capabilityId: "test.read",
              effect: "deny",
              conditions: null,
            },
          ],
        }),
      }),
    });

    expect(afterRevocation.cached).toBe(false);
    expect(afterRevocation.outcome).toBe("deny");
    expect(rec.rows).toHaveLength(2);
  });

  it("expires a cached allow once the pinned validity boundary is crossed", async () => {
    const rec = decisionRecorder();
    const base = runCtx();
    const ctx: AgentRunIAMContext = {
      ...base,
      authorization: {
        ...base.authorization!,
        ceiling: ceilingOf({
          assignments: [
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
              expiresAt: SOON.toISOString(),
            },
          ],
        }),
        nextValidityBoundaryAt: SOON.toISOString(),
      },
    };

    const before = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
      now: NOW,
    });
    expect(before.outcome).toBe("allow");

    // Nothing bumped a generation — only the clock moved past the boundary.
    const after = await evaluate({
      agentRun: ctx,
      persistDecision: rec.persistDecision,
      now: new Date(SOON.getTime() + 1),
    });
    expect(after.cached).toBe(false);
    expect(after.outcome).toBe("deny");
    expect(after.reason).toBe("pinned_expired");
  });

  it("keys the cache per capability", async () => {
    const rec = decisionRecorder();
    const ctx = runCtx();
    await evaluate({
      agentRun: ctx,
      capability: "test.read",
      persistDecision: rec.persistDecision,
    });
    const other = await evaluate({
      agentRun: ctx,
      capability: "test.other",
      persistDecision: rec.persistDecision,
    });
    expect(other.cached).toBe(false);
    expect(rec.rows).toHaveLength(2);
  });
});

// ── Emergency deny matching ─────────────────────────────────────────────────

describe("matchEmergencyDeny()", () => {
  const capabilityDeny: ActiveEmergencyDeny = {
    publicId: "emd_cap",
    denyKind: "capability",
    capabilityId: "test.read",
    resourceScopeDigest: null,
    principalId: null,
    reason: "incident",
  };
  const scopeDeny: ActiveEmergencyDeny = {
    publicId: "emd_scope",
    denyKind: "resource_scope",
    capabilityId: null,
    resourceScopeDigest: `sha256:${"a".repeat(64)}`,
    principalId: null,
    reason: "incident",
  };

  it("matches an exact capability, never a prefix or glob", () => {
    expect(
      matchEmergencyDeny([capabilityDeny], {
        capability: "test.read",
        resourceScopeDigest: null,
        principalIds: [AGENT_PRN],
      })?.publicId,
    ).toBe("emd_cap");
    expect(
      matchEmergencyDeny([capabilityDeny], {
        capability: "test.read_all",
        resourceScopeDigest: null,
        principalIds: [AGENT_PRN],
      }),
    ).toBeNull();
  });

  it("matches a resource-scope digest", () => {
    expect(
      matchEmergencyDeny([scopeDeny], {
        capability: "anything",
        resourceScopeDigest: `sha256:${"a".repeat(64)}`,
        principalIds: [AGENT_PRN],
      })?.publicId,
    ).toBe("emd_scope");
  });

  it("a principal-scoped deny applies only to that principal", () => {
    const forHuman: ActiveEmergencyDeny = {
      ...capabilityDeny,
      principalId: HUMAN_PRN,
    };
    expect(
      matchEmergencyDeny([forHuman], {
        capability: "test.read",
        resourceScopeDigest: null,
        principalIds: [AGENT_PRN],
      }),
    ).toBeNull();
    expect(
      matchEmergencyDeny([forHuman], {
        capability: "test.read",
        resourceScopeDigest: null,
        principalIds: [AGENT_PRN, HUMAN_PRN],
      }),
    ).not.toBeNull();
  });
});

// ── The decision row itself ─────────────────────────────────────────────────

describe("persistAuthorizationDecision()", () => {
  function primeInsert(): { values: Record<string, unknown>[] } {
    const values: Record<string, unknown>[] = [];
    mocks.tx.insert.mockImplementation(() => ({
      values: (v: Record<string, unknown>) => {
        values.push(v);
        return {
          returning: () => Promise.resolve([{ publicId: "azd_persisted" }]),
        };
      },
    }));
    return { values };
  }

  const denyGeneration: DenyGenerationVector = { org: 4, workspace: 9 };

  const baseArgs: PersistAuthorizationDecisionArgs = {
    orgId: ORG,
    workspaceId: WS,
    capability: "test.read",
    requestId: "req_1",
    actorPrincipalId: AGENT_PRN,
    onBehalfOfPrincipalId: HUMAN_PRN,
    resourceScopeDigest: null,
    runBinding: {
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      authorizationSnapshotId: "uuid-snapshot",
    },
    denyGeneration,
    outcome: "allow",
    reasonCode: null,
    approvalRequestId: null,
    inputDigest: INPUT_DIGEST,
    traceDigest: null,
    decidedAt: NOW,
  };

  it("writes a sha256 decision digest and returns the azd_ reference", async () => {
    const { values } = primeInsert();
    const ref = await persistAuthorizationDecision(baseArgs);

    expect(ref.publicId).toBe("azd_persisted");
    expect(ref.decisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(values[0]?.["decisionDigest"]).toBe(ref.decisionDigest);
    expect(values[0]?.["scopeKind"]).toBe("workspace");
    expect(values[0]?.["workspaceDenyGeneration"]).toBe(9);
  });

  it("is deterministic: identical inputs produce identical digests", async () => {
    primeInsert();
    const a = await persistAuthorizationDecision(baseArgs);
    const b = await persistAuthorizationDecision(baseArgs);
    expect(b.decisionDigest).toBe(a.decisionDigest);
  });

  it("changes the digest when the generation vector changes", async () => {
    primeInsert();
    const a = await persistAuthorizationDecision(baseArgs);
    const b = await persistAuthorizationDecision({
      ...baseArgs,
      denyGeneration: { org: 5, workspace: 9 },
    });
    expect(b.decisionDigest).not.toBe(a.decisionDigest);
  });

  it("records NULL (not 0) as the workspace generation for an org-scoped decision", async () => {
    const { values } = primeInsert();
    await persistAuthorizationDecision({
      ...baseArgs,
      workspaceId: null,
      runBinding: null,
    });
    expect(values[0]?.["scopeKind"]).toBe("org");
    expect(values[0]?.["workspaceDenyGeneration"]).toBeNull();
  });

  it("throws when the INSERT returns no row — callers must treat that as a deny", async () => {
    mocks.tx.insert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }));
    await expect(persistAuthorizationDecision(baseArgs)).rejects.toThrow(
      /unrecorded/,
    );
  });
});

describe("persistedOutcomeOf()", () => {
  it("maps pending_approval onto the table's approval_pending vocabulary", () => {
    expect(persistedOutcomeOf("pending_approval")).toBe("approval_pending");
    expect(persistedOutcomeOf("allow")).toBe("allow");
    expect(persistedOutcomeOf("deny")).toBe("deny");
  });
});
