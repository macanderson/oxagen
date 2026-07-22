/**
 * effective-scope.test.ts — the Review step's display-only effective-scope
 * computation (role ceiling ∩ agent config). The intersection itself is the
 * resolver's exported helpers; these tests pin the view-model mapping around
 * them: mode min, budget element-wise min, labels from scopeToTypes,
 * capability grouping, MCP rule summaries, skills/subagent narrowing, and the
 * honest degraded states (unknown grants, unpublished custom-role ceiling).
 */
import { describe, expect, it } from "vitest";
import type { AgentTool } from "@oxagen/oxagen/agent-schema";
import type { AgentRoleOption } from "@/lib/workbench/agent-roles";
import {
  computeEffectiveScopeView,
  summarizeMcpRules,
  type DeclaredGraphState,
} from "./effective-scope";

const GRAPH: DeclaredGraphState = { mode: "read", maxHops: 2, maxNodes: 40 };

function role(overrides: Partial<AgentRoleOption>): AgentRoleOption {
  return {
    roleName: "Agent Contributor",
    description: "Standard worker.",
    isSystemDefault: true,
    scopeKind: "org",
    grants: [],
    grantsKnown: true,
    resourceScope: { mcp: { rules: [{ pattern: "*", effect: "ask" }] } },
    withinCeiling: true,
    exceededCapabilities: [],
    ...overrides,
  };
}

describe("computeEffectiveScopeView — graph dimension", () => {
  it("caps a declared extend mode by an Observer read ceiling (mode min)", () => {
    const view = computeEffectiveScopeView({
      role: role({
        roleName: "Agent Observer",
        resourceScope: {
          graph: { mode: "read" },
          mcp: { rules: [{ pattern: "*", effect: "deny" }] },
        },
      }),
      graph: { ...GRAPH, mode: "extend" },
      agentTools: [],
    });
    expect(view.graph.effective?.mode).toBe("read");
    expect(view.graph.ceiling?.mode).toBe("read");
    expect(view.graph.declared.mode).toBe("extend");
  });

  it("takes the element-wise budget minimum of ceiling and declaration", () => {
    const view = computeEffectiveScopeView({
      role: role({
        resourceScope: {
          graph: { budget: { maxHops: 1, maxNodes: 100 } },
        },
      }),
      graph: { ...GRAPH, maxHops: 3, maxNodes: 40 },
      agentTools: [],
    });
    expect(view.graph.effective?.budget).toEqual({ maxHops: 1, maxNodes: 40 });
  });

  it("maps declared scopeToTypes onto the labels dimension", () => {
    const view = computeEffectiveScopeView({
      role: role({}),
      graph: { ...GRAPH, scopeToTypes: ["Person", "WORKS_AT"] },
      agentTools: [],
    });
    expect(view.graph.effective?.labels).toEqual(["Person", "WORKS_AT"]);
    expect(view.graph.effective?.relationshipTypes).toEqual([
      "Person",
      "WORKS_AT",
    ]);
  });

  it("set-intersects labels when the role also constrains them", () => {
    const view = computeEffectiveScopeView({
      role: role({
        resourceScope: { graph: { labels: ["Person", "Org"] } },
      }),
      graph: { ...GRAPH, scopeToTypes: ["Person", "Deal"] },
      agentTools: [],
    });
    expect(view.graph.effective?.labels).toEqual(["Person"]);
  });
});

describe("computeEffectiveScopeView — capabilities dimension", () => {
  const GRANTS = [
    { capability: "graph.search", effect: "allow" as const },
    { capability: "repo.pr.open", effect: "require_approval" as const },
    { capability: "secret.reveal", effect: "deny" as const },
    { capability: "ontology.query", effect: "allow" as const },
  ];

  it("groups grants by effect, sorted", () => {
    const view = computeEffectiveScopeView({
      role: role({ grants: GRANTS }),
      graph: GRAPH,
      agentTools: [],
    });
    expect(view.capabilities.allow).toEqual(["graph.search", "ontology.query"]);
    expect(view.capabilities.requireApproval).toEqual(["repo.pr.open"]);
    expect(view.capabilities.deny).toEqual(["secret.reveal"]);
    expect(view.capabilities.known).toBe(true);
  });

  it("annotates equipped inline capabilities with the role's effect", () => {
    const tools: AgentTool[] = [
      { type: "function", ref: "secret.reveal" },
      { type: "function", ref: "workspace.list" },
    ];
    const view = computeEffectiveScopeView({
      role: role({ grants: GRANTS }),
      graph: GRAPH,
      agentTools: tools,
    });
    expect(view.capabilities.equipped).toEqual([
      { ref: "secret.reveal", effect: "deny" },
      // No grant for it → falls through to the contract defaultEffect.
      { ref: "workspace.list", effect: "default" },
    ]);
  });

  it("flags unknown grants honestly when the role failed to load", () => {
    const view = computeEffectiveScopeView({
      role: undefined,
      graph: GRAPH,
      agentTools: [],
    });
    expect(view.capabilities.known).toBe(false);
    expect(view.roleName).toBeNull();
    // No ceiling ⇒ effective graph = the declaration.
    expect(view.graph.effective?.mode).toBe("read");
  });
});

describe("computeEffectiveScopeView — MCP dimension", () => {
  it("summarizes the trivial single-glob rule sets of the system roles", () => {
    expect(summarizeMcpRules([{ pattern: "*", effect: "ask" }])).toMatch(
      /first-use consent/i,
    );
    expect(summarizeMcpRules([{ pattern: "*", effect: "deny" }])).toMatch(
      /denied/i,
    );
    expect(summarizeMcpRules([{ pattern: "*", effect: "allow" }])).toMatch(
      /allowed/i,
    );
  });

  it("returns null for non-trivial rule sets (rendered as an ordered list)", () => {
    expect(
      summarizeMcpRules([
        { pattern: "github:*", effect: "deny" },
        { pattern: "*", effect: "allow" },
      ]),
    ).toBeNull();
  });

  it("carries the role's rules plus the equipped servers", () => {
    const view = computeEffectiveScopeView({
      role: role({}),
      graph: GRAPH,
      agentTools: [{ type: "mcp_server", ref: "github" }],
    });
    expect(view.mcp.rules).toEqual([{ pattern: "*", effect: "ask" }]);
    expect(view.mcp.summary).toMatch(/first-use consent/i);
    expect(view.mcp.equippedServers).toEqual(["github"]);
  });

  it("shows no MCP restriction for a role publishing none", () => {
    const view = computeEffectiveScopeView({
      role: role({ resourceScope: null, isSystemDefault: false }),
      graph: GRAPH,
      agentTools: [],
    });
    expect(view.mcp.rules).toBeNull();
    expect(view.ceilingKnown).toBe(false);
  });
});

describe("computeEffectiveScopeView — skills & subagents", () => {
  const tools: AgentTool[] = [
    { type: "skill", ref: "release-notes" },
    { type: "skill", ref: "sql-audit" },
    { type: "agent", ref: "agt_child" },
  ];

  it("effective = equipped when the role does not constrain the dimension", () => {
    const view = computeEffectiveScopeView({
      role: role({}),
      graph: GRAPH,
      agentTools: tools,
    });
    expect(view.skills.effective).toEqual(["release-notes", "sql-audit"]);
    expect(view.skills.constrained).toBe(false);
    expect(view.subagents.effective).toEqual(["agt_child"]);
  });

  it("set-intersects a skills ceiling with the equipped list", () => {
    const view = computeEffectiveScopeView({
      role: role({
        resourceScope: { skills: { slugs: ["release-notes"] } },
      }),
      graph: GRAPH,
      agentTools: tools,
    });
    expect(view.skills.effective).toEqual(["release-notes"]);
    expect(view.skills.constrained).toBe(true);
    expect(view.skills.equipped).toEqual(["release-notes", "sql-audit"]);
  });

  it("set-intersects a subagent refs ceiling with the equipped list", () => {
    const view = computeEffectiveScopeView({
      role: role({
        resourceScope: { agents: { refs: ["agt_other"] } },
      }),
      graph: GRAPH,
      agentTools: tools,
    });
    expect(view.subagents.effective).toEqual([]);
    expect(view.subagents.constrained).toBe(true);
  });
});
