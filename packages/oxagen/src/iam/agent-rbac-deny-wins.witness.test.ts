import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("denies an agent when its matching grants contain both allow and deny", () => {
  const result = resolveAgentEffectivePermissions({
    agentPrincipal: {
      id: "agent-1",
      kind: "agent",
      orgId: "org-1",
      workspaceId: null,
    },
    humanPrincipal: {
      id: "human-1",
      kind: "human",
      orgId: "org-1",
      workspaceId: null,
    },
    capability: "graph.query",
    scope: { kind: "org", orgId: "org-1" },
    grants: [
      {
        principalId: "agent-1",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org-1",
        effect: "allow",
      },
      {
        principalId: "agent-1",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org-1",
        effect: "deny",
      },
      {
        principalId: "human-1",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org-1",
        effect: "allow",
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.outcome).toBe("deny");
});
