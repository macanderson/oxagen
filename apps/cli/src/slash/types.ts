/**
 * types.ts — The shape of a user-defined slash command.
 *
 * A slash command is a reusable prompt template invoked as `/name args` in the
 * REPL (or `oxagen command run name args`). Defined in markdown under
 * `.oxagen/commands/<name>.md` (or `.claude/commands`, `~/.config/oxagen/commands`).
 * The body is the template; `$ARGUMENTS` and `$1`…`$9` are substituted from the
 * invocation arguments.
 */

export interface SlashCommand {
  /** Command name (invoked as `/name`). */
  name: string;
  /** One-line description shown in `command list`. */
  description: string;
  /** The prompt template (the markdown body). */
  template: string;
  /** Optional hint shown in help, e.g. "<file> [focus]". */
  argumentHint?: string;
  /** Optional model override when this command runs. */
  model?: string;
  /** Where the definition came from (file path). */
  source: string;
}
