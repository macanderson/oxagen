/**
 * loader.ts — Discover and parse user-defined slash commands.
 *
 * Sources, lowest → highest precedence (later overrides by name):
 *   1. ~/.config/oxagen/commands/*.md   (user)
 *   2. <project>/.claude/commands/*.md  (Claude Code interop)
 *   3. <project>/.oxagen/commands/*.md  (oxagen project commands)
 *
 * Reuses the agent loader's frontmatter parser. Frontmatter keys: description,
 * `argument-hint`, model. The body is the prompt template.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { parseFrontmatter } from "../agents/loader.js";
import type { SlashCommand } from "./types.js";

export interface LoadCommandsOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user commands dir (testing). */
  userCommandsDir?: string;
}

function defFromFile(path: string): SlashCommand | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const name = data["name"] || basename(path).replace(/\.md$/, "");
  if (!name || !body.trim()) return null; // a command needs a name and a template
  return {
    name,
    description: data["description"] ?? "",
    template: body,
    argumentHint: data["argument-hint"] || undefined,
    model: data["model"] || undefined,
    source: path,
  };
}

function loadDir(dir: string, into: Map<string, SlashCommand>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files.sort()) {
    const def = defFromFile(join(dir, file));
    if (def) into.set(def.name, def);
  }
}

/** Load every slash command visible from `cwd`, merged by name across sources. */
export function loadCommands(opts: LoadCommandsOptions = {}): Map<string, SlashCommand> {
  const cwd = opts.cwd ?? process.cwd();
  const userDir = opts.userCommandsDir ?? join(homedir(), ".config", "oxagen", "commands");
  const registry = new Map<string, SlashCommand>();
  loadDir(userDir, registry);
  loadDir(join(cwd, ".claude", "commands"), registry);
  loadDir(join(cwd, ".oxagen", "commands"), registry);
  return registry;
}
