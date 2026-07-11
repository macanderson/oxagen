/**
 * types.ts — The shape of a loadable skill.
 *
 * A skill is a directory containing a `SKILL.md` manifest with `name` /
 * `description` frontmatter and a markdown body of instructions (the Claude
 * Code skill format). Skills are discovered from `.agents/skills`,
 * `.claude/skills`, `.oxagen/skills` (workspace) and `~/.claude/skills`,
 * `~/.oxagen/skills` (user) — the same directories the config indexer scans.
 *
 * Unlike an agent (a persona) or a slash command (a prompt template), a skill
 * is reference material injected into the agent's system prompt: its
 * description is always listed; its full body is included only when the skill
 * is explicitly selected (see {@link skillsPromptBlock}).
 */

export interface Skill {
  /** Unique name (frontmatter `name`, else the directory basename). */
  name: string;
  /** One-line description — listed in `skill list` and the compact prompt block. */
  description: string;
  /** The markdown body of SKILL.md (the full skill instructions). */
  body: string;
  /** Absolute path to the skill's directory. */
  path: string;
  /** Absolute path to the SKILL.md manifest. */
  source: string;
}
