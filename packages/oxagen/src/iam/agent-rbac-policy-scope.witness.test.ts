import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("applies an active policy resourceScope to an agent run", () => {
  const result = resolveAgentEffectivePermissions({
    agentPrincipal: {
      id: "agent",
      kind: "agent",
      orgId: "org",
      workspaceId: null,
    },
    humanPrincipal: {
      id: "human",
      kind: "human",
      orgId: "org",
      workspaceId: null,
    },
    capability: "graph.query",
    scope: { kind: "org", orgId: "org" },
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [
      {
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org",
        effect: "allow",
        enforced: true,
        conditionsJsonb: {
          resourceScope: { graph: { labels: ["Person"] } },
        },
      },
    ],
    defaultEffect: "deny",
  });

  expect(result.outcome).toBe("allow");
  expect(result.resourceScope.graph?.labels).toEqual(["Person"]);
});
