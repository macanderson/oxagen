/**
 * loader.ts — Discover, parse, and inject loadable skills.
 *
 * A skill is a directory holding a `SKILL.md` manifest. We scan the same
 * directories the config indexer's `scanSkills` uses — the dir lists live here
 * ({@link WORKSPACE_SKILL_DIRS} / {@link USER_SKILL_DIRS}) as the single source
 * of truth, and `config/indexer.ts` imports them so the two never drift.
 *
 * Precedence, lowest → highest (later overrides by name):
 *   1. ~/.claude/skills, ~/.oxagen/skills   (user)
 *   2. .agents/skills, .claude/skills, .oxagen/skills   (workspace)
 *
 * `loadSkills` parses each SKILL.md's frontmatter + body via the shared
 * markdown-registry reader — the same parser the agents/commands loaders use.
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readMarkdownFile } from "../lib/markdown-registry.js";
import type { Skill } from "./types.js";

/**
 * Workspace-scope skill directories, relative to the project root. Shared with
 * `config/indexer.ts` (its `DEFAULT_WORKSPACE_SOURCES.skills`) so the scan set
 * has a single definition. Order is low → high precedence.
 */
export const WORKSPACE_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".oxagen/skills",
] as const;

/**
 * User-scope skill directories, relative to the home dir (the "~/" prefix is
 * expanded by the loader). Shared with `config/indexer.ts`
 * (`DEFAULT_USER_SOURCES.skills`).
 */
export const USER_SKILL_DIRS = ["~/.claude/skills", "~/.oxagen/skills"] as const;

export interface LoadSkillsOptions {
  /** Project root (where `.oxagen`/`.claude` live). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the "~" base used to expand user-scope dirs (testing). Defaults to homedir(). */
  userHomeDir?: string;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate child directories of `dir` (non-recursive), sorted; empty if unreadable. */
function childDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((f) => join(dir, f))
    .filter(safeIsDir)
    .sort();
}

/** Resolve the scan directories, low → high precedence (user first, workspace last). */
function skillDirs(cwd: string, homeDir: string): string[] {
  return [
    ...USER_SKILL_DIRS.map((e) => join(homeDir, e.slice(2))),
    ...WORKSPACE_SKILL_DIRS.map((e) => join(cwd, e)),
  ];
}

function skillFromDir(skillDir: string): Skill | null {
  const manifest = join(skillDir, "SKILL.md");
  const fm = readMarkdownFile(manifest);
  if (!fm) return null;
  const { data, body } = fm;
  const name = data["name"] || basename(skillDir);
  if (!name || !body.trim()) return null; // a usable skill needs a name and instructions
  return {
    name,
    description: data["description"] ?? "",
    body,
    path: skillDir,
    source: manifest,
  };
}

/**
 * Load every skill visible from `cwd`, merged by name across sources
 * (workspace overrides user). Returns the registry keyed by skill name.
 */
export function loadSkills(opts: LoadSkillsOptions = {}): Map<string, Skill> {
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.userHomeDir ?? homedir();
  const registry = new Map<string, Skill>();
  for (const dir of skillDirs(cwd, homeDir)) {
    for (const skillDir of childDirs(dir)) {
      const skill = skillFromDir(skillDir);
      if (skill) registry.set(skill.name, skill);
    }
  }
  return registry;
}

/** Resolve one skill by name (or null). Convenience over {@link loadSkills}. */
export function getSkill(
  name: string,
  opts: LoadSkillsOptions = {},
): Skill | null {
  return loadSkills(opts).get(name) ?? null;
}

/**
 * Render a system-prompt block for a set of skills: a compact "Available
 * skills" list of every skill's name + description, plus the FULL body of only
 * those skills named in `selector`. Returns "" when there are no skills, so a
 * caller can safely concatenate it unconditionally.
 *
 * @param skills   The skills to advertise (e.g. `[...loadSkills().values()]`).
 * @param selector Names whose full instructions to inline; omit for none.
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
      (s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`,
    ),
  ];
  const selected = new Set(selector ?? []);
  if (selected.size > 0) {
    for (const s of ordered) {
      if (!selected.has(s.name)) continue;
      sections.push("", `### Skill: ${s.name}`, "", s.body.trim());
    }
  }
  return sections.join("\n");
}
