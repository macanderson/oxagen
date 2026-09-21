import { readSkillFrontmatter } from "@oxagen/oxagen/skill-frontmatter";
export { readSkillFrontmatter } from "@oxagen/oxagen/skill-frontmatter";
import {
  compareSemver,
  estimateSkillTokens,
  GRANTING_FRONTMATTER_KEYS,
  parseSemver,
  scanForSecrets,
  type SkillCheck,
} from "@oxagen/oxagen/contracts/skill.propose";

/**
 * The six checks over a proposed SKILL.md and the files beside it, as the
 * handler runs them before anything reaches GitHub. `replacing` is the
 * version merged on the production branch today, or null for a new skill;
 * `budget` is the workspace's search budget in tokens. The digest check here
 * asserts the canonical bytes can be hashed (the file is text with LF line
 * ends); the digest itself is taken again at merge.
 */
export function checkSkill(args: {
  name: string;
  body: string;
  files: readonly { path: string; content: string }[];
  replacing: string | null;
  budget: number;
}): SkillCheck[] {
  const fm = readSkillFrontmatter(args.body);
  const f = fm?.fields ?? {};
  const version = f.version === undefined ? null : parseSemver(f.version);
  const replaced = args.replacing === null ? null : parseSemver(args.replacing);

  const frontmatter: SkillCheck =
    fm === null
      ? { name: "frontmatter", passed: false, code: "frontmatter_missing" }
      : !f.name || !f.version || !f.scope
        ? {
            name: "frontmatter",
            passed: false,
            code: "frontmatter_incomplete",
          }
        : f.name !== args.name
          ? { name: "frontmatter", passed: false, code: "name_mismatch" }
          : { name: "frontmatter", passed: true, code: null };

  const versionCheck: SkillCheck =
    version === null
      ? { name: "version", passed: false, code: "version_not_semver" }
      : replaced !== null && compareSemver(version, replaced) <= 0
        ? { name: "version", passed: false, code: "version_not_greater" }
        : { name: "version", passed: true, code: null };

  const digest: SkillCheck = args.body.includes("\u0000")
    ? { name: "digest", passed: false, code: "not_text" }
    : { name: "digest", passed: true, code: null };

  const granting = GRANTING_FRONTMATTER_KEYS.find((k) => k in f);
  const grants: SkillCheck =
    granting === undefined
      ? { name: "grants", passed: true, code: null }
      : { name: "grants", passed: false, code: `grants_${granting}` };

  const leaked = [args.body, ...args.files.map((x) => x.content)]
    .map(scanForSecrets)
    .find((k) => k !== null);
  const secrets: SkillCheck =
    leaked === undefined
      ? { name: "secrets", passed: true, code: null }
      : { name: "secrets", passed: false, code: `secret_${leaked}` };

  const load: SkillCheck =
    estimateSkillTokens(args.body) > args.budget
      ? { name: "load_cost", passed: false, code: "over_budget" }
      : { name: "load_cost", passed: true, code: null };

  return [frontmatter, versionCheck, digest, grants, secrets, load];
}
