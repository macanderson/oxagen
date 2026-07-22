import { expect, it } from "vitest";
import {
  resolveAgentEffectivePermissions,
  type EffectiveScope,
} from "./resolve";

it("keeps a serialized parent effective empty label set as a narrowing ceiling", () => {
  const parentEffectiveScope: EffectiveScope = JSON.parse(
    JSON.stringify({ graph: { labels: [] } }),
  );

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
    grants: [
      {
        principalId: "agent",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org",
        effect: "allow",
        conditionsJsonb: {
          resourceScope: { graph: { labels: ["Person"] } },
        },
      },
      {
        principalId: "human",
        capabilityId: "graph.query",
        scopeKind: "org",
        scopeId: "org",
        effect: "allow",
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
    parentEffectiveScope,
  });

  expect(result.outcome).toBe("allow");
  expect(result.resourceScope.graph?.labels).toEqual([]);
});
