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
  AgentAuthzSnapshot,
  AgentRunIAMContext,
} from "@oxagen/oxagen/iam";
import type { AuthzData } from "./fetch-authz";
import type { EmitAuditArgs } from "./emit-audit";

// ── Hoisted mocks (I/O seams only — resolver + kernel are real) ──────────────

const mocks = vi.hoisted(() => ({
  fetchAgentRunAuthz: vi.fn<(args: unknown) => Promise<unknown>>(),
  fetchAuthz: vi.fn<(args: unknown) => Promise<AuthzData>>(),
  emitAudit: vi.fn<(args: unknown) => Promise<void>>(),
  createAccessRequest: vi.fn<(args: unknown) => Promise<string | null>>(),
  resolveOrgTier: vi.fn(),
  canAccessACL: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("./fetch-agent-authz", () => ({
  fetchAgentRunAuthz: mocks.fetchAgentRunAuthz,
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
  };
}

function agentCtx(agentRun: AgentRunIAMContext): CapabilityContext {
  return { ...baseCtx, userId: null, surface: "runner", agentRun };
}

/**
 * The agent holds an Observer-style role: reads allow, mutation DENY, deploy
 * require_approval. The invoking human's role allows everything — so any
 * blocked outcome is attributable to the AGENT side of the ceiling.
 */
const SNAPSHOT: AgentAuthzSnapshot = {
  grants: [],
  policies: [],
  roles: [
    {
      id: "role_agent_observer",
      name: "Agent Observer",
      scopeKind: "workspace",
      orgId: ORG,
      principalIds: [AGENT_PRN],
      isSystemDefault: true,
    },
    {
      id: "role_human_member",
      name: "Member",
      scopeKind: "workspace",
      orgId: ORG,
      principalIds: [HUMAN_PRN],
      isSystemDefault: true,
    },
  ],
  roleGrants: [
    {
      roleId: "role_agent_observer",
      capabilityId: "test.agent.read",
      effect: "allow",
    },
    {
      roleId: "role_human_member",
      capabilityId: "test.agent.read",
      effect: "allow",
    },
    {
      roleId: "role_agent_observer",
      capabilityId: "test.agent.mutate",
      effect: "deny",
    },
    {
      roleId: "role_human_member",
      capabilityId: "test.agent.mutate",
      effect: "allow",
    },
    {
      roleId: "role_agent_observer",
      capabilityId: "test.agent.deploy",
      effect: "require_approval",
    },
    {
      roleId: "role_human_member",
      capabilityId: "test.agent.deploy",
      effect: "allow",
    },
  ],
};

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
    mocks.emitAudit.mockResolvedValue(undefined);
    mocks.fetchAgentRunAuthz.mockResolvedValue(SNAPSHOT);
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

    // Denial audit row: principal_kind='agent', run lineage, meterable
    // decision reason, deny outcome.
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    const audit = mocks.emitAudit.mock.calls[0]?.[0] as EmitAuditArgs;
    expect(audit.capability).toBe("test.agent.mutate");
    expect(audit.principal).toMatchObject({ id: AGENT_PRN, kind: "agent" });
    expect(audit.result.outcome).toBe("deny");
    expect(audit.result.trace.decidedBy.rule).toBe("agent_delegation:deny");
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
    expect(mocks.fetchAgentRunAuthz).not.toHaveBeenCalled();
    const audit = mocks.emitAudit.mock.calls[0]?.[0] as EmitAuditArgs;
    expect(audit.result.trace.decidedBy.rule).toBe("tier_gate");
  });

  it("computes the run resolution ONCE and reuses it across two invoke() calls, cached on the run context object", async () => {
    const agentRun = makeAgentRun();
    const ctx = agentCtx(agentRun);

    const first = await invoke("test.agent.read", { value: "a" }, ctx, {
      surface: "agent",
    });
    expect(first).toEqual({ value: "a" });

    // The cache lives ON the run context object — exposed for tool
    // materialization to read the SAME resolution.
    expect(agentRun.resolution).toBeDefined();
    const cachedResolution = agentRun.resolution;
    const cachedPerms = cachedResolution?.byCapability.get("test.agent.read");
    expect(cachedPerms).toBeDefined();

    const second = await invoke("test.agent.read", { value: "b" }, ctx, {
      surface: "agent",
    });
    expect(second).toEqual({ value: "b" });

    // One snapshot fetch for the whole run; the same resolution object (and
    // the same memoized per-capability entry) served both invocations.
    expect(mocks.fetchAgentRunAuthz).toHaveBeenCalledTimes(1);
    expect(agentRun.resolution).toBe(cachedResolution);
    expect(agentRun.resolution?.byCapability.get("test.agent.read")).toBe(
      cachedPerms,
    );
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
      "agent_delegation:pending_approval",
    );
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
    expect(result.trace.decidedBy.rule).toBe(
      "agent_delegation:missing_context",
    );
    expect(mocks.fetchAgentRunAuthz).not.toHaveBeenCalled();
    expect(mocks.fetchAuthz).not.toHaveBeenCalled();
  });

  it("fails closed (kernel authz_denied) when the snapshot fetch throws", async () => {
    mocks.fetchAgentRunAuthz.mockRejectedValue(
      Object.assign(new Error("relation does not exist"), { code: "42P01" }),
    );
    const agentRun = makeAgentRun();

    await expect(
      invoke("test.agent.read", { value: "x" }, agentCtx(agentRun), {
        surface: "agent",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerSpies.read).not.toHaveBeenCalled();
  });
});
