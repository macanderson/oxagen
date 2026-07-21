// Witness test: Rule 7 (role-inherited grant) must be deny-before-allow.
//
// A principal that is a member of two roles — one granting 'allow' and one
// granting 'deny' for the same capability — must resolve to DENY. This is
// the same deny-wins guarantee already enforced at rule 6 (org default
// grant, fixed for the identical bug): a principal must never escape an
// explicit deny by also holding an allow grant, whether that grant arrives
// directly or via a second role. Agent RBAC depends on this: an agent's
// role-derived grants and a narrowing custom role assigned alongside it must
// combine deny-first, not allow-first.
import { expect, it } from "vitest";
import { resolve } from "./resolve";

it("rule 7 (role grant) resolves DENY when the principal's roles carry both an allow and a deny grant for the same capability", () => {
  const result = resolve({
    principal: {
      id: "agent-1",
      kind: "agent",
      orgId: "org-1",
      workspaceId: null,
    },
    capability: "graph.query",
    scope: { kind: "org", orgId: "org-1" },
    grants: [],
    roles: [
      {
        id: "role-allow",
        name: "Agent Contributor",
        scopeKind: "org",
        orgId: "org-1",
        principalIds: ["agent-1"],
      },
      {
        id: "role-deny",
        name: "Custom Narrowing Role",
        scopeKind: "org",
        orgId: "org-1",
        principalIds: ["agent-1"],
      },
    ],
    roleGrants: [
      { roleId: "role-allow", capabilityId: "graph.query", effect: "allow" },
      { roleId: "role-deny", capabilityId: "graph.query", effect: "deny" },
    ],
    policies: [],
    defaultEffect: "deny",
  });

  expect(result.outcome).toBe("deny");
});
