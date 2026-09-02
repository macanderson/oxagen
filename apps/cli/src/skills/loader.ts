/**
 * loader.ts — skill discovery for the CLI.
 *
 * Scans the two canonical roots (`~/.config/oxagen/skills` and the workspace's
 * `.oxagen/skills`) for `<name>/skill.toml` bundles and projects each into a
 * {@link Skill}. Discovery is one level deep on purpose: a skill is a directory
 * holding a manifest, not a tree to be crawled, which keeps the scan O(number of
 * skills) on every turn. Foreign layouts (another vendor's `SKILL.md`) are never
 * read here — they are inputs to the importer, not to discovery.
 *
 * The rendered prompt section lives in {@link skillsPromptBlock}: descriptions
 * always, bodies only on request.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import type { Skill } from "./types.js";

/**
 * Workspace skill roots, relative to the repo/cwd. Display/config strings for
 * `config/indexer.ts`'s "where skills come from" listing — {@link loadSkills}
 * joins the same segments itself rather than parsing these back apart.
 */
export const WORKSPACE_SKILL_DIRS = [".oxagen/skills"] as const;
/**
 * User-level skill roots, written the way a person types them (`~`-relative).
 * Same contract as {@link WORKSPACE_SKILL_DIRS}: presentation only — the `~` is
 * NOT expanded here, and {@link loadSkills} resolves the real path from
 * `userHomeDir`/`os.homedir()` instead.
 */
export const USER_SKILL_DIRS = ["~/.config/oxagen/skills"] as const;

export interface LoadSkillsOptions {
  /** Workspace root to scan for `.oxagen/skills`. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory holding `.config/oxagen/skills`. Defaults to `os.homedir()`. */
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

/**
 * Read every `<directory>/<name>/skill.toml` into `registry`, keyed by the
 * artifact's own `name` (which need not match its directory name). A later call
 * overwrites an earlier one on a name collision — that is how the workspace
 * root shadows the user root in {@link loadSkills}.
 */
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

/**
 * Discover every skill visible from `cwd`. The user root is read first and the
 * workspace root second, so a workspace skill SHADOWS a user skill of the same
 * name — a repo can always override what a developer installed globally.
 *
 * A directory with no `skill.toml`, an unparseable manifest, or a manifest whose
 * `kind` is not `"skill"` is skipped silently: one bad bundle must never hide
 * its valid siblings. Fully synchronous — callers run it once per turn, not per
 * step.
 */
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

/**
 * Look one skill up by canonical name, or null when nothing provides it. Runs a
 * full {@link loadSkills} scan per call, so resolve a batch from one
 * `loadSkills` map rather than calling this in a loop.
 */
export function getSkill(
  name: string,
  options: LoadSkillsOptions = {},
): Skill | null {
  return loadSkills(options).get(name) ?? null;
}

/**
 * Render the system-prompt skills section: every skill's name + description is
 * always listed, and only the skills named in `selector` additionally get their
 * full instructions inlined (progressive disclosure — the model asks for a body
 * it does not already have). Returns "" when there are no skills at all.
 */
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
