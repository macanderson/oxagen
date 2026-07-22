import { expect, it } from "vitest";
import {
  createEffectivePermissionsCache,
  intersectEffectiveScope,
  resolveAgentEffectivePermissions,
} from "./resolve";

it("does not reuse a cached result for a stricter effective parent scope", () => {
  const cache = createEffectivePermissionsCache();
  const common = {
    agentPrincipal: {
      id: "agent-1",
      kind: "agent" as const,
      orgId: "org-1",
      workspaceId: null,
    },
    humanPrincipal: {
      id: "human-1",
      kind: "human" as const,
      orgId: "org-1",
      workspaceId: null,
    },
    capability: "graph.query",
    scope: { kind: "org" as const, orgId: "org-1" },
    grants: [
      {
        principalId: "agent-1",
        capabilityId: "graph.query",
        scopeKind: "org" as const,
        scopeId: "org-1",
        effect: "allow" as const,
        conditionsJsonb: {
          resourceScope: { graph: { labels: ["Person"] } },
        },
      },
      {
        principalId: "human-1",
        capabilityId: "graph.query",
        scopeKind: "org" as const,
        scopeId: "org-1",
        effect: "allow" as const,
        conditionsJsonb: {
          resourceScope: { graph: { labels: ["Person"] } },
        },
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny" as const,
    cache,
  };

  // A genuinely unrestricted parent effective scope omits the dimension
  // entirely (produced e.g. by intersectEffectiveScope({}, {})) — an
  // EMPTY labels array is NOT the same thing: per the parentEffectiveScope
  // contract (always an already-computed EffectiveScope, never a raw
  // admin-authored literal), `labels: []` means "narrowed to nothing",
  // not "all labels".
  const unrestrictedParent = {};
  const broad = resolveAgentEffectivePermissions({
    ...common,
    parentEffectiveScope: unrestrictedParent,
  });
  expect(broad.resourceScope.graph?.labels).toEqual(["Person"]);

  const emptyEffectiveParent = intersectEffectiveScope(
    { graph: { labels: ["Person"] } },
    { graph: { labels: ["Company"] } },
  );
  const narrowed = resolveAgentEffectivePermissions({
    ...common,
    parentEffectiveScope: emptyEffectiveParent,
  });

  expect(narrowed.resourceScope.graph?.labels).toEqual([]);
});
