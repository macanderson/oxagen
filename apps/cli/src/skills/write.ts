/**
 * write.ts — scaffolding for a new skill bundle (`oxagen skill new`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";

/**
 * Create `<dir|cwd/.oxagen/skills>/<name>/skill.toml` with a placeholder
 * manifest and report where it landed. Never clobbers: the `wx` flag turns an
 * existing manifest into `{ created: false }` rather than overwriting the
 * developer's work; any other filesystem error is rethrown.
 *
 * PRECONDITION: `name` must already be a validated bare identifier — it is
 * joined straight onto the skills root, so a caller that forwards raw user input
 * can escape that root with `..`. `commands/skill.ts` enforces
 * `/^[A-Za-z0-9][\w-]*$/` before calling; any new caller must do the same.
 */
export function scaffoldSkill(options: {
  name: string;
  cwd?: string;
  dir?: string;
}): { path: string; created: boolean } {
  const skillsDirectory =
    options.dir ?? join(options.cwd ?? process.cwd(), ".oxagen", "skills");
  const directory = join(skillsDirectory, options.name);
  const path = join(directory, "skill.toml");
  const content = serializeArtifactToml({
    schema_version: 1,
    kind: "skill",
    name: options.name,
    description: "Describe when this skill should be used.",
    instructions: `# ${options.name}\n\nDescribe the skill and the concrete steps to follow.`,
    references: [],
  });
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { path, created: false };
    throw error;
  }
}
