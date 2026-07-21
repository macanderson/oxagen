/**
 * agent-role-suggest — the narrowest-adequate system agent role for a DRAFT
 * agent definition (Agent RBAC Phase 5b, docs/specs/agent-rbac/spec.md §4).
 *
 * `agent.definition.suggest` drafts a whole agent configuration from a
 * plain-language description. Phase 5a taught the builder to pick a ROLE (the
 * ceiling); this module answers the question the AI-assisted path should answer
 * for the user: given the definition just drafted (the REQUEST), which of the
 * three system roles is the SMALLEST ceiling that still lets it do its job?
 *
 *   role (ceiling) ∩ agent definition (request) = effective scope
 *
 * Nothing here is a policy of its own. The classification is derived entirely
 * from objects the seeder and the resolver already own:
 *
 *   - `AGENT_ROLE_SPECS[].computeEffect(category, riskLevel)` — the SAME
 *     function that writes each role's `iam.role_grants` rows, so a suggestion
 *     can never disagree with the grants the role actually carries (including
 *     Operator's vcs/billing/secret carve-out, which falls out for free rather
 *     than being restated here).
 *   - `AGENT_ROLE_SPECS[].resourceScope` — the same graph/MCP ceiling the
 *     review panel renders and the graph seam enforces.
 *   - `evaluateMcpRules()` from the IAM resolver — first-match-wins MCP rule
 *     evaluation, not a local re-implementation.
 *
 * PURE — no I/O, no registry access. The caller passes the capability metadata
 * (`selectAgentCapabilities(listCapabilities())`) so this stays unit-testable
 * against a fixed capability table.
 *
 * ADVISORY ONLY. This produces a PRE-SELECTION for a human-reviewable picker;
 * `assign_agent_role` (delegation ceiling, tier gate, assignability) remains
 * the sole authority on whether the role may actually be attached.
 */
import { evaluateMcpRules } from "@oxagen/oxagen/iam";
import type { RiskLevel } from "@oxagen/oxagen/types";
import {
  AGENT_ROLE_SPECS,
  type AgentRoleName,
  type AgentRoleSpec,
  type CapabilityAgentMeta,
} from "./agent-role-defaults";

/** The drafted definition, reduced to the three dimensions a role ceiling can
 *  constrain. Derived from the REPAIRED config (hallucinated tool refs already
 *  dropped), never from the raw model synthesis. */
export interface DraftAgentShape {
  /** Equipped tools, exactly as they appear in `config.agentTools`. */
  agentTools: ReadonlyArray<{ type: string; ref: string }>;
  /** The requested graph write posture (`config.graph.mode`). */
  graphMode: "read" | "extend";
  /**
   * Trigger TYPES present in the draft — not their `enabled` flag. A
   * suggestion always comes back with every trigger `enabled: false` (the
   * suggest handler forces that), so the declared trigger *type* is the only
   * honest signal of whether the agent is meant to run with a human present.
   */
  triggerTypes: ReadonlyArray<string>;
}

export interface AgentRoleSuggestion {
  /** One of the three system agent roles — never a custom role, and never the
   *  back-compat "Agent Legacy (unrestricted)" role (backfill-only). */
  roleName: AgentRoleName;
  /**
   * Provenance: why this role and not a narrower one. Rendered next to the
   * pre-selected role card so an AI-set value is always explainable.
   */
  reason: string;
}

/**
 * A capability the draft needs, resolved to the `category`/`riskLevel` pair the
 * role specs key off. A `function` tool whose capability declares no `agent`
 * metadata block gets the same defaults `selectAgentCapabilities` applies
 * (`category: ""`, `riskLevel: "medium"`) — i.e. treated as a medium-risk
 * NON-read capability, which floors the suggestion at Contributor rather than
 * silently qualifying for Observer.
 */
interface CapabilityRequirement {
  name: string;
  category: string;
  riskLevel: RiskLevel;
}

/** The role's ceiling for one requirement, expressed on the shared effect axis
 *  ("ask" is MCP's spelling of "require_approval"). */
type CeilingEffect = "allow" | "deny" | "require_approval";

/**
 * How badly does this ceiling stop the draft from doing its job?
 *
 *   allow            → never blocked (0).
 *   require_approval → fine when a human is in the loop (a manual run has
 *                      someone to answer the prompt); a blocker for an agent
 *                      that runs on a schedule or an inbound event with nobody
 *                      watching (1 when unattended, else 0).
 *   deny             → always blocked, and strictly worse than a stalled
 *                      approval: the action cannot happen at all, ever (2).
 *
 * The deny > require_approval weighting is what keeps a tie from collapsing
 * onto a role that would refuse outright. An unattended draft whose only
 * high-risk capability is in Operator's vcs/billing/secret carve-out stalls
 * identically under Contributor and Operator (1 each) but is flatly denied by
 * Observer (2), so the tie resolves to Contributor — the narrowest role that
 * is not a hard refusal.
 */
type BlockSeverity = 0 | 1 | 2;

function blockSeverity(
  effect: CeilingEffect,
  unattended: boolean,
): BlockSeverity {
  if (effect === "allow") return 0;
  if (effect === "deny") return 2;
  return unattended ? 1 : 0;
}

/** The role's graph ceiling, `undefined` when the role imposes none (the agent's
 *  own configured access then stands unmodified). */
function graphCeilingMode(spec: AgentRoleSpec): "read" | "extend" | undefined {
  return spec.resourceScope.graph?.mode;
}

/** What the role's MCP rules decide for `ref`, or "allow" when the role
 *  publishes no MCP rules at all (no ceiling from the role's side). */
function mcpEffectFor(spec: AgentRoleSpec, ref: string): CeilingEffect {
  const rules = spec.resourceScope.mcp?.rules;
  if (!rules || rules.length === 0) return "allow";
  const effect = evaluateMcpRules(rules, ref);
  return effect === "ask" ? "require_approval" : effect;
}

/** One thing the draft asks for that the role under test cannot deliver. */
interface Blocker {
  kind: "capability" | "mcp" | "graph";
  /** Capability name / MCP server ref / "graph" — used to cite the reason. */
  ref: string;
  severity: BlockSeverity;
}

interface RoleFit {
  spec: AgentRoleSpec;
  blockers: Blocker[];
  /** Summed severity — lower is a better fit; 0 means fully adequate. */
  cost: number;
}

function collectBlockers(
  spec: AgentRoleSpec,
  requirements: readonly CapabilityRequirement[],
  mcpRefs: readonly string[],
  needsGraphWrite: boolean,
  unattended: boolean,
): RoleFit {
  const blockers: Blocker[] = [];

  for (const req of requirements) {
    const severity = blockSeverity(
      spec.computeEffect(req.category, req.riskLevel),
      unattended,
    );
    if (severity > 0) {
      blockers.push({ kind: "capability", ref: req.name, severity });
    }
  }

  for (const ref of mcpRefs) {
    const severity = blockSeverity(mcpEffectFor(spec, ref), unattended);
    if (severity > 0) blockers.push({ kind: "mcp", ref, severity });
  }

  // Graph mode is a min() in the resolver's intersection: a "read" ceiling
  // narrows a requested "extend" back down to read, so the agent silently
  // loses the ability to propose nodes/edges. Scored as a hard block (2) —
  // like a deny, there is no approval prompt that can unblock it, so having a
  // human present makes no difference.
  if (needsGraphWrite && graphCeilingMode(spec) === "read") {
    blockers.push({ kind: "graph", ref: "graph", severity: 2 });
  }

  return {
    spec,
    blockers,
    cost: blockers.reduce((sum, b) => sum + b.severity, 0),
  };
}

/** Cite at most `max` refs, eliding the rest — keeps the reason one sentence. */
function citeRefs(refs: readonly string[], max = 3): string {
  const head = refs.slice(0, max).join(", ");
  return refs.length > max ? `${head}, …` : head;
}

function buildReason(
  roleName: AgentRoleName,
  blockersOfNarrower: readonly Blocker[],
  unattended: boolean,
): string {
  if (roleName === "Agent Observer") {
    return (
      "Reads and answers only — the draft equips no mutating capability, " +
      "requests read-only graph access, and calls no MCP tools, so the most " +
      "restrictive role is already enough."
    );
  }

  const caps = blockersOfNarrower
    .filter((b) => b.kind === "capability")
    .map((b) => b.ref);
  const mcp = blockersOfNarrower
    .filter((b) => b.kind === "mcp")
    .map((b) => b.ref);
  const graph = blockersOfNarrower.some((b) => b.kind === "graph");

  const drivers: string[] = [];
  if (caps.length > 0)
    drivers.push(`the capabilities it equips (${citeRefs(caps)})`);
  if (mcp.length > 0)
    drivers.push(`the MCP servers it calls (${citeRefs(mcp)})`);
  if (graph) drivers.push("its request to extend the graph");

  const because =
    drivers.length > 0
      ? `${drivers.join(", ")} would be blocked by a narrower role`
      : "it changes state rather than only reading";

  if (roleName === "Agent Contributor") {
    return (
      `Makes changes, so read-only is not enough: ${because}. ` +
      "High-risk actions still stop for human approval."
    );
  }

  return (
    `Runs ${unattended ? "unattended (a schedule/event trigger starts it, with nobody to answer an approval prompt)" : "with elevated trust"} ` +
    `and ${because}. High-risk vcs, billing, and secret capabilities still stop for approval even here.`
  );
}

/**
 * The narrowest system agent role that can actually run the drafted definition.
 *
 * Scored, not filtered: each role is charged for every thing the draft needs
 * that the role cannot deliver (2 for an outright deny, 1 for an approval stall
 * the agent has nobody to answer, 0 otherwise), and the NARROWEST role with the
 * LOWEST total cost wins. Scoring — rather than "the first role with zero
 * blockers" — is what makes the carve-out case come out right: an unattended
 * draft whose only high-risk capability is vcs/billing/secret is held at
 * require_approval by Contributor AND Operator alike, so escalating buys
 * nothing and the tie resolves to the narrower role.
 *
 * Roles are evaluated in `AGENT_ROLE_SPECS` order, which is
 * Observer → Contributor → Operator, i.e. narrowest first.
 */
export function suggestNarrowestAgentRole(
  draft: DraftAgentShape,
  capabilities: readonly CapabilityAgentMeta[],
): AgentRoleSuggestion {
  const metaByName = new Map(capabilities.map((c) => [c.name, c]));

  const requirements: CapabilityRequirement[] = [];
  const mcpRefs: string[] = [];
  for (const tool of draft.agentTools) {
    if (tool.type === "function") {
      const meta = metaByName.get(tool.ref);
      requirements.push({
        name: tool.ref,
        category: meta?.category ?? "",
        riskLevel: meta?.riskLevel ?? "medium",
      });
    } else if (tool.type === "mcp_server") {
      mcpRefs.push(tool.ref);
    }
    // `skill` / `agent` tools carry no category/riskLevel of their own and no
    // system role constrains those dimensions (skills.slugs / agents.refs are
    // unset on all three specs), so they never drive the suggestion.
  }

  const needsGraphWrite = draft.graphMode === "extend";
  const unattended = draft.triggerTypes.some(
    (t) => t === "schedule" || t === "event",
  );

  let best: RoleFit | null = null;
  for (const spec of AGENT_ROLE_SPECS) {
    const fit = collectBlockers(
      spec,
      requirements,
      mcpRefs,
      needsGraphWrite,
      unattended,
    );
    // Strictly-lower cost only, so a tie always keeps the narrower role.
    if (best === null || fit.cost < best.cost) best = fit;
    // A role with zero cost is fully adequate and, because we walk narrowest
    // first, no later role can beat it — stop.
    if (fit.cost === 0) break;
  }

  // AGENT_ROLE_SPECS is a non-empty compile-time constant; the fallback keeps
  // this total without an assertion.
  const chosen = best?.spec ?? AGENT_ROLE_SPECS[0]!;
  const chosenIdx = AGENT_ROLE_SPECS.indexOf(chosen);

  // Explain the escalation in terms of what the NEXT-NARROWER role could not
  // do — that is the honest answer to "why not something smaller?".
  const narrower = chosenIdx > 0 ? AGENT_ROLE_SPECS[chosenIdx - 1]! : null;
  const blockersOfNarrower = narrower
    ? collectBlockers(
        narrower,
        requirements,
        mcpRefs,
        needsGraphWrite,
        unattended,
      ).blockers
    : [];

  return {
    roleName: chosen.name,
    reason: buildReason(chosen.name, blockersOfNarrower, unattended),
  };
}
