/**
 * effective-scope.ts — pure, client-safe computation of the Review step's
 * effective-scope accountability view (Agent RBAC Phase 5a, spec §4 Phase 5).
 *
 *   effective = role ceiling ∩ agent configuration (the request)
 *
 * DISPLAY-ONLY. Nothing here enforces anything — enforcement lives in the
 * kernel/resolver (packages/oxagen/src/iam/resolve.ts) and the graph seam.
 * The intersection math is NOT reimplemented: this module calls the
 * resolver's own exported `intersectGraphScope` / `intersectEffectiveScope`
 * ("Do not reimplement this intersection anywhere else"), so what the review
 * step shows is computed by the same functions the runtime enforces with.
 *
 * `@oxagen/oxagen/iam` is the pure, dependency-free resolver layer (see its
 * index.ts) — safe to import from a "use client" component.
 */
import {
  intersectEffectiveScope,
  type AgentsScope,
  type EffectiveResourceScope,
  type GraphScope,
  type McpRule,
  type ResourceScopeCondition,
  type SkillsScope,
} from "@oxagen/oxagen/iam";
import type { AgentTool } from "@oxagen/oxagen/agent-schema";
import type {
  AgentRoleGrant,
  AgentRoleOption,
} from "@/lib/workbench/agent-roles";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** The builder's live Ground-step state, i.e. the declared GraphAccess. */
export interface DeclaredGraphState {
  mode: "read" | "extend";
  maxHops: number;
  maxNodes: number;
  /** Preserved from the loaded config; the wizard does not edit these. */
  maxTraversalMs?: number;
  scopeToTypes?: string[];
}

export interface EffectiveScopeInput {
  /** The selected role option, or undefined when roles failed to load. */
  role: AgentRoleOption | undefined;
  graph: DeclaredGraphState;
  agentTools: AgentTool[];
}

// ── Output view model ─────────────────────────────────────────────────────────

export interface CapabilityDimensionView {
  /** Grant lists grouped by effect (the role's capability ceiling). */
  allow: string[];
  requireApproval: string[];
  deny: string[];
  /** False when the role's grant list could not be loaded (degraded). */
  known: boolean;
  /**
   * Equipped inline capabilities (AgentTool type "function") annotated with
   * the role's effect for each — the request ∩ ceiling made concrete. Effect
   * "default" = the role carries no grant for it; the capability falls
   * through to its contract defaultEffect at runtime.
   */
  equipped: Array<{
    ref: string;
    effect: "allow" | "deny" | "require_approval" | "default";
  }>;
}

export interface GraphDimensionView {
  /** role ceiling ∩ declared config, via the resolver's intersectGraphScope. */
  effective: GraphScope | undefined;
  declared: DeclaredGraphState;
  /** The role's graph ceiling, null when unpublished (custom role). */
  ceiling: GraphScope | null;
}

export interface McpDimensionView {
  /** The role's MCP rules in evaluation order (first match wins), or null
   *  when the role publishes none (unrestricted from the role's side). */
  rules: McpRule[] | null;
  /** One-line summary when the rule set is the trivial single-glob form. */
  summary: string | null;
  /** Equipped MCP servers (the request side of the intersection). */
  equippedServers: string[];
}

export interface RefsDimensionView {
  /** ceiling ∩ equipped refs; null = role unrestricted ⇒ effective = equipped. */
  effective: string[];
  equipped: string[];
  /** True when the role constrains this dimension at all. */
  constrained: boolean;
}

export interface EffectiveScopeView {
  roleName: string | null;
  /** False for custom roles: their resource-scope ceiling is not published
   *  through a read contract, so graph/MCP show the declared side only. */
  ceilingKnown: boolean;
  capabilities: CapabilityDimensionView;
  graph: GraphDimensionView;
  mcp: McpDimensionView;
  skills: RefsDimensionView;
  subagents: RefsDimensionView;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toolRefs(tools: AgentTool[], type: AgentTool["type"]): string[] {
  return tools.filter((t) => t.type === type).map((t) => t.ref);
}

/** Lift a role's raw resourceScope condition into the resolver's effective
 *  shape (MCP rules become one contributing rule set). */
function ceilingScope(
  condition: ResourceScopeCondition | null,
): EffectiveResourceScope | undefined {
  if (condition === null) return undefined;
  const scope: EffectiveResourceScope = {};
  if (condition.graph !== undefined) scope.graph = condition.graph;
  if (condition.mcp !== undefined) scope.mcp = { ruleSets: [condition.mcp.rules] };
  if (condition.skills !== undefined) scope.skills = condition.skills;
  if (condition.agents !== undefined) scope.agents = condition.agents;
  return scope;
}

/** The declared (requested) side: the agent's own configuration expressed in
 *  the same shape, so one intersectEffectiveScope call covers every dimension. */
function declaredScope(
  graph: DeclaredGraphState,
  tools: AgentTool[],
): EffectiveResourceScope {
  const graphScope: GraphScope = {
    mode: graph.mode,
    budget: {
      maxHops: graph.maxHops,
      maxNodes: graph.maxNodes,
      ...(graph.maxTraversalMs !== undefined
        ? { maxTraversalMs: graph.maxTraversalMs }
        : {}),
    },
  };
  if (graph.scopeToTypes !== undefined && graph.scopeToTypes.length > 0) {
    // scopeToTypes is one list covering node labels AND relationship types —
    // same mapping as packages/handlers' declaredGraphScope.
    graphScope.labels = [...graph.scopeToTypes];
    graphScope.relationshipTypes = [...graph.scopeToTypes];
  }
  const skills: SkillsScope = { slugs: toolRefs(tools, "skill") };
  const agents: AgentsScope = { refs: toolRefs(tools, "agent") };
  return { graph: graphScope, skills, agents };
}

function grantsByEffect(
  grants: AgentRoleGrant[],
  effect: AgentRoleGrant["effect"],
): string[] {
  return grants
    .filter((g) => g.effect === effect)
    .map((g) => g.capability)
    .sort();
}

/** Friendly summary for the trivial single-rule "*" sets the system roles use. */
export function summarizeMcpRules(rules: McpRule[]): string | null {
  if (rules.length !== 1 || rules[0]!.pattern !== "*") return null;
  switch (rules[0]!.effect) {
    case "allow":
      return "All MCP tool calls allowed";
    case "ask":
      return "MCP tool calls require first-use consent";
    case "deny":
      return "All MCP tool calls denied";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function computeEffectiveScopeView(
  input: EffectiveScopeInput,
): EffectiveScopeView {
  const { role, graph, agentTools } = input;

  const ceiling = ceilingScope(role?.resourceScope ?? null);
  const declared = declaredScope(graph, agentTools);
  // The resolver's own narrowing — graph labels/rel-types set-intersect,
  // mode min, budget element-wise min; skills/agents refs set-intersect.
  const effective = intersectEffectiveScope(ceiling, declared);

  const grants = role?.grants ?? [];
  const grantEffectByRef = new Map(grants.map((g) => [g.capability, g.effect]));
  const capabilities: CapabilityDimensionView = {
    allow: grantsByEffect(grants, "allow"),
    requireApproval: grantsByEffect(grants, "require_approval"),
    deny: grantsByEffect(grants, "deny"),
    known: role !== undefined && role.grantsKnown,
    equipped: toolRefs(agentTools, "function").map((ref) => ({
      ref,
      effect: grantEffectByRef.get(ref) ?? "default",
    })),
  };

  const mcpRules = role?.resourceScope?.mcp?.rules ?? null;

  const equippedSkills = toolRefs(agentTools, "skill");
  const equippedSubagents = toolRefs(agentTools, "agent");

  return {
    roleName: role?.roleName ?? null,
    ceilingKnown: role !== undefined && role.resourceScope !== null,
    capabilities,
    graph: {
      effective: effective.graph,
      declared: graph,
      ceiling: role?.resourceScope?.graph ?? null,
    },
    mcp: {
      rules: mcpRules,
      summary: mcpRules ? summarizeMcpRules(mcpRules) : null,
      equippedServers: toolRefs(agentTools, "mcp_server"),
    },
    skills: {
      effective: effective.skills?.slugs ?? equippedSkills,
      equipped: equippedSkills,
      constrained: role?.resourceScope?.skills?.slugs !== undefined,
    },
    subagents: {
      effective: effective.agents?.refs ?? equippedSubagents,
      equipped: equippedSubagents,
      constrained: role?.resourceScope?.agents?.refs !== undefined,
    },
  };
}
