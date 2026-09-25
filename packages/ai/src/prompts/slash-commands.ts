/**
 * Slash-command registry — the single source of truth for the in-app
 * assistant's slash commands.
 *
 * Its one reader is the composer autocomplete menu in apps/app_deprecated
 * (`slash-command-menu.tsx`). The apps/app flyout has no slash menu, so
 * stella's system prompt no longer carries a slash-command table, and
 * `agentGuidance` is read by nothing outside that menu's tests.
 *
 * Slash commands are not a client-side router. The composer sends the literal
 * text (for example "/ci main"). ADR-043 removed the one client-handled
 * command (`/pin`, which named a repository sandbox that no longer exists).
 */

export interface SlashCommand {
  /** Command token typed after the slash, e.g. "ci" for "/ci". */
  readonly name: string;
  /** Human-readable argument hint shown in the menu, e.g. "<pr-number>". */
  readonly args?: string;
  /** One-line description shown in the menu. */
  readonly summary: string;
  /** The capability the command maps to, and a short instruction. */
  readonly agentGuidance: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "pr",
    args: "<pr-number>",
    summary: "Show pull-request stats — comments, checks, and files changed.",
    agentGuidance:
      "Call `get_pr` for the given PR number in the repository the user named or @-mentioned, and render the pr-stats card. If no repository is identifiable, ask which one — never guess.",
  },
  {
    name: "diff",
    args: "<pr-number>",
    summary: "Show the git diff (file patches) for a pull request.",
    agentGuidance:
      "Call `get_pr_diff` for the given PR number in the repository the user named or @-mentioned, and render the code-diff card.",
  },
  {
    name: "ci",
    args: "[ref]",
    summary: "Show CI / check status for a branch, commit, or PR head.",
    agentGuidance:
      "Call `get_ci_status` for the given ref in the repository the user named or @-mentioned (default to that repo's default branch when no ref is given) and render the ci-status card.",
  },
  {
    name: "repos",
    summary: "List the GitHub repositories connected to this workspace.",
    agentGuidance:
      "List the workspace's connected GitHub repositories (list_connections filtered to the GitHub connector) so the person can name one.",
  },
] as const;

/** Filter commands by a typed prefix (the text after the leading slash). */
export function matchSlashCommands(query: string): readonly SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
