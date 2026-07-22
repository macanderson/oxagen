// Witness test: a role only counts toward Rule 7 (role-inherited grant) and
// the resourceScope role-ceiling collector when it belongs to the SAME org
// as the invocation. iam.roles/iam.role_grants never cross an org boundary
// (packages/database/src/schema/iam.ts), so a role fetched for another org
// that happens to list this principal in principalIds (stale data, or a
// caller that fetched roles across orgs) must never grant capabilities
// within this org's scope. Without the r.orgId === scope.orgId guard in
// resolve.ts, this fixture would resolve to "allow" — a cross-tenant
// privilege leak.
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
