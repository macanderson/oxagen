import { expect, it } from "vitest";
import { resolveAgentEffectivePermissions } from "./resolve";

it("requires approval when an agent has both allow and require_approval grants", () => {
  const result = resolveAgentEffectivePermissions({
    agentPrincipal: {
      id: "agent-1",
      kind: "agent",
      orgId: "org-1",
      workspaceId: "workspace-1",
    },
    humanPrincipal: {
      id: "human-1",
      kind: "human",
      orgId: "org-1",
      workspaceId: "workspace-1",
    },
    capability: "graph.query",
    scope: {
      kind: "workspace",
      orgId: "org-1",
      workspaceId: "workspace-1",
    },
    grants: [
      {
        principalId: "agent-1",
        capabilityId: "graph.query",
        scopeKind: "workspace",
        scopeId: "workspace-1",
        effect: "allow",
      },
      {
        principalId: "agent-1",
        capabilityId: "graph.query",
        scopeKind: "workspace",
        scopeId: "workspace-1",
        effect: "require_approval",
      },
      {
        principalId: "human-1",
        capabilityId: "graph.query",
        scopeKind: "workspace",
        scopeId: "workspace-1",
        effect: "allow",
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.outcome).toBe("pending_approval");
});
