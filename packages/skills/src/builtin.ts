/**
 * builtin — the bundle-safe source of truth for builtin skills.
 *
 * Builtin skill bodies are embedded as module data (builtin-skills.generated.ts)
 * so they travel with EVERY bundle. Handlers must resolve builtins through here,
 * never through a runtime `readdir(packages/skills/skills)` — serverless bundlers
 * drop that directory and a `readdir` against it returns ENOENT in prod, breaking
 * workspace skill seeding and the create-agent fallback.
 */
import { BUILTIN_SKILL_FILES } from "./builtin-skills.generated";
import { parseSkill } from "./loader";
import { createSkillRegistry, type SkillRegistry } from "./registry";
import type { Skill, SkillDbAdapter } from "./types";

/**
 * Parse every embedded builtin skill into a `Skill`. Pure and synchronous —
 * no filesystem, so it is safe in any runtime (Edge, serverless, CLI, test).
 */
export function embeddedBuiltinSkills(): Skill[] {
  return BUILTIN_SKILL_FILES.map((file) => {
    const skill = parseSkill(file.raw, { source: "builtin" });
    return {
      ...skill,
      references: file.references.map((ref) => ({
        path: ref.path,
        body: ref.body,
      })),
    };
  });
}

/** The builtin skill slugs — handy for tests and backfill assertions. */
export function builtinSkillSlugs(): string[] {
  return BUILTIN_SKILL_FILES.map((file) => file.slug);
}

/**
 * A registry backed by the embedded builtins (always present), optionally
 * layered with tenant-defined skills. This is the registry platform handlers
 * should use — it never touches the filesystem.
 */
export function createBuiltinSkillRegistry(
  dbAdapter?: SkillDbAdapter,
): SkillRegistry {
  return createSkillRegistry({ builtins: embeddedBuiltinSkills(), dbAdapter });
}
