// Witness test for Agent RBAC — the type + resolution foundation.
//
// Pins the behavior added to conditions.ts (resourceScope condition payload)
// and resolve.ts (agent-principal effective-permission resolution):
//   - resourceScope is a recognised, zod-validated condition key
//   - dimension-wise intersection of resource scopes (labels/skills = set
//     intersection; undefined = unrestricted; budget = element-wise min;
//     mode = min over "read" < "extend")
//   - MCP rule sets combine by most-restrictive-effect (deny > ask > allow)
//   - delegation ceiling: agent effective outcome = deny-wins merge of the
//     agent's own resolution and the invoking human's resolution
//   - subagent narrowing: a parent run's effective scope is an additional,
//     narrowing-only ceiling.
//
// Namespace imports (rather than named imports) so that a not-yet-implemented
// export surfaces as a runtime "not a function" failure that exercises the
// missing behavior, instead of a module-load error.
import { describe, expect, it } from "vitest";
import * as conditions from "./conditions";
import * as resolve from "./resolve";

describe("resourceScope condition validation (conditions.ts)", () => {
  it("recognises resourceScope as a known condition key (does not fail-closed)", () => {
    // A grant carrying only a well-formed resourceScope must evaluate to true
    // (the scope is a ceiling enforced by the resolver, not an allow/deny gate).
    const ctx = { now: new Date("2024-01-01T12:00:00Z"), clientIp: null };
    const result = conditions.evaluateConditions(
      {
        resourceScope: {
          graph: { labels: ["Person"], mode: "read" },
          mcp: { rules: [{ pattern: "github:*", effect: "allow" }] },
          skills: { slugs: ["summarize"] },
          agents: { refs: ["researcher"] },
        },
      },
      ctx,
    );
    expect(result).toBe(true);
  });

  it("fail-closes on a malformed resourceScope payload", () => {
    const ctx = { now: new Date("2024-01-01T12:00:00Z"), clientIp: null };
    const bad = conditions.evaluateConditions(
      { resourceScope: { graph: { mode: "delete" } } },
      ctx,
    );
    expect(bad).toBe(false);
  });

  it("parseResourceScope returns the parsed payload for a valid scope, null for junk", () => {
    const parsed = conditions.parseResourceScope({
      graph: { labels: ["A"], budget: { maxHops: 3 } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.graph?.labels).toEqual(["A"]);
    expect(
      conditions.parseResourceScope({ mcp: { rules: "nope" } }),
    ).toBeNull();
  });
});

describe("intersectEffectiveScope — dimension-wise narrowing (resolve.ts)", () => {
  it("intersects string-set dimensions, mins the budget, and mins the mode", () => {
    const a = {
      graph: {
        labels: ["A", "B"],
        mode: "extend" as const,
        budget: { maxHops: 5, maxNodes: 100 },
      },
      skills: { slugs: ["s1", "s2"] },
    };
    const b = {
      graph: {
        labels: ["B", "C"],
        mode: "read" as const,
        budget: { maxHops: 3 },
      },
      // no skills → unrestricted on b's side
    };

    const merged = resolve.intersectEffectiveScope(a, b);

    // labels = set intersection
    expect(merged.graph?.labels).toEqual(["B"]);
    // mode = min over read < extend
    expect(merged.graph?.mode).toBe("read");
    // budget = element-wise min; b omits maxNodes so a's survives
    expect(merged.graph?.budget?.maxHops).toBe(3);
    expect(merged.graph?.budget?.maxNodes).toBe(100);
    // skills: b undefined = unrestricted → a's set survives unchanged
    expect(merged.skills?.slugs).toEqual(["s1", "s2"]);
  });

  it("undefined on a dimension means unrestricted (never widens the other side)", () => {
    const restricted = { skills: { slugs: ["only-this"] } };
    const merged = resolve.intersectEffectiveScope(restricted, {});
    expect(merged.skills?.slugs).toEqual(["only-this"]);
  });

  it("intersects relationshipTypes and agents.refs; disjoint sets yield the empty set", () => {
    const a = {
      graph: { relationshipTypes: ["KNOWS", "WORKS_AT"] },
      agents: { refs: ["researcher", "writer"] },
    };
    const b = {
      graph: { relationshipTypes: ["WORKS_AT", "OWNS"] },
      agents: { refs: ["editor"] },
    };
    const merged = resolve.intersectEffectiveScope(a, b);
    expect(merged.graph?.relationshipTypes).toEqual(["WORKS_AT"]);
    // Disjoint refs → empty set: nothing dispatchable, never widened.
    expect(merged.agents?.refs).toEqual([]);
  });

  it("empty graph label list means unrestricted (spec: undefined/empty = all)", () => {
    const merged = resolve.intersectEffectiveScope(
      { graph: { labels: [] } },
      { graph: { labels: ["Person"] } },
    );
    expect(merged.graph?.labels).toEqual(["Person"]);
  });

  it("budget is element-wise min across all three ceilings", () => {
    const merged = resolve.intersectEffectiveScope(
      { graph: { budget: { maxHops: 5, maxNodes: 10, maxTraversalMs: 1000 } } },
      { graph: { budget: { maxHops: 2, maxNodes: 50, maxTraversalMs: 500 } } },
    );
    expect(merged.graph?.budget).toEqual({
      maxHops: 2,
      maxNodes: 10,
      maxTraversalMs: 500,
    });
  });

  it("intersection is associative-narrowing: chaining never widens", () => {
    const step1 = resolve.intersectEffectiveScope(
      { graph: { labels: ["A", "B", "C"], mode: "extend" as const } },
      { graph: { labels: ["B", "C"] } },
    );
    const step2 = resolve.intersectEffectiveScope(step1, {
      graph: { labels: ["C", "D"], mode: "read" as const },
    });
    expect(step2.graph?.labels).toEqual(["C"]);
    expect(step2.graph?.mode).toBe("read");
  });
});

describe("MCP rule sets combine by most-restrictive-effect (resolve.ts)", () => {
  it("takes deny over allow across independently-evaluated rule sets", () => {
    const scope = {
      ruleSets: [
        [{ pattern: "github:*", effect: "allow" as const }],
        [{ pattern: "github:delete", effect: "deny" as const }],
      ],
    };
    // github:delete: set1 → allow, set2 → deny ⇒ deny wins
    expect(resolve.evaluateEffectiveMcpScope(scope, "github:delete")).toBe(
      "deny",
    );
    // github:read: set1 → allow, set2 → no match (default allow) ⇒ allow
    expect(resolve.evaluateEffectiveMcpScope(scope, "github:read")).toBe(
      "allow",
    );
  });

  it("ask beats allow but loses to deny; first match wins within a set", () => {
    const scope = {
      ruleSets: [
        [
          { pattern: "db:drop_*", effect: "deny" as const },
          { pattern: "db:*", effect: "allow" as const },
        ],
        [{ pattern: "db:*", effect: "ask" as const }],
      ],
    };
    // set1 first-match: allow (db:query); set2: ask ⇒ ask
    expect(resolve.evaluateEffectiveMcpScope(scope, "db:query")).toBe("ask");
    // set1 first-match: deny (db:drop_table) ⇒ deny regardless of set2's ask
    expect(resolve.evaluateEffectiveMcpScope(scope, "db:drop_table")).toBe(
      "deny",
    );
  });

  it("undefined scope or no rule sets = unrestricted (allow)", () => {
    expect(resolve.evaluateEffectiveMcpScope(undefined, "any:tool")).toBe(
      "allow",
    );
    expect(
      resolve.evaluateEffectiveMcpScope({ ruleSets: [] }, "any:tool"),
    ).toBe("allow");
  });

  it("intersectEffectiveScope carries both sides' mcp rules into the effective scope", () => {
    const merged = resolve.intersectEffectiveScope(
      { mcp: { rules: [{ pattern: "gh:*", effect: "allow" as const }] } },
      { mcp: { rules: [{ pattern: "gh:push", effect: "deny" as const }] } },
    );
    expect(resolve.evaluateEffectiveMcpScope(merged.mcp, "gh:push")).toBe(
      "deny",
    );
    expect(resolve.evaluateEffectiveMcpScope(merged.mcp, "gh:pull")).toBe(
      "allow",
    );
  });
});

describe("resolveAgentEffectivePermissions — delegation ceiling (resolve.ts)", () => {
  const agentPrincipal = {
    id: "agent1",
    kind: "agent" as const,
    orgId: "org1",
    workspaceId: null,
  };
  const humanPrincipal = {
    id: "human1",
    kind: "human" as const,
    orgId: "org1",
    workspaceId: null,
  };
  const scope = { kind: "org" as const, orgId: "org1" };

  it("deny-wins: an agent can never exceed the human it acts for", () => {
    const result = resolve.resolveAgentEffectivePermissions({
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        // agent is allowed
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
        // but the human is explicitly denied
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "deny" as const,
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
    });

    // Intersection of agent(allow) ∩ human(deny) must be deny.
    expect(result.outcome).toBe("deny");
  });

  it("subagent narrowing: a parent run's effective scope is an additional ceiling", () => {
    const result = resolve.resolveAgentEffectivePermissions({
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
      // Parent run already restricted skills to one slug — the child can only narrow.
      parentEffectiveScope: { skills: { slugs: ["parent-only"] } },
    });

    expect(result.outcome).toBe("allow");
    expect(result.resourceScope.skills?.slugs).toEqual(["parent-only"]);
  });

  it("subagent narrowing never widens: a broader child grant is still capped by the parent ceiling", () => {
    // The agent's OWN grant scopes labels to {A, B, C} — broader than the
    // parent run's already-narrowed {B}. The child must NOT escape the
    // parent's ceiling just because its own grant is more permissive.
    const result = resolve.resolveAgentEffectivePermissions({
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
          conditionsJsonb: {
            resourceScope: { graph: { labels: ["A", "B", "C"] } },
          },
        },
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
          conditionsJsonb: {
            resourceScope: { graph: { labels: ["A", "B", "C"] } },
          },
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
      // Parent run narrowed to just {B} — the child's own {A,B,C} grant must
      // not widen the effective scope back out.
      parentEffectiveScope: { graph: { labels: ["B"] } },
    });

    expect(result.outcome).toBe("allow");
    expect(result.resourceScope.graph?.labels).toEqual(["B"]);
  });

  it("intersects resourceScope ceilings from the agent's and human's grants", () => {
    const result = resolve.resolveAgentEffectivePermissions({
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
          conditionsJsonb: {
            resourceScope: {
              graph: {
                labels: ["Person", "Company"],
                mode: "extend",
                budget: { maxHops: 5 },
              },
              skills: { slugs: ["s1", "s2"] },
            },
          },
        },
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
          conditionsJsonb: {
            resourceScope: {
              graph: {
                labels: ["Company"],
                mode: "read",
                budget: { maxHops: 3, maxNodes: 100 },
              },
              skills: { slugs: ["s2", "s3"] },
            },
          },
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
    });

    expect(result.outcome).toBe("allow");
    expect(result.resourceScope.graph?.labels).toEqual(["Company"]);
    expect(result.resourceScope.graph?.mode).toBe("read");
    expect(result.resourceScope.graph?.budget).toEqual({
      maxHops: 3,
      maxNodes: 100,
    });
    expect(result.resourceScope.skills?.slugs).toEqual(["s2"]);
  });

  it("require_approval on either side downgrades an allow to pending_approval (deny-wins ordering)", () => {
    const result = resolve.resolveAgentEffectivePermissions({
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "require_approval" as const,
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
    });
    expect(result.outcome).toBe("pending_approval");
  });

  it("memoizes the effective-permissions object per run via the cache", () => {
    const cache = resolve.createEffectivePermissionsCache();
    const input = {
      agentPrincipal,
      humanPrincipal,
      capability: "x",
      scope,
      grants: [
        {
          principalId: "agent1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
        {
          principalId: "human1",
          capabilityId: "x",
          scopeKind: "org" as const,
          scopeId: "org1",
          effect: "allow" as const,
        },
      ],
      roles: [],
      roleGrants: [],
      policies: [],
      defaultEffect: "deny" as const,
      cache,
    };
    const first = resolve.resolveAgentEffectivePermissions(input);
    const second = resolve.resolveAgentEffectivePermissions(input);
    expect(second).toBe(first); // same cached object, not a re-resolution
  });
});
