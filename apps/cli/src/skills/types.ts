/**
 * types.ts — The shape of a loadable skill.
 *
 * A skill is a directory containing a canonical `skill.toml` manifest.
 * Normal discovery reads only `.oxagen/skills` in the workspace and Oxagen's
 * user config directory; foreign platform layouts are importer inputs only.
 *
 * Unlike an agent (a persona) or a slash command (a prompt template), a skill
 * is reference material injected into the agent's system prompt: its
 * description is always listed; its full body is included only when the skill
 * is explicitly selected (see {@link skillsPromptBlock}).
 */

export interface Skill {
  /** Unique canonical artifact name. */
  name: string;
  /** One-line description — listed in `skill list` and the compact prompt block. */
  description: string;
  /** The full skill instructions projected from TOML. */
  body: string;
  /** Absolute path to the skill's directory. */
  path: string;
  /** Absolute path to the skill.toml manifest. */
  source: string;
}
