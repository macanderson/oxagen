// agent-run.test.ts — unit tests for the per-run agent IAM resolution cache
// (Agent RBAC Phase 2, spec §3.4/§3.5).
//
// Covers:
//   - per-capability memoization (same object reference on repeat resolution)
//   - deny-wins delegation ceiling (agent deny beats human allow, and the
//     reverse: human deny caps an agent allow)
//   - require_approval survives the merge (pending_approval outcome)
//   - null humanPrincipal → sentinel ceiling (contract defaultEffect)

import { describe, expect, it } from "vitest";
import type { ResolvedPrincipal } from "../types";
import {
  createAgentRunResolution,
  resolveAgentRunCapability,
  type AgentAuthzSnapshot,
  type AgentRunIAMContext,
} from "./agent-run";

const ORG = "00000000-0000-0000-0000-00000000aa01";
const WS = "00000000-0000-0000-0000-00000000aa02";
const AGENT_PRN = "00000000-0000-0000-0000-00000000ab01";
const HUMAN_PRN = "00000000-0000-0000-0000-00000000ab02";

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
 * Agent is an "Agent Observer" (reads allow, mutation deny, deploy
 * require_approval); the human holds allow on everything except
 * `test.human_denied`.
 */
const SNAPSHOT: AgentAuthzSnapshot = {
  grants: [],
  policies: [],
  roles: [
    {
      id: "role_agent",
      name: "Agent Observer",
      scopeKind: "workspace",
      orgId: ORG,
      principalIds: [AGENT_PRN],
      isSystemDefault: true,
    },
    {
      id: "role_human",
      name: "Member",
      scopeKind: "workspace",
      orgId: ORG,
      principalIds: [HUMAN_PRN],
      isSystemDefault: true,
    },
  ],
  roleGrants: [
    { roleId: "role_agent", capabilityId: "test.read", effect: "allow" },
    { roleId: "role_human", capabilityId: "test.read", effect: "allow" },
    { roleId: "role_agent", capabilityId: "test.mutate", effect: "deny" },
    { roleId: "role_human", capabilityId: "test.mutate", effect: "allow" },
    {
      roleId: "role_agent",
      capabilityId: "test.deploy",
      effect: "require_approval",
    },
    { roleId: "role_human", capabilityId: "test.deploy", effect: "allow" },
    {
      roleId: "role_agent",
      capabilityId: "test.human_denied",
      effect: "allow",
    },
    { roleId: "role_human", capabilityId: "test.human_denied", effect: "deny" },
  ],
};

function makeRunCtx(
  overrides: Partial<AgentRunIAMContext> = {},
): AgentRunIAMContext {
  return {
    principalKind: "agent",
    agentPrincipal,
    humanPrincipal,
    agentId: "agt_test",
    runId: "run_test",
    parentRunId: null,
    ...overrides,
  };
}

describe("resolveAgentRunCapability()", () => {
  it("allows when both sides of the delegation ceiling allow", () => {
    const runCtx = makeRunCtx();
    const resolution = createAgentRunResolution(SNAPSHOT);
    const perms = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.read",
      scope: SCOPE,
      defaultEffect: "deny",
    });
    expect(perms.outcome).toBe("allow");
  });

  it("deny-wins: the agent's role deny beats the human's allow", () => {
    const runCtx = makeRunCtx();
    const resolution = createAgentRunResolution(SNAPSHOT);
    const perms = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.mutate",
      scope: SCOPE,
      // defaultEffect allow: the deny can ONLY come from the agent role grant.
      defaultEffect: "allow",
    });
    expect(perms.outcome).toBe("deny");
    expect(perms.agentResolution.outcome).toBe("deny");
    expect(perms.humanResolution.outcome).toBe("allow");
  });

  it("delegation ceiling: the human's deny caps an agent allow", () => {
    const runCtx = makeRunCtx();
    const resolution = createAgentRunResolution(SNAPSHOT);
    const perms = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.human_denied",
      scope: SCOPE,
      defaultEffect: "allow",
    });
    expect(perms.outcome).toBe("deny");
    expect(perms.agentResolution.outcome).toBe("allow");
    expect(perms.humanResolution.outcome).toBe("deny");
  });

  it("require_approval survives the merge as pending_approval", () => {
    const runCtx = makeRunCtx();
    const resolution = createAgentRunResolution(SNAPSHOT);
    const perms = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.deploy",
      scope: SCOPE,
      defaultEffect: "allow",
    });
    expect(perms.outcome).toBe("pending_approval");
  });

  it("memoizes per capability: repeat resolution returns the same object", () => {
    const runCtx = makeRunCtx();
    const resolution = createAgentRunResolution(SNAPSHOT);
    const first = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.read",
      scope: SCOPE,
      defaultEffect: "deny",
    });
    const second = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.read",
      scope: SCOPE,
      defaultEffect: "deny",
    });
    expect(second).toBe(first);
    expect(resolution.byCapability.size).toBe(1);
    expect(resolution.byCapability.get("test.read")).toBe(first);
  });

  it("null humanPrincipal → sentinel ceiling: the human side contributes the contract defaultEffect", () => {
    const runCtx = makeRunCtx({ humanPrincipal: null });
    const resolution = createAgentRunResolution(SNAPSHOT);

    // defaultEffect deny: even though the agent's own role allows, the
    // sentinel human side falls to deny — fail-closed without a delegator.
    const denied = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.read",
      scope: SCOPE,
      defaultEffect: "deny",
    });
    expect(denied.outcome).toBe("deny");
    expect(denied.agentResolution.outcome).toBe("allow");
    expect(denied.humanResolution.outcome).toBe("deny");

    // defaultEffect allow: the sentinel human side allows, so the agent's own
    // role grant decides.
    const allowed = resolveAgentRunCapability(runCtx, resolution, {
      capability: "test.human_denied",
      scope: SCOPE,
      defaultEffect: "allow",
    });
    expect(allowed.outcome).toBe("allow");
  });
});
