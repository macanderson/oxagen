/**
 * Slash-command registry — the single source of truth for the in-app
 * assistant's slash commands.
 *
 * Consumed in TWO places that must never drift:
 *  1. The composer autocomplete menu (apps/app — `slash-command-menu.tsx`),
 *     which lets the user discover and insert a command.
 *  2. The chat system prompt (`chatSystemPrompt`), which documents each command
 *     so the AGENT knows what tool to call when it receives `/ci main` etc.
 *
 * Slash commands are NOT a hard client-side router: the composer sends the
 * literal text (e.g. "/ci main") and the agent — told about these commands in
 * its system prompt — maps it to the right capability (repo.ci.status, …). The
 * only exception is `clientAction` commands (e.g. `/pin`), which the composer
 * intercepts and handles locally instead of sending.
 */

export interface SlashCommand {
  /** Command token typed after the slash, e.g. "ci" for "/ci". */
  readonly name: string;
  /** Human-readable argument hint shown in the menu, e.g. "<pr-number>". */
  readonly args?: string;
  /** One-line description shown in the menu and the system-prompt table. */
  readonly summary: string;
  /**
   * For agent-interpreted commands: the capability the agent should call and a
   * short instruction. Documented verbatim in the system prompt so the agent
   * resolves the command deterministically. Omitted for `clientAction`s.
   */
  readonly agentGuidance?: string;
  /**
   * When set, the composer handles the command locally (does not send it as a
   * message). `"pin"` opens/toggles the pin context bar.
   */
  readonly clientAction?: "pin";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "pr",
    args: "<pr-number>",
    summary: "Show pull-request stats — comments, checks, and files changed.",
    agentGuidance:
      "Call `get_pr` for the given PR number in the pinned repository and render the pr-stats card. If no repository is pinned, ask the user to pin one (or name owner/repo).",
  },
  {
    name: "diff",
    args: "<pr-number>",
    summary: "Show the git diff (file patches) for a pull request.",
    agentGuidance:
      "Call `get_pr_diff` for the given PR number in the pinned repository and render the code-diff card.",
  },
  {
    name: "ci",
    args: "[ref]",
    summary: "Show CI / check status for a branch, commit, or PR head.",
    agentGuidance:
      "Call `get_ci_status` for the given ref in the pinned repository (default to the repo's default branch when no ref is given) and render the ci-status card.",
  },
  {
    name: "repos",
    summary: "List the GitHub repositories connected to this workspace.",
    agentGuidance:
      "List the workspace's connected GitHub repositories (list_connections filtered to the GitHub connector) so the user can pick one to pin.",
  },
  {
    name: "pin",
    summary: "Pin the selected org/repo + environment to this chat.",
    clientAction: "pin",
  },
] as const;

/** Filter commands by a typed prefix (the text after the leading slash). */
export function matchSlashCommands(query: string): readonly SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

/**
 * The "## Slash commands" section injected into the chat system prompt so the
 * agent can act on a slash command the user typed. Built from the same registry
 * the composer menu uses, so the two can never disagree.
 */
export function slashCommandsPromptSection(): string {
  const rows = SLASH_COMMANDS.filter((c) => c.agentGuidance)
    .map(
      (c) =>
        `- \`/${c.name}${c.args ? ` ${c.args}` : ""}\` — ${c.agentGuidance}`,
    )
    .join("\n");
  return `## Slash commands

The user can type a slash command in the composer. When a message begins with one of these, treat it as that command and act immediately — do not ask the user to rephrase in natural language:

${rows}

These repo commands operate on the repository pinned to the chat (shown in the composer's context bar). If nothing is pinned and the command needs a repo, ask the user to pin one — never guess a repository.`;
}
