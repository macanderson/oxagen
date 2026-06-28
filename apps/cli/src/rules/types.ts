/**
 * types.ts — Workspace rules Stella retrieves, injects, and enforces.
 *
 * A rule is a binding instruction for the coding agent. It is always injected
 * into the system prompt (Tier 1). When it carries a `guard`, it is also
 * hard-enforced at the tool boundary (Tier 2) by the same permission gate used
 * for settings permissions and MCP tools — a violating tool call is blocked and
 * the rule text is returned to the model so it self-corrects.
 *
 * Rules are authored as markdown under `.oxagen/rules/*.md` today; learned
 * procedural rules (engram promotion) will flow through the same retrieval +
 * enforcement path once memory sync lands (see
 * docs/specs/stella-graph-memory-sync/spec.md, Phase 4).
 */

/** A machine-enforceable guard that blocks a tool call that would violate the rule. */
export interface RuleGuard {
  /**
   * Canonical tool the guard applies to: `Bash`, `Write`, `Edit`, `Read`, or
   * `*` for any. Matched against the tool's canonical permission name.
   */
  tool?: string;
  /** Block a file tool (Write/Edit/Read) whose path matches this glob. */
  denyPathGlob?: string;
  /** Block a Bash command matching this glob. */
  denyCommandGlob?: string;
}

export interface Rule {
  /** Rule name (the filename or frontmatter `name`). */
  id: string;
  /** Short description shown in `rules list`. */
  description: string;
  /** The rule statement injected into the system prompt. */
  text: string;
  /** Optional hard guard (Tier 2). Absent ⇒ prompt-only (Tier 1). */
  guard?: RuleGuard;
  /** Where the rule came from (file path). */
  source: string;
}
