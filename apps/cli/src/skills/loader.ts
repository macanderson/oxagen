import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import type { Skill } from "./types.js";

export const WORKSPACE_SKILL_DIRS = [".oxagen/skills"] as const;
export const USER_SKILL_DIRS = ["~/.config/oxagen/skills"] as const;

export interface LoadSkillsOptions {
  cwd?: string;
  userHomeDir?: string;
}

function childDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  try {
    return readdirSync(directory)
      .map((name) => join(directory, name))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function loadDirectory(directory: string, registry: Map<string, Skill>): void {
  for (const skillDirectory of childDirectories(directory)) {
    const source = join(skillDirectory, "skill.toml");
    try {
      const artifact = parseArtifactToml(readFileSync(source, "utf8"));
      if (artifact.kind !== "skill") continue;
      registry.set(artifact.name, {
        name: artifact.name,
        description: artifact.description,
        body: artifact.instructions,
        path: skillDirectory,
        source,
      });
    } catch {
      // A corrupt item is isolated and cannot hide valid sibling bundles.
    }
  }
}

export function loadSkills(
  options: LoadSkillsOptions = {},
): Map<string, Skill> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.userHomeDir ?? homedir();
  const registry = new Map<string, Skill>();
  loadDirectory(join(home, ".config", "oxagen", "skills"), registry);
  loadDirectory(join(cwd, ".oxagen", "skills"), registry);
  return registry;
}

export function getSkill(
  name: string,
  options: LoadSkillsOptions = {},
): Skill | null {
  return loadSkills(options).get(name) ?? null;
}

export function skillsPromptBlock(
  skills: Skill[],
  selector?: string[],
): string {
  if (skills.length === 0) return "";
  const ordered = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const sections: string[] = [
    "## Available skills",
    "",
    "The following skills are available. Load a skill's full instructions before applying it.",
    "",
    ...ordered.map(
      (skill) =>
        `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`,
    ),
  ];
  const selected = new Set(selector ?? []);
  for (const skill of ordered) {
    if (!selected.has(skill.name)) continue;
    sections.push("", `### Skill: ${skill.name}`, "", skill.body.trim());
  }
  return sections.join("\n");
}
