// Pure config-application for launching a PUBLISHED agent into a chat session.
//
// When a chat turn carries an `agentId`, the stream route loads that agent's
// definition (agent.definition.get) and merges its config into the turn: the
// agent's instructions ride the system prompt, its equipped skills + MCP
// servers extend what the model can reach, and a `code` agent — and ONLY a
// code agent — puts the turn in coding flow (the agent definition is the
// sole gate; the request cannot force code mode on its own). This module is
// the SINGLE pure seam that computes the merged values so
// it can be unit-tested in isolation — the route only does the async load, the
// try/catch, and the wiring of these outputs into resolvePrompt/materializeTools.
//
// Every merge is ADDITIVE and idempotent for skills/instructions: an unbound
// turn never calls this, and a bound turn only ever widens (union) skills and
// appends instructions.
//
// MCP servers are the exception (Agent RBAC Phase 4a, spec §3.7): when the
// caller supplies the run's effective role `mcp` rules, the merged server
// allowlist becomes an INTERSECTION — the union of body + agent servers is
// then filtered against the rules, and a server whose EVERY tool is denied
// drops from the binding entirely. The fully-denied check is the shared
// engine's `mcpServerFullyDenied` (@oxagen/oxagen/iam) — the same
// first-match-wins rule evaluation the resolver and the runtime MCP bridge
// use, so there is exactly ONE matcher in the system. Without an `mcp` input
// (no agent-run context, or a run with no rules) the behavior is
// byte-identical to the historical additive union.

import { mcpServerFullyDenied } from "@oxagen/oxagen/iam";
import type { EffectiveMcpScope } from "@oxagen/oxagen/iam";

/**
 * The slice of an `agent.definition.get` output this binding needs. Kept
 * structurally minimal (not the full contract type) so the helper is trivially
 * testable and never couples to fields it doesn't read.
 */
export interface AgentBindingDefinition {
  /** Agent kind. `"coding"` forces code mode on for the turn. */
  agentType: string;
  config: {
    /** Optional system prompt baked into the definition (may be null/empty). */
    instructions?: string | null;
    /** Everything the agent loads. Only `skill` + `mcp_server` entries are read
     *  here (functions/subagents are materialized through the normal kernel). */
    agentTools?: Array<{ type: string; ref: string }>;
  };
}

/**
 * The run's effective MCP rule ceiling + the server-name lookup needed to
 * evaluate it. `scope` comes from the agent run's cached IAM resolution
 * (ctx.agentRun.resolution → EffectivePermissions.resourceScope.mcp);
 * `serverNamesById` maps each allowlist entry (mcp_servers publicId) to the
 * server's name, which is what "server:tool" rule patterns address. An id
 * with no name mapping is KEPT (conservative — the per-tool-call gate in the
 * runtime MCP bridge is the authoritative enforcement and still evaluates
 * every invocation; a binding drop is UX narrowing, never the security
 * boundary).
 */
export interface AgentBindingMcpInput {
  scope: EffectiveMcpScope | undefined;
  serverNamesById: Readonly<Record<string, string>>;
}

export interface AgentBindingInput {
  /** The bound agent definition. */
  def: AgentBindingDefinition;
  /** Skill slugs the request already pinned (body.skills). */
  skills: string[];
  /** Per-turn MCP server allowlist the request already set (activeServerIds). */
  serverAllowlist: string[];
  /**
   * Effective role MCP rules for the run (Agent RBAC Phase 4a). Absent — the
   * normal case for interactive chat turns, which carry no agent-run IAM
   * context today — the server allowlist stays the historical additive union,
   * byte-identical. Present, the union is intersected against the rules and
   * fully-denied servers drop.
   */
  mcp?: AgentBindingMcpInput;
}

export interface AgentBindingResult {
  /** Instructions to append to the system-prompt baseline. Empty when the
   *  definition carries none. The route wraps this in a labelled section and
   *  places it AFTER the base (chat/coding) prompt so the coding contract always
   *  sits above the customer instructions. */
  instructions: string;
  /** Merged, de-duplicated, max-5-capped skill slugs (body ∪ agent skills). */
  skills: string[];
  /** Merged, de-duplicated MCP server allowlist (body ∪ agent mcp_servers). */
  serverAllowlist: string[];
  /** True when the turn should run in code mode — i.e. the bound agent's
   *  definition marks it a code agent. The agent definition is the ONLY gate:
   *  a request `code` payload without a code agent never enters coding flow.
   *  The route still only attaches the sandbox when a repo/env is bound — a
   *  code agent with no repo degrades to the code-mode PROMPT with no
   *  filesystem tools. */
  codeMode: boolean;
}

/** Matches the stream route's BodySchema `skills` cap — bound prompt bloat. */
const MAX_PINNED_SKILLS = 5;

/** Union two string lists preserving first-seen order and dropping duplicates
 *  and empty entries. `base` entries win their position over `extra`. */
function unionOrdered(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...base, ...extra]) {
    const v = value.trim();
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Merge a bound agent definition into the current turn's config. Pure: no I/O,
 * no throw — the caller owns the async load and the fail-open try/catch.
 */
export function applyAgentBinding(
  input: AgentBindingInput,
): AgentBindingResult {
  const { def, skills, serverAllowlist } = input;
  const agentTools = def.config.agentTools ?? [];

  const skillRefs = agentTools
    .filter((t) => t.type === "skill")
    .map((t) => t.ref);
  const serverRefs = agentTools
    .filter((t) => t.type === "mcp_server")
    .map((t) => t.ref);

  const instructions = (def.config.instructions ?? "").trim();

  // Historical additive union first (body entries keep position priority)…
  let mergedServers = unionOrdered(serverAllowlist, serverRefs);
  // …then, when the run carries an effective MCP rule ceiling, INTERSECT:
  // drop every server whose EVERY tool the rules deny (Agent RBAC Phase 4a).
  // The shared engine (mcpServerFullyDenied, @oxagen/oxagen/iam) is the same
  // first-match-wins evaluation the runtime MCP bridge applies per call, so
  // the binding can never diverge from the per-call policy. No `mcp` input →
  // this branch never runs → byte-identical additive behavior.
  const mcpScope = input.mcp?.scope;
  if (mcpScope !== undefined) {
    const namesById = input.mcp?.serverNamesById ?? {};
    mergedServers = mergedServers.filter((serverId) => {
      const name = namesById[serverId];
      // Unknown id→name mapping: keep the server (conservative — the
      // per-tool-call gate still evaluates every invocation; see
      // AgentBindingMcpInput).
      if (name === undefined) return true;
      return !mcpServerFullyDenied(mcpScope, name);
    });
  }

  return {
    instructions,
    // Body-pinned skills keep priority; the cap bounds prompt size exactly like
    // the request schema does, so a skill-heavy agent can't blow the budget.
    skills: unionOrdered(skills, skillRefs).slice(0, MAX_PINNED_SKILLS),
    serverAllowlist: mergedServers,
    // Coding flow derives from the agent DEFINITION alone — the request can
    // never force it. Read-tolerant of the earlier "coding" spelling; "code"
    // is the convention.
    codeMode: def.agentType === "code" || def.agentType === "coding",
  };
}
