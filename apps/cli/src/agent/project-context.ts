/**
 * Project rules / instructions loading.
 *
 * Parity with Claude Code's `CLAUDE.md`: on session start we collect the
 * project's standing instructions from well-known files, walking up from the
 * working directory so nested rules and repo-root rules both apply. The result
 * is injected once into the (stable) system prompt — it does not change per
 * turn, which keeps the provider prompt cache warm.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath, relative } from "node:path";

/** Files we treat as project instructions, in priority order within a directory. */
const RULE_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".oxagen/rules.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

const MAX_TOTAL = 16_000; // chars; keep rules from dominating the context window
const MAX_DEPTH = 8; // directories to walk up

export interface ProjectContext {
  /** Concatenated rule text, ready to drop into the system prompt. */
  text: string;
  /** Source files that contributed, relative to cwd. */
  sources: string[];
}

/**
 * Collect project rules by walking up from `cwd`. Nearest directory wins on
 * ordering (its rules appear first), repo-root rules appear last. Total size is
 * capped; once the cap is hit, remaining files are skipped.
 */
export function loadProjectContext(cwd: string): ProjectContext {
  const chunks: string[] = [];
  const sources: string[] = [];
  let total = 0;

  let dir = cwd;
  const { root } = parsePath(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const rel of RULE_FILES) {
      const full = join(dir, rel);
      if (!existsSync(full)) continue;
      let text: string;
      try {
        text = readFileSync(full, "utf8").trim();
      } catch {
        continue;
      }
      if (!text) continue;
      const remaining = MAX_TOTAL - total;
      if (remaining <= 0) break;
      const clipped =
        text.length > remaining
          ? text.slice(0, remaining) + "\n… [rules truncated]"
          : text;
      const source = relative(cwd, full) || rel;
      chunks.push(`### ${source}\n${clipped}`);
      sources.push(source);
      total += clipped.length;
    }
    if (total >= MAX_TOTAL) break;
    if (dir === root) break;
    dir = dirname(dir);
  }

  return { text: chunks.join("\n\n"), sources };
}
