// check-iam.agent.test.ts — Agent RBAC Phase 2 kernel-enforcement tests
// (docs/specs/agent-rbac/spec.md §3.4/§3.5, Phase 2 acceptance).
//
// These run the REAL kernel (invoke() from @oxagen/oxagen) wired to the REAL
// checkIAM via the REAL bootstrapIAMRuntime adapter, with the REAL pure
// resolver — only the I/O seams are mocked (snapshot fetch, human authz
// fetch, audit emission, access-request creation, billing tier). This is the
// spec's acceptance suite:
//
//   - THE POISONED-PROMPT TEST: an agent whose role resolves a mutation
//     capability to deny CANNOT invoke() it even when the capability name is
//     passed directly — blocked at the kernel with a denial audit row, on a
//     NON-enterprise tier (proving the tier fast-path does NOT apply to agent
//     principals).
//   - Human principals at non-enterprise tiers still ride the fast-path
//     (behaviorally untouched).
//   - The run's authz snapshot is fetched ONCE and reused across invoke()s,
//     cached on the run context object itself.
//   - require_approval routes through the SAME approval flow as human
//     require_approval outcomes: JIT access-request creation + a pollable
//     CapabilityError(code="pending_approval").

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "@oxagen/oxagen";
import type {
  AgentRunAuthorizationBinding,
  AgentRunIAMContext,
  AuthorizationGrantCeiling,
} from "@oxagen/oxagen/iam";
import type { AuthzData } from "./fetch-authz";
import type { EmitAuditArgs } from "./emit-audit";

// ── Hoisted mocks (I/O seams only — resolver + kernel are real) ──────────────

const mocks = vi.hoisted(() => ({
  fetchAuthz: vi.fn<(args: unknown) => Promise<AuthzData>>(),
  emitAudit: vi.fn<(args: unknown) => Promise<void>>(),
  createAccessRequest: vi.fn<(args: unknown) => Promise<string | null>>(),
  resolveOrgTier: vi.fn(),
  canAccessACL: vi.fn(),
  captureError: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  decisionRows: [] as Record<string, unknown>[],
  txCalls: 0,
}));

// Only the DATABASE is mocked for the agent path: the live authority read, the
// pinned ∩ live evaluation, the decision insert, the resolver, and the kernel
// are all REAL. That is what makes this an acceptance suite rather than a
// mock-assertion suite.
vi.mock("@oxagen/database/tenant", () => ({
  withRepeatableReadTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
    mocks.txCalls += 1;
    return fn({ select: mocks.select, insert: mocks.insert });
  },
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ select: mocks.select, insert: mocks.insert }),
}));
vi.mock("./fetch-authz", () => ({ fetchAuthz: mocks.fetchAuthz }));
vi.mock("./emit-audit", () => ({ emitAudit: mocks.emitAudit }));
vi.mock("./access-request", () => ({
  createAccessRequest: mocks.createAccessRequest,
}));
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    resolveOrgTier: mocks.resolveOrgTier,
    canAccessACL: mocks.canAccessACL,
  };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, captureError: mocks.captureError };
});

// Import AFTER mocks are wired. Kernel + registry + resolver are REAL.
import { bootstrapIAMRuntime } from "./bootstrap";
import { checkIAM } from "./check-iam";
import {
  CapabilityError,
  clearHandlersForTests,
  clearKernelAccessRequestCreator,
  clearKernelIAMRuntime,
  invoke,
  registerHandler,
} from "@oxagen/oxagen/kernel";
import {
  clearRegistryForTests,
  registerCapability,
} from "@oxagen/oxagen/registry";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-00000000c001";
const WS = "00000000-0000-0000-0000-00000000c002";
const AGENT_PRN = "00000000-0000-0000-0000-00000000c0a1";
const HUMAN_PRN = "00000000-0000-0000-0000-00000000c0a2";

const baseCtx: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: "00000000-0000-0000-0000-00000000c0f1",
  apiKeyId: null,
  requestId: "req_agent_rbac",
  surface: "api",
  messageId: null,
};

/**
 * The pinned ceiling: the agent holds an Observer-style role (read allow,
 * mutation DENY, deploy require_approval) and the invoking human holds a role
 * that allows everything — so any blocked outcome is attributable to the AGENT
 * side of the intersection.
 */
const CEILING: AuthorizationGrantCeiling = {
  version: 1,
  initiatingPrincipalId: HUMAN_PRN,
  agentPrincipalId: AGENT_PRN,
  roles: [
    {
      roleId: "role_agent_observer",
      name: "Agent Observer",
      scopeKind: "workspace",
      isSystemDefault: true,
    },
    {
      roleId: "role_human_member",
      name: "Member",
      scopeKind: "workspace",
      isSystemDefault: true,
    },
  ],
  assignments: [
    {
      assignmentId: "pra_agent",
      principalId: AGENT_PRN,
      roleId: "role_agent_observer",
      workspaceId: WS,
      assignedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: null,
    },
    {
      assignmentId: "pra_human",
      principalId: HUMAN_PRN,
      roleId: "role_human_member",
      workspaceId: WS,
      assignedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: null,
    },
  ],
  roleGrants: [
    {
      grantId: "rlg_a_read",
      roleId: "role_agent_observer",
      capabilityId: "test.agent.read",
      effect: "allow",
      conditions: null,
    },
    {
      grantId: "rlg_h_read",
      roleId: "role_human_member",
      capabilityId: "test.agent.read",
      effect: "allow",
      conditions: null,
    },
    {
      grantId: "rlg_a_mutate",
      roleId: "role_agent_observer",
      capabilityId: "test.agent.mutate",
      effect: "deny",
      conditions: null,
    },
    {
      grantId: "rlg_h_mutate",
      roleId: "role_human_member",
      capabilityId: "test.agent.mutate",
      effect: "allow",
      conditions: null,
    },
    {
      grantId: "rlg_a_deploy",
      roleId: "role_agent_observer",
      capabilityId: "test.agent.deploy",
      effect: "require_approval",
      conditions: null,
    },
    {
      grantId: "rlg_h_deploy",
      roleId: "role_human_member",
      capabilityId: "test.agent.deploy",
      effect: "allow",
      conditions: null,
    },
  ],
  parentSnapshotId: null,
  narrowing: null,
};

const BINDING: AgentRunAuthorizationBinding = {
  snapshotId: "00000000-0000-0000-0000-00000000c0d1",
  snapshotPublicId: "ras_rbac_test",
  snapshotDigest: `sha256:${"1".repeat(64)}`,
  grantCeilingDigest: `sha256:${"2".repeat(64)}`,
  ceiling: CEILING,
  denyGenerationAtAdmission: { org: 3, workspace: 5 },
  nextValidityBoundaryAt: null,
  resolvedAt: "2026-07-01T00:00:00.000Z",
};

function makeAgentRun(): AgentRunIAMContext {
  return {
    principalKind: "agent",
    agentPrincipal: {
      id: AGENT_PRN,
      kind: "agent",
      orgId: ORG,
      workspaceId: WS,
    },
    humanPrincipal: {
      id: HUMAN_PRN,
      kind: "human",
      orgId: ORG,
      workspaceId: WS,
    },
    agentId: "agt_rbac_test",
    runId: "run_rbac_test",
    parentRunId: "run_rbac_parent",
    attemptId: "00000000-0000-0000-0000-00000000c0d2",
    authorization: BINDING,
  };
}

/**
 * Prime the DB mock for `readLiveAgentRunAuthority`, whose query order is:
 * roles → role_grants → assignments → principals → deny_generations →
 * emergency_denies → agents. Then `persistAuthorizationDecision` inserts.
 *
 * By default the live rows MIRROR the pinned ceiling, so the intersection is a
 * no-op and any narrowing in a test is attributable to what that test changed.
 */
function primeLiveAuthority(
  overrides: {
    grants?: unknown[];
    assignments?: unknown[];
    principals?: unknown[];
    generations?: unknown[];
    emergencyDenies?: unknown[];
    agent?: unknown[];
    failReads?: Error;
  } = {},
): void {
  const roles = CEILING.roles.map((r) => ({
    id: r.roleId,
    name: r.name,
    scopeKind: r.scopeKind,
    isSystemDefault: r.isSystemDefault,
  }));
  const grants =
    overrides.grants ??
    CEILING.roleGrants.map((g) => ({
      id: g.grantId,
      roleId: g.roleId,
      capabilityId: g.capabilityId,
      effect: g.effect,
      conditionsJsonb: null,
    }));
  const assignments =
    overrides.assignments ??
    CEILING.assignments.map((a) => ({
      id: a.assignmentId,
      principalId: a.principalId,
      roleId: a.roleId,
      workspaceId: a.workspaceId,
      assignedAt: new Date(a.assignedAt),
      expiresAt: null,
    }));
  const principals = overrides.principals ?? [
    { id: AGENT_PRN, status: "active" },
    { id: HUMAN_PRN, status: "active" },
  ];
  const generations = overrides.generations ?? [
    { workspaceId: null, generation: 3 },
    { workspaceId: WS, generation: 5 },
  ];

  const sequence: unknown[][] = [
    roles,
    grants,
    assignments,
    principals,
    generations,
    overrides.emergencyDenies ?? [],
    overrides.agent ?? [{ deletedAt: null }],
  ];

  let idx = 0;
  mocks.select.mockImplementation(() => {
    if (overrides.failReads) {
      const err = overrides.failReads;
      return {
        from: () => ({
          where: () =>
            Object.assign(Promise.reject(err), {
              limit: () => Promise.reject(err),
            }),
        }),
      };
    }
    const rows = sequence[idx % sequence.length] ?? [];
    idx += 1;
    const terminal = Promise.resolve(rows);
    return {
      from: () => ({
        where: () =>
          Object.assign(terminal, { limit: () => Promise.resolve(rows) }),
      }),
    };
  });

  mocks.insert.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      mocks.decisionRows.push(v);
      return {
        returning: () =>
          Promise.resolve([{ publicId: `azd_${mocks.decisionRows.length}` }]),
      };
    },
  }));
}

function agentCtx(agentRun: AgentRunIAMContext): CapabilityContext {
  return { ...baseCtx, userId: null, surface: "runner", agentRun };
}

const handlerSpies = {
  read: vi.fn(),
  mutate: vi.fn(),
  deploy: vi.fn(),
};

function registerTestCapabilities(): void {
  const io = {
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
  };
  const common = {
    domain: "test",
    mode: "sync" as const,
    surfaces: ["api", "agent"] as const,
    layers: ["unit"] as const,
    defaultRoles: { org: {}, workspace: {} },
    ...io,
  };
  registerCapability({
    ...common,
    name: "test.agent.read",
    description: "read exemplar",
    sensitivity: "low" as const,
    defaultEffect: "deny" as const,
  });
  registerCapability({
    ...common,
    name: "test.agent.mutate",
    description: "mutation exemplar (poisoned-prompt target)",
    sensitivity: "high" as const,
    // defaultEffect allow — the ONLY thing that can deny this capability is
    // the agent role's explicit deny grant, which is exactly what the
    // poisoned-prompt test must prove bites at the kernel.
    defaultEffect: "allow" as const,
  });
  registerCapability({
    ...common,
    name: "test.agent.deploy",
    description: "escalation exemplar",
    sensitivity: "high" as const,
    defaultEffect: "allow" as const,
  });
  registerHandler("test.agent.read", async () => async (input) => {
    handlerSpies.read(input);
    return input;
  });
  registerHandler("test.agent.mutate", async () => async (input) => {
    handlerSpies.mutate(input);
    return input;
  });
  registerHandler("test.agent.deploy", async () => async (input) => {
    handlerSpies.deploy(input);
    return input;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Agent RBAC Phase 2 — kernel enforcement via checkIAM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decisionRows = [];
    mocks.txCalls = 0;
    mocks.emitAudit.mockResolvedValue(undefined);
    primeLiveAuthority();
    // NON-enterprise tier throughout: humans ride the fast-path, agents must
    // not (spec §3.4 — enforcement runs at every tier).
    mocks.canAccessACL.mockReturnValue(false);
    mocks.resolveOrgTier.mockResolvedValue("build");
    mocks.createAccessRequest.mockResolvedValue(null);
    bootstrapIAMRuntime();
    registerTestCapabilities();
  });

  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearKernelAccessRequestCreator();
  });

  it("POISONED PROMPT: an agent whose role denies a mutation cannot invoke() it directly, on a non-enterprise tier, with a denial audit row", async () => {
    const agentRun = makeAgentRun();

    // The capability name is passed DIRECTLY to invoke() — exactly what a
    // prompt-injected model would do to bypass the materialized tool list.
    await expect(
      invoke("test.agent.mutate", { value: "poisoned" }, agentCtx(agentRun), {
        surface: "agent",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });

    // Blocked BEFORE the handler executed.
    expect(handlerSpies.mutate).not.toHaveBeenCalled();

    // The tier fast-path was NOT consulted for the agent principal — the
    // resolution ran despite the non-enterprise tier (spec §3.4)...
    expect(mocks.canAccessACL).not.toHaveBeenCalled();
    expect(mocks.resolveOrgTier).not.toHaveBeenCalled();
    // ...and the single-principal human fetch path was never used.
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();

    // The denial is on the immutable ledger, not only in the audit stream.
    expect(mocks.decisionRows).toHaveLength(1);
    expect(mocks.decisionRows[0]).toMatchObject({
      outcome: "deny",
      capabilityId: "test.agent.mutate",
      actorPrincipalId: AGENT_PRN,
      onBehalfOfPrincipalId: HUMAN_PRN,
      authorizationSnapshotId: BINDING.snapshotId,
      orgDenyGeneration: 3,
      workspaceDenyGeneration: 5,
    });

    // Denial audit row: principal_kind='agent', run lineage, meterable
    // decision reason, deny outcome.
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.emitAudit.mock.calls[0]?.[0] as EmitAuditArgs;
    expect(audit.capability).toBe("test.agent.mutate");
    expect(audit.principal).toMatchObject({ id: AGENT_PRN, kind: "agent" });
    expect(audit.result.outcome).toBe("deny");
    expect(audit.result.trace.decidedBy.rule).toBe("agent_ceiling:deny");
    expect(audit.humanPrincipalId).toBe(HUMAN_PRN);
    expect(audit.runLineage).toEqual({
      agentId: "agt_rbac_test",
      runId: "run_rbac_test",
      parentRunId: "run_rbac_parent",
    });
  });

  it("human principals at non-enterprise tiers still ride the tier fast-path (unchanged behavior)", async () => {
    // No agentRun on the ctx — plain human invocation. defaultEffect on
    // test.agent.read is "deny", so an allow can ONLY come from the bypass.
    const out = await invoke("test.agent.read", { value: "hi" }, baseCtx, {
      surface: "api",
    });

    expect(out).toEqual({ value: "hi" });
    expect(handlerSpies.read).toHaveBeenCalledTimes(1);
    // Fast-path proof: tier consulted, resolver fetches never ran.
    expect(mocks.canAccessACL).toHaveBeenCalledWith("build");
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
    // No governed-run decision row for human traffic — the human path records
    // its decision in the ClickHouse audit stream, not the run ledger.
    expect(mocks.decisionRows).toHaveLength(0);
    const audit = mocks.emitAudit.mock.calls[0]?.[0] as EmitAuditArgs;
    expect(audit.result.trace.decidedBy.rule).toBe("tier_gate");
  });

  it("re-reads live authority on EVERY invoke, and serves the repeat from the generation-keyed live cache", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    const first = await invoke("test.agent.read", { value: "a" }, ctx, {
      surface: "agent",
    });
    expect(first).toEqual({ value: "a" });

    const txAfterFirst = mocks.txCalls;
    const second = await invoke("test.agent.read", { value: "b" }, ctx, {
      surface: "agent",
    });
    expect(second).toEqual({ value: "b" });

    // The live read ran AGAIN — the once-per-run unrefreshed snapshot is gone.
    expect(mocks.txCalls).toBeGreaterThan(txAfterFirst);
    // The cache lives ON the run context object so tool materialization reads
    // the same decisions the kernel did.
    expect(agentRun.liveCache?.size).toBe(1);
    // One decision row, because the second check hit the cache at the same
    // generation — duplicating rows for an unchanged decision would bury the
    // real transitions.
    expect(mocks.decisionRows).toHaveLength(1);
  });

  it("a deny-generation bump invalidates the cached allow before the next operation", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    await invoke("test.agent.read", { value: "a" }, ctx, { surface: "agent" });
    expect(mocks.decisionRows).toHaveLength(1);
    expect(mocks.decisionRows[0]).toMatchObject({ outcome: "allow" });

    // The revocation lands: the agent's read grant flips to deny AND the
    // trigger bumps the workspace generation in the same transaction.
    primeLiveAuthority({
      grants: CEILING.roleGrants.map((g) =>
        g.grantId === "rlg_a_read"
          ? { ...g, id: g.grantId, effect: "deny", conditionsJsonb: null }
          : { ...g, id: g.grantId, conditionsJsonb: null },
      ),
      generations: [
        { workspaceId: null, generation: 3 },
        { workspaceId: WS, generation: 6 },
      ],
    });

    await expect(
      invoke("test.agent.read", { value: "b" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "authz_denied" });

    expect(mocks.decisionRows).toHaveLength(2);
    expect(mocks.decisionRows[1]).toMatchObject({
      outcome: "deny",
      workspaceDenyGeneration: 6,
    });
  });

  it("a SUSPENDED agent principal denies the very next operation", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    await invoke("test.agent.read", { value: "a" }, ctx, { surface: "agent" });

    primeLiveAuthority({
      principals: [
        { id: AGENT_PRN, status: "suspended" },
        { id: HUMAN_PRN, status: "active" },
      ],
      generations: [
        { workspaceId: null, generation: 3 },
        { workspaceId: WS, generation: 7 },
      ],
    });

    await expect(
      invoke("test.agent.read", { value: "b" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.decisionRows[1]).toMatchObject({
      outcome: "deny",
      reasonCode: "principal_suspended",
    });
  });

  it("an active emergency deny narrows the run before its next operation", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    primeLiveAuthority({
      emergencyDenies: [
        {
          publicId: "emd_incident",
          denyKind: "capability",
          capabilityId: "test.agent.read",
          resourceScopeDigest: null,
          principalId: null,
          reason: "incident 42",
        },
      ],
    });

    await expect(
      invoke("test.agent.read", { value: "x" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(mocks.decisionRows[0]).toMatchObject({
      outcome: "deny",
      reasonCode: "emergency_deny",
    });
  });

  it("a grant issued AFTER admission cannot widen the run", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    // Live authority now allows test.agent.mutate for BOTH principals — but
    // the pinned ceiling still carries the agent's deny.
    primeLiveAuthority({
      grants: [
        ...CEILING.roleGrants.map((g) => ({
          id: g.grantId,
          roleId: g.roleId,
          capabilityId: g.capabilityId,
          effect: g.grantId === "rlg_a_mutate" ? "allow" : g.effect,
          conditionsJsonb: null,
        })),
      ],
    });

    await expect(
      invoke("test.agent.mutate", { value: "late" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerSpies.mutate).not.toHaveBeenCalled();
    expect(mocks.decisionRows[0]).toMatchObject({
      outcome: "deny",
      reasonCode: "ceiling_denies",
    });
  });

  it("fails closed when the authoritative decision row cannot be inserted", async () => {
    primeLiveAuthority();
    mocks.insert.mockImplementation(() => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }));

    await expect(
      invoke("test.agent.read", { value: "x" }, agentCtx(makeAgentRun()), {
        surface: "agent",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerSpies.read).not.toHaveBeenCalled();
  });

  it("require_approval routes through the existing approval flow: JIT access request + pollable pending_approval error", async () => {
    mocks.createAccessRequest.mockResolvedValue("arq_agent_deploy");
    const agentRun = makeAgentRun();

    let thrown: unknown;
    try {
      await invoke("test.agent.deploy", { value: "ship" }, agentCtx(agentRun), {
        surface: "agent",
      });
    } catch (err) {
      thrown = err;
    }

    expect(handlerSpies.deploy).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).code).toBe("pending_approval");
    expect((thrown as CapabilityError).accessRequestId).toBe(
      "arq_agent_deploy",
    );

    // The SAME creator seam human require_approval outcomes use today
    // (setKernelAccessRequestCreator ← bootstrapIAMRuntime ← createAccessRequest),
    // invoked with the AGENT as the requesting principal.
    expect(mocks.createAccessRequest).toHaveBeenCalledTimes(1);
    const req = mocks.createAccessRequest.mock.calls[0]?.[0] as {
      capability: string;
      principal: { id: string; kind: string } | null;
    };
    expect(req.capability).toBe("test.agent.deploy");
    expect(req.principal).toMatchObject({ id: AGENT_PRN, kind: "agent" });

    // Escalation is auditable + meterable: pending_approval outcome under
    // principal_kind='agent'.
    const audit = mocks.emitAudit.mock.calls[0]?.[0] as EmitAuditArgs;
    expect(audit.result.outcome).toBe("pending_approval");
    expect(audit.result.trace.decidedBy.rule).toBe(
      "agent_ceiling:pending_approval",
    );
    expect(mocks.decisionRows[0]).toMatchObject({
      outcome: "approval_pending",
    });
  });

  it("fails closed when principalKind='agent' but the run context is missing", async () => {
    const { result, principal } = await checkIAM({
      capability: "test.agent.read",
      ctx: baseCtx, // no agentRun
      defaultEffect: "allow",
      rawInputJson: "{}",
      principalKind: "agent",
    });

    expect(result.outcome).toBe("deny");
    expect(principal).toBeNull();
    expect(result.trace.decidedBy.rule).toBe("agent_ceiling:missing_context");
    expect(mocks.decisionRows).toHaveLength(0);
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it("fails closed (kernel authz_denied) when the live authority read throws", async () => {
    primeLiveAuthority({
      failReads: Object.assign(new Error("relation does not exist"), {
        code: "42P01",
      }),
    });
    const agentRun = makeAgentRun();

    await expect(
      invoke("test.agent.read", { value: "x" }, agentCtx(agentRun), {
        surface: "agent",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerSpies.read).not.toHaveBeenCalled();
  });
});
