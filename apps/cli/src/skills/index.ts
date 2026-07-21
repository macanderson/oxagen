/**
 * @module skills — Loadable skills for the CLI.
 *
 * Canonical `skill.toml` bundles discovered from Oxagen workspace and user
 * config roots, injected into the agent's system prompt via
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
