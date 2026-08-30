/**
 * loader.ts — Discover and parse saved prompts.
 *
 * Sources, lowest → highest precedence (later overrides by name):
 *   1. ~/.config/oxagen/prompts/*.md   (user)
 *   2. <project>/.claude/prompts/*.md  (Claude Code interop)
 *   3. <project>/.oxagen/prompts/*.md  (oxagen project prompts)
 *
 * Reuses the shared markdown-registry frontmatter parser — the same idiom
 * `loadCommands`/`loadAgents` use. Frontmatter keys: description,
 * `argument-hint`. The body is the prompt text.
 */
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  loadMarkdownRegistry,
  readMarkdownFile,
} from "../lib/markdown-registry.js";
import type { SavedPrompt } from "./types.js";

export interface LoadPromptsOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user prompts dir (testing). */
  userPromptsDir?: string;
}

function promptFromFile(
  path: string,
): { key: string; value: SavedPrompt } | null {
  const fm = readMarkdownFile(path);
  if (!fm) return null;
  const { data, body } = fm;
  const name = data["name"] || basename(path).replace(/\.md$/, "");
  if (!name || !body.trim()) return null; // a prompt needs a name and body text
  return {
    key: name,
    value: {
      name,
      description: data["description"] ?? "",
      body,
      argumentHint: data["argument-hint"] || undefined,
      source: path,
    },
  };
}

/** Load every saved prompt visible from `cwd`, merged by name across sources. */
export function loadPrompts(
  opts: LoadPromptsOptions = {},
): Map<string, SavedPrompt> {
  const cwd = opts.cwd ?? process.cwd();
  const userDir =
    opts.userPromptsDir ?? join(homedir(), ".config", "oxagen", "prompts");
  return loadMarkdownRegistry(
    [userDir, join(cwd, ".claude", "prompts"), join(cwd, ".oxagen", "prompts")],
    promptFromFile,
  );
}

/** Resolve one saved prompt by name (or null). Convenience over {@link loadPrompts}. */
export function getPrompt(
  name: string,
  opts: LoadPromptsOptions = {},
): SavedPrompt | null {
  return loadPrompts(opts).get(name) ?? null;
}
