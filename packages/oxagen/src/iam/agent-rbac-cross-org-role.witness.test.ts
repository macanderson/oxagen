import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("does not grant an agent capabilities through a role from another organization", () => {
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
        principalId: "human-1",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org-1",
        effect: "allow",
      },
    ],
    roles: [
      {
        id: "foreign-agent-role",
        name: "Agent Contributor",
        scopeKind: "org",
        orgId: "org-2",
        principalIds: ["agent-1"],
      },
    ],
    roleGrants: [
      {
        roleId: "foreign-agent-role",
        capabilityId: "graph.query",
        effect: "allow",
      },
    ],
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.agentResult.outcome).toBe("deny");
  expect(result.outcome).toBe("deny");
});
