/**
 * agent-picker-types.ts — the canonical shape of a selectable agent, shared by
 * the agent-picker components (panel, chip, gallery), the composer, and the
 * server loader (`_shared/agent-options-data.ts`).
 *
 * Kept in a pure, dependency-free module (no "use client", no React) so the
 * server loader can import `AgentOption` as a TYPE without pulling any client
 * code into its bundle.
 */

/**
 * One of an agent's allowlisted tools, as returned by `list_agent_defs`
 * (`toolRefs`). `type` groups it for the capability strip; `ref` is the raw
 * slug/id (a capability name or an MCP server name) — prettified for display,
 * never shown as a bare UUID. ADR-041 retired the `skill` and `agent`
 * (subagent) kinds along with the runtime; `type` stays a string so a legacy
 * row read back from an old definition still renders instead of crashing.
 */
export interface AgentToolRef {
  type: string;
  ref: string;
}

/**
 * A selectable agent in the composer's picker. Selecting one binds the
 * conversation to that agent's definition — its instructions, graph scope, and
 * tool allowlist; the "Default assistant" (no agent) uses the workspace
 * defaults.
 */
export interface AgentOption {
  /** Public identifier (`agt_…`) forwarded to the stream route as `agentId`. */
  agentId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Free-form type discriminator (`custom`, `interactive_chat`, …). */
  agentType: string;
  /** https:// URL or `avatar:v1:<json>` designed-avatar string; null when unset. */
  avatarUrl: string | null;
  /** LLM-inferred one-line summary; null when not yet inferred. */
  summary: string | null;
  /** True for a platform-managed agent (vs. a user-authored custom one). */
  managed: boolean;
  /**
   * The agent's allowlisted tools, grouped by kind for the capability
   * strip. Populated from `list_agent_defs.toolRefs`; defaults to `[]` for a
   * workspace whose agents carry no tools.
   */
  toolRefs: AgentToolRef[];
}
