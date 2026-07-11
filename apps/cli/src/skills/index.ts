/**
 * @module skills — Loadable skills for the CLI.
 *
 * Directories of `SKILL.md` reference material discovered from `.agents/skills`,
 * `.claude/skills`, `.oxagen/skills` (workspace) and `~/.claude/skills`,
 * `~/.oxagen/skills` (user), injected into the agent's system prompt via
 * {@link skillsPromptBlock} and managed with `oxagen skill list|show|new`.
 */
export type { Skill } from "./types.js";
export {
  loadSkills,
  getSkill,
  skillsPromptBlock,
  WORKSPACE_SKILL_DIRS,
  USER_SKILL_DIRS,
  type LoadSkillsOptions,
} from "./loader.js";
export { scaffoldSkill } from "./write.js";
