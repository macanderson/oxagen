import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("applies resourceScope ceilings inherited through agent and human role grants", () => {
  const roleGrants = [
    {
      roleId: "agent-role",
      capabilityId: "graph.query",
      effect: "allow" as const,
      conditionsJsonb: {
        resourceScope: { graph: { labels: ["Person", "Company"] } },
      },
    },
    {
      roleId: "human-role",
      capabilityId: "graph.query",
      effect: "allow" as const,
      conditionsJsonb: {
        resourceScope: { graph: { labels: ["Person"] } },
      },
    },
  ];

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
    grants: [],
    roles: [
      {
        id: "agent-role",
        name: "Agent graph reader",
        scopeKind: "org",
        orgId: "org-1",
        principalIds: ["agent-1"],
      },
      {
        id: "human-role",
        name: "Human graph reader",
        scopeKind: "org",
        orgId: "org-1",
        principalIds: ["human-1"],
      },
    ],
    roleGrants,
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.outcome).toBe("allow");
  expect(result.resourceScope.graph?.labels).toEqual(["Person"]);
});
