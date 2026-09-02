/**
 * types.ts — The shape of a user-defined slash command.
 *
 * A slash command is a reusable prompt template invoked as `/name args` in the
 * REPL (or `oxagen command run name args`). Defined as a canonical TOML
 * artifact in `~/.config/oxagen/commands/<name>.toml` (user scope) or
 * `<cwd>/.oxagen/commands/<name>.toml` (project scope, which wins) — see
 * `loader.ts`. The artifact's `prompt` is the template; `$ARGUMENTS` and
 * `$1`…`$9` are substituted from the invocation arguments.
 */

export interface SlashCommand {
  /** Command name (invoked as `/name`). */
  name: string;
  /** One-line description shown in `command list`. */
  description: string;
  /** The prompt template (the TOML `prompt`). */
  template: string;
  /** Optional hint shown in help, e.g. "<file> [focus]". */
  argumentHint?: string;
  /** Optional model override when this command runs. */
  model?: string;
  /** Where the definition came from (file path). */
  source: string;
}
