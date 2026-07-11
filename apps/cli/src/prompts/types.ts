/**
 * types.ts — The shape of a saved prompt.
 *
 * A saved prompt is a reusable piece of prompt text stored as markdown under
 * `.oxagen/prompts/<name>.md` (or `.claude/prompts`, `~/.config/oxagen/prompts`),
 * the same precedence idiom the slash-command and agent registries use. Unlike a
 * slash command it is not invoked as `/name` — it is a named, describable snippet
 * a human recalls with `oxagen prompt show <name>` and pastes/feeds into a turn.
 * The frontmatter carries a `description` and an optional `argument-hint`; the
 * body is the prompt text itself.
 */

export interface SavedPrompt {
  /** Unique name; how the prompt is referenced (`oxagen prompt show <name>`). */
  name: string;
  /** One-line description shown in `prompt list`. */
  description: string;
  /** The prompt text (the markdown body). */
  body: string;
  /** Optional hint shown in help, e.g. "<ticket-id> [focus]". */
  argumentHint?: string;
  /** Where the definition came from (file path). */
  source: string;
}
