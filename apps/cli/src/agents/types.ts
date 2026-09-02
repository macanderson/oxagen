/**
 * types.ts — The shape of a named agent definition.
 *
 * An agent is a reusable persona: a system prompt, an optional tool allowlist,
 * and an optional model. Defined as a canonical TOML artifact in
 * `~/.config/oxagen/agents/<name>.toml` (user scope) or
 * `<cwd>/.oxagen/agents/<name>.toml` (project scope, which wins) — see
 * `loader.ts`. The fleet planner dispatches a task to an agent by name;
 * `--agent <name>` runs a single turn as one.
 */

export interface AgentDefinition {
  /** Unique name; how the agent is referenced and dispatched. */
  name: string;
  /** What the agent is for — shown in `agent list` and given to the planner. */
  description: string;
  /** The agent's system prompt (the TOML `developer_instructions`). */
  systemPrompt: string;
  /**
   * Tool allowlist in permission syntax (`Read`, `Bash`, `mcp__github__*`).
   * `undefined` means inherit every available tool.
   */
  tools?: string[];
  /** Gateway model slug override for this agent. */
  model?: string;
  /**
   * Skill names this agent should have loaded (matched against the skills
   * discovered by `loadSkills`). `undefined` means no skills are pre-selected.
   */
  skills?: string[];
  /**
   * Keys into the global `mcpServers` map in settings.json — the MCP servers
   * this agent connects to. `undefined` means inherit the session's default
   * server set.
   *
   * NOTE: the agent TOML schema (`@oxagen/agent-artifacts`) has no field that
   * populates this, so `loader.ts` always leaves it undefined today. Consumers
   * (`agent/engine-runner.ts`, `repl/one-shot.ts`) therefore always take the
   * inherit-everything branch.
   */
  mcpServers?: string[];
  /** Where the definition came from (file path or "settings.json"). */
  source: string;
}
