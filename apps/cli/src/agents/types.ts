/**
 * types.ts — The shape of a named agent definition.
 *
 * An agent is a reusable persona: a system prompt, an optional tool allowlist,
 * and an optional model. Defined in markdown (`.oxagen/agents/<name>.md`,
 * `.claude/agents/*.md` for Claude Code interop, or `~/.config/oxagen/agents/`)
 * or inline in `settings.json` under `agents`. The fleet planner dispatches a
 * task to an agent by name; `--agent <name>` runs a single turn as one.
 */

export interface AgentDefinition {
  /** Unique name; how the agent is referenced and dispatched. */
  name: string;
  /** What the agent is for — shown in `agent list` and given to the planner. */
  description: string;
  /** The agent's system prompt (the markdown body, or inline `prompt`). */
  systemPrompt: string;
  /**
   * Tool allowlist in permission syntax (`Read`, `Bash`, `mcp__github__*`).
   * `undefined` means inherit every available tool.
   */
  tools?: string[];
  /** Gateway model slug override for this agent. */
  model?: string;
  /** Where the definition came from (file path or "settings.json"). */
  source: string;
}
