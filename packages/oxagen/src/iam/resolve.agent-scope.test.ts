// resolve.agent-scope.test.ts — unit tests for the Agent RBAC delegation-
// ceiling resolver (resolveAgentEffectivePermissions) and the underlying
// EffectiveResourceScope intersection helpers in resolve.ts.

import { describe, expect, it } from "vitest";
import {
  resolveAgentEffectivePermissions,
  intersectEffectiveScope,
  evaluateEffectiveMcpScope,
  type ResolveAgentInput,
  type Grant,
  type Role,
  type RoleGrant,
  type ResolveScope,
  type EffectiveResourceScope,
} from "./resolve";
import type { ResolvedPrincipal } from "../types";

const ORG_ID = "org_aaa";
const WORKSPACE_ID = "ws_bbb";
const AGENT_ID = "prn_agent";
const HUMAN_ID = "prn_human";
const ROLE_ID = "rol_ddd";
const CAPABILITY = "graph.query";

const agentPrincipal: ResolvedPrincipal = {
  id: AGENT_ID,
  kind: "agent",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

const humanPrincipal: ResolvedPrincipal = {
  id: HUMAN_ID,
  kind: "human",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

const wsScope: ResolveScope = {
  kind: "workspace",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

function grantWithScope(
  principalId: string,
  resourceScope: unknown,
  effect: Grant["effect"] = "allow",
): Grant {
  return {
    principalId,
    capabilityId: CAPABILITY,
    scopeKind: "workspace",
    scopeId: WORKSPACE_ID,
    effect,
    conditionsJsonb: { resourceScope },
    expiresAt: null,
  };
}

function baseInput(
  overrides: Partial<ResolveAgentInput> = {},
): ResolveAgentInput {
  return {
    agentPrincipal,
    humanPrincipal,
    capability: CAPABILITY,
    scope: wsScope,
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
    ...overrides,
  };
}

describe("intersectEffectiveScope — dimension-wise intersection", () => {
  it("intersects labels and relationshipTypes as sets", () => {
    const a: EffectiveResourceScope = {
      graph: {
        labels: ["Document", "Person"],
        relationshipTypes: ["REFERENCES", "OWNS"],
      },
    };
    const b: EffectiveResourceScope = {
      graph: { labels: ["Person", "Org"], relationshipTypes: ["OWNS"] },
    };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.graph?.labels).toEqual(["Person"]);
    expect(merged.graph?.relationshipTypes).toEqual(["OWNS"]);
  });

  it("undefined on one side means unrestricted on that side — result keeps the other side's set", () => {
    const a: EffectiveResourceScope = { graph: { labels: ["Document"] } };
    const b: EffectiveResourceScope = { graph: {} };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.graph?.labels).toEqual(["Document"]);
  });

  it("undefined on both sides stays undefined (fully unrestricted)", () => {
    const merged = intersectEffectiveScope({ graph: {} }, { graph: {} });
    expect(merged.graph?.labels).toBeUndefined();
    expect(merged.graph?.relationshipTypes).toBeUndefined();
  });

  it("skills.slugs and agents.refs intersect as sets, undefined = unrestricted", () => {
    const a: EffectiveResourceScope = {
      skills: { slugs: ["research", "summarize"] },
      agents: { refs: ["reviewer", "planner"] },
    };
    const b: EffectiveResourceScope = {
      skills: { slugs: ["summarize"] },
      agents: {},
    };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.skills?.slugs).toEqual(["summarize"]);
    // agents.refs undefined on b → a's set passes through unrestricted-on-b-side.
    expect(merged.agents?.refs).toEqual(["reviewer", "planner"]);
  });

  it("graph.budget takes the element-wise min of both ceilings", () => {
    const a: EffectiveResourceScope = {
      graph: { budget: { maxHops: 3, maxNodes: 200, maxTraversalMs: 5000 } },
    };
    const b: EffectiveResourceScope = {
      graph: { budget: { maxHops: 5, maxNodes: 50, maxTraversalMs: 9000 } },
    };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.graph?.budget).toEqual({
      maxHops: 3,
      maxNodes: 50,
      maxTraversalMs: 5000,
    });
  });

  it("graph.budget with a missing ceiling on one side keeps the other side's ceiling (undefined = no ceiling)", () => {
    const a: EffectiveResourceScope = { graph: { budget: { maxHops: 3 } } };
    const b: EffectiveResourceScope = { graph: { budget: {} } };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.graph?.budget).toEqual({ maxHops: 3 });
  });

  it("graph.mode takes the minimum: read < extend", () => {
    expect(
      intersectEffectiveScope(
        { graph: { mode: "extend" } },
        { graph: { mode: "read" } },
      ).graph?.mode,
    ).toBe("read");
    expect(
      intersectEffectiveScope(
        { graph: { mode: "extend" } },
        { graph: { mode: "extend" } },
      ).graph?.mode,
    ).toBe("extend");
    // undefined mode on one side does not narrow.
    expect(
      intersectEffectiveScope({ graph: { mode: "extend" } }, { graph: {} })
        .graph?.mode,
    ).toBe("extend");
  });

  it("mcp rule sets accumulate from both sides for independent evaluation", () => {
    const a: EffectiveResourceScope = {
      mcp: { ruleSets: [[{ pattern: "github:*", effect: "allow" }]] },
    };
    const b: EffectiveResourceScope = {
      mcp: { ruleSets: [[{ pattern: "github:delete_*", effect: "deny" }]] },
    };
    const merged = intersectEffectiveScope(a, b);
    expect(merged.mcp?.ruleSets).toHaveLength(2);
  });
});

describe("evaluateEffectiveMcpScope — most-restrictive-effect merge", () => {
  it("deny beats ask beats allow across independently-evaluated rule sets", () => {
    const scope: EffectiveResourceScope["mcp"] = {
      ruleSets: [
        [{ pattern: "github:*", effect: "allow" }],
        [{ pattern: "github:delete_*", effect: "deny" }],
      ],
    };
    expect(evaluateEffectiveMcpScope(scope, "github:delete_repo")).toBe("deny");
    expect(evaluateEffectiveMcpScope(scope, "github:read_repo")).toBe("allow");
  });

  it("ask beats allow when no rule set denies", () => {
    const scope: EffectiveResourceScope["mcp"] = {
      ruleSets: [
        [{ pattern: "*", effect: "allow" }],
        [{ pattern: "slack:*", effect: "ask" }],
      ],
    };
    expect(evaluateEffectiveMcpScope(scope, "slack:post_message")).toBe("ask");
  });

  it("no rule sets (undefined) is unrestricted (allow)", () => {
    expect(evaluateEffectiveMcpScope(undefined, "github:read_repo")).toBe(
      "allow",
    );
  });
});

describe("resolveAgentEffectivePermissions — delegation ceiling", () => {
  it("intersects agent grant scope with human grant scope (agent cannot exceed the human)", () => {
    const grants: Grant[] = [
      grantWithScope(AGENT_ID, { graph: { labels: ["Document", "Person"] } }),
      grantWithScope(HUMAN_ID, { graph: { labels: ["Person"] } }),
    ];
    const result = resolveAgentEffectivePermissions(baseInput({ grants }));
    expect(result.outcome).toBe("allow");
    expect(result.resourceScope.graph?.labels).toEqual(["Person"]);
  });

  it("deny-wins: a deny on either the agent or the human side denies the merged outcome", () => {
    const grants: Grant[] = [
      grantWithScope(AGENT_ID, {}, "allow"),
      grantWithScope(HUMAN_ID, {}, "deny"),
    ];
    const result = resolveAgentEffectivePermissions(baseInput({ grants }));
    expect(result.outcome).toBe("deny");
  });

  it("an agent with a broader grant than the human is still capped by the human's narrower grant", () => {
    const grants: Grant[] = [
      grantWithScope(AGENT_ID, { graph: { mode: "extend" } }),
      grantWithScope(HUMAN_ID, { graph: { mode: "read" } }),
    ];
    const result = resolveAgentEffectivePermissions(baseInput({ grants }));
    expect(result.resourceScope.graph?.mode).toBe("read");
  });
});

describe("resolveAgentEffectivePermissions — subagent narrowing", () => {
  it("a child's effective scope is additionally capped by the parent run's effective scope", () => {
    const grants: Grant[] = [
      grantWithScope(AGENT_ID, {
        graph: { labels: ["Document", "Person", "Org"] },
      }),
      grantWithScope(HUMAN_ID, {}, "allow"),
    ];
    const parentEffectiveScope: EffectiveResourceScope = {
      graph: { labels: ["Document", "Person"] },
    };
    const result = resolveAgentEffectivePermissions(
      baseInput({ grants, parentEffectiveScope }),
    );
    // Narrowed to the intersection with the parent's ceiling — never widened.
    expect(result.resourceScope.graph?.labels).toEqual(["Document", "Person"]);
  });

  it("a parent's tighter budget ceiling propagates to the child (narrowing only)", () => {
    const grants: Grant[] = [
      grantWithScope(AGENT_ID, { graph: { budget: { maxNodes: 500 } } }),
      grantWithScope(HUMAN_ID, {}, "allow"),
    ];
    const parentEffectiveScope: EffectiveResourceScope = {
      graph: { budget: { maxNodes: 50 } },
    };
    const result = resolveAgentEffectivePermissions(
      baseInput({ grants, parentEffectiveScope }),
    );
    expect(result.resourceScope.graph?.budget?.maxNodes).toBe(50);
  });
});

describe("resolveAgentEffectivePermissions — role-grant ceilings", () => {
  it("collects resourceScope ceilings from role_grants (not just direct grants)", () => {
    const role: Role = {
      id: ROLE_ID,
      name: "Agent Contributor",
      scopeKind: "workspace",
      orgId: ORG_ID,
      principalIds: [AGENT_ID],
      isSystemDefault: true,
    };
    const roleGrants: RoleGrant[] = [
      {
        roleId: ROLE_ID,
        capabilityId: CAPABILITY,
        effect: "allow",
        conditionsJsonb: { resourceScope: { skills: { slugs: ["research"] } } },
      },
    ];
    const grants: Grant[] = [grantWithScope(HUMAN_ID, {}, "allow")];
    const result = resolveAgentEffectivePermissions(
      baseInput({ grants, roles: [role], roleGrants }),
    );
    expect(result.resourceScope.skills?.slugs).toEqual(["research"]);
  });
});
