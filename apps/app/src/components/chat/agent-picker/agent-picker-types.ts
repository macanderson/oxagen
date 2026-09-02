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
 * One of an agent's configured tools, as returned by `list_agent_defs`
 * (`toolRefs`). `type` groups it for the capability strip; `ref` is the raw
 * slug/id (e.g. a skill slug, an MCP server name, a function name) — prettified
 * for display, never shown as a bare UUID.
 */
export interface AgentToolRef {
  type: "function" | "mcp_server" | "skill" | "agent";
  ref: string;
}

/**
 * A selectable agent in the composer's picker. Selecting a code agent
 * (`isCode`) reveals the repo/environment session setup and the composer's
 * code tooling; a chat agent — or the "Default assistant" (no agent) — keeps
 * the plain composer.
 */
export interface AgentOption {
  /** Public identifier (`agt_…`) forwarded to the stream route as `agentId`. */
  agentId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Free-form type discriminator (`custom`, `interactive_chat`, `code`, …). */
  agentType: string;
  /** True for a code agent (agentType === "code", see `isCodeAgentType`). */
  isCode: boolean;
  /** https:// URL or `avatar:v1:<json>` designed-avatar string; null when unset. */
  avatarUrl: string | null;
  /** LLM-inferred one-line summary; null when not yet inferred. */
  summary: string | null;
  /** True for a platform-managed agent (vs. a user-authored custom one). */
  managed: boolean;
  /**
   * The agent's configured tools/skills, grouped by kind for the capability
   * strip. Populated from `list_agent_defs.toolRefs`; defaults to `[]` for a
   * workspace whose agents carry no tools.
   */
  toolRefs: AgentToolRef[];
}
