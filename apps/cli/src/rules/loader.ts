/**
 * loader.ts — Discover and parse workspace rules.
 *
 * Sources, lowest → highest precedence (later overrides by name):
 *   1. ~/.config/oxagen/rules/*.md   (user)
 *   2. <project>/.claude/rules/*.md  (Claude Code interop)
 *   3. <project>/.oxagen/rules/*.md  (oxagen project rules)
 *
 * Frontmatter keys: description, guard-tool, guard-deny-path, guard-deny-command.
 * The body is the rule text. Reuses the agent loader's frontmatter parser.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "../agents/loader.js";
import type { Rule, RuleGuard } from "./types.js";

export interface LoadRulesOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user rules dir (testing). */
  userRulesDir?: string;
}

function guardFrom(data: Record<string, string>): RuleGuard | undefined {
  const tool = data["guard-tool"];
  const denyPathGlob = data["guard-deny-path"];
  const denyCommandGlob = data["guard-deny-command"];
  if (!tool && !denyPathGlob && !denyCommandGlob) return undefined;
  const guard: RuleGuard = {};
  if (tool) guard.tool = tool;
  if (denyPathGlob) guard.denyPathGlob = denyPathGlob;
  if (denyCommandGlob) guard.denyCommandGlob = denyCommandGlob;
  return guard;
}

function ruleFromFile(path: string): Rule | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const id = data["name"] || basename(path).replace(/\.md$/, "");
  if (!id || !body.trim()) return null; // a rule needs a name and a statement
  return {
    id,
    description: data["description"] ?? "",
    text: body.trim(),
    guard: guardFrom(data),
    source: path,
  };
}

function loadDir(dir: string, into: Map<string, Rule>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files.sort()) {
    const rule = ruleFromFile(join(dir, file));
    if (rule) into.set(rule.id, rule);
  }
}

/** Load every workspace rule visible from `cwd`, merged by name across sources. */
export function loadRules(opts: LoadRulesOptions = {}): Rule[] {
  const cwd = opts.cwd ?? process.cwd();
  const userDir = opts.userRulesDir ?? join(homedir(), ".config", "oxagen", "rules");
  const registry = new Map<string, Rule>();
  loadDir(userDir, registry);
  loadDir(join(cwd, ".claude", "rules"), registry);
  loadDir(join(cwd, ".oxagen", "rules"), registry);
  return [...registry.values()];
}
