/**
 * loader.ts — Discover and parse user-defined slash commands.
 *
 * Sources, lowest → highest precedence (later overrides by name):
 *   1. ~/.config/oxagen/commands/*.md   (user)
 *   2. <project>/.claude/commands/*.md  (Claude Code interop)
 *   3. <project>/.oxagen/commands/*.md  (oxagen project commands)
 *
 * Reuses the shared markdown-registry frontmatter parser. Frontmatter keys:
 * description, `argument-hint`, model. The body is the prompt template.
 */
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  loadMarkdownRegistry,
  readMarkdownFile,
} from "../lib/markdown-registry.js";
import { oxagenProjectDir } from "../lib/oxagen-project-paths.js";
import type { SlashCommand } from "./types.js";

export interface LoadCommandsOptions {
  /** Project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user commands dir (testing). */
  userCommandsDir?: string;
}

function defFromFile(
  path: string,
): { key: string; value: SlashCommand } | null {
  const fm = readMarkdownFile(path);
  if (!fm) return null;
  const { data, body } = fm;
  const name = data["name"] || basename(path).replace(/\.md$/, "");
  if (!name || !body.trim()) return null; // a command needs a name and a template
  return {
    key: name,
    value: {
      name,
      description: data["description"] ?? "",
      template: body,
      argumentHint: data["argument-hint"] || undefined,
      model: data["model"] || undefined,
      source: path,
    },
  };
}

/** Load every slash command visible from `cwd`, merged by name across sources. */
export function loadCommands(
  opts: LoadCommandsOptions = {},
): Map<string, SlashCommand> {
  const cwd = opts.cwd ?? process.cwd();
  const userDir =
    opts.userCommandsDir ?? join(homedir(), ".config", "oxagen", "commands");
  return loadMarkdownRegistry(
    [
      userDir,
      join(cwd, ".claude", "commands"),
      oxagenProjectDir("commands", cwd),
    ],
    defFromFile,
  );
}
