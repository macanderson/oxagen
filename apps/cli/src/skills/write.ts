import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";

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
