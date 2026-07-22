import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("fail-closes an agent role grant with a malformed resourceScope condition", () => {
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
        id: "agent-role",
        name: "Agent graph reader",
        scopeKind: "org",
        orgId: "org-1",
        principalIds: ["agent-1"],
      },
    ],
    roleGrants: [
      {
        roleId: "agent-role",
        capabilityId: "graph.query",
        effect: "allow",
        conditionsJsonb: {
          resourceScope: { graph: { mode: "delete" } },
        },
      },
    ],
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.agentResult.outcome).toBe("deny");
  expect(result.outcome).toBe("deny");
});
