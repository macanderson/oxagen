/**
 * Project rules / instructions loading.
 *
 * Parity with Claude Code's `CLAUDE.md`: on session start we collect the
 * project's standing instructions from well-known files, walking up from the
 * working directory so nested rules and repo-root rules both apply. The result
 * is injected once into the (stable) system prompt — it does not change per
 * turn, which keeps the provider prompt cache warm.
 *
 * Also feeds in the resolved Oxagen Workspace Config (design.md §9,
 * `../config/`): `vision` becomes an anchor block, `enforced` language items
 * become a hard-rules section, and `commands` become concrete script
 * references — appended after the prose rules above, into the same `text`
 * blob (packages/agent-engine's system-prompt builder embeds all of `text`
 * verbatim under one "binding instructions" header, so no consumer changes
 * are needed). Resolution is best-effort: a malformed workspace.json must
 * never block session start.
 *
 * NOT wired here (seam, not yet integrated): `vcs` (branch/commit/PR
 * conventions + attribution) and `worktrees.seed` are lower-value as *prose*
 * — they're structured data consumed by specific call sites (VCS commit/PR
 * helpers, the fleet/worktree composer), not by the model reading a system
 * prompt — and `consolidated` (skills/agents/MCP/commands index) is large
 * and better suited to an on-demand tool call than a standing system-prompt
 * section. Call `resolveWorkspaceConfig(cwd)` (../config/resolve.js) directly
 * at those call sites when they're built, rather than growing this blob.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath, relative } from "node:path";
import {
  resolveWorkspaceConfig,
  type ResolveWorkspaceConfigOptions,
} from "../config/resolve.js";
import type {
  WorkspaceConfig,
  CommandEntry,
  CommandsConfig,
} from "../config/schema.js";

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

function renderCommandLine(label: string, entry: CommandEntry): string {
  const description = entry.description ? ` — ${entry.description}` : "";
  const background = entry.background ? " (background)" : "";
  return `- ${label}: \`${entry.run}\`${description}${background}`;
}

/**
 * Flatten every named command group + `custom` into one ordered list of
 * display lines. Named fields are referenced explicitly rather than via
 * `keyof CommandsConfig` dynamic indexing — `commandsSchema`'s `.passthrough()`
 * widens its inferred type with a string index signature, which makes
 * `keyof`-driven indexing resolve to an un-narrowable, non-iterable type.
 */
function renderCommandLines(commands: CommandsConfig | undefined): string[] {
  if (!commands) return [];
  const lines: string[] = [];
  const add = (label: string, entries: CommandEntry[] | undefined) => {
    for (const entry of entries ?? [])
      lines.push(renderCommandLine(label, entry));
  };
  add("dev", commands.dev);
  add("build", commands.build);
  add("test", commands.test);
  add("lint", commands.lint);
  add("typecheck", commands.typecheck);
  add("migrate", commands.migrate);
  add("release", commands.release);
  add("gate", commands.gate);
  for (const [name, entries] of Object.entries(commands.custom ?? {}))
    add(name, entries);
  return lines;
}

/**
 * Render `vision` / `enforced` language items / `commands` from a resolved
 * WorkspaceConfig as markdown sections (design.md §9). Returns "" when none
 * of those sections are populated.
 */
function renderWorkspaceConfigSections(config: WorkspaceConfig): {
  text: string;
  sources: string[];
} {
  const sections: string[] = [];
  const sources: string[] = [];

  const vision = config.vision;
  if (
    vision?.statement ||
    vision?.goals?.length ||
    vision?.nonGoals?.length ||
    vision?.principles?.length
  ) {
    const lines = ["### Vision", ""];
    if (vision.statement) lines.push(vision.statement, "");
    if (vision.principles?.length)
      lines.push("Principles:", ...vision.principles.map((p) => `- ${p}`), "");
    if (vision.goals?.length)
      lines.push("Goals:", ...vision.goals.map((g) => `- ${g}`), "");
    if (vision.nonGoals?.length)
      lines.push(
        "Non-goals — do not pursue these:",
        ...vision.nonGoals.map((g) => `- ${g}`),
        "",
      );
    sections.push(lines.join("\n").trimEnd());
    sources.push("workspace config: vision");
  }

  const enforced: string[] = [];
  for (const [lang, entry] of Object.entries(config.languages ?? {})) {
    for (const item of entry.items ?? []) {
      if (!item.enforced) continue;
      const detail = item.text ?? (item.doc ? `see ${item.doc}` : item.id);
      enforced.push(`- [${lang}] ${detail}`);
    }
  }
  if (enforced.length > 0) {
    sections.push(
      ["### Hard rules (enforced) — do not violate", "", ...enforced].join(
        "\n",
      ),
    );
    sources.push("workspace config: enforced rules");
  }

  const commandLines = renderCommandLines(config.commands);
  if (commandLines.length > 0) {
    sections.push(
      [
        "### Commands — run these exact scripts instead of guessing",
        "",
        ...commandLines,
      ].join("\n"),
    );
    sources.push("workspace config: commands");
  }

  return { text: sections.join("\n\n"), sources };
}

/**
 * Collect project rules by walking up from `cwd`. Nearest directory wins on
 * ordering (its rules appear first), repo-root rules appear last. Total size is
 * capped; once the cap is hit, remaining files are skipped.
 *
 * `configOpts` overrides the workspace-config resolver's `managed`/`user` scope
 * paths (testing only — real call sites never pass it, so resolution defaults
 * to `~/.oxagen/managed.json` / `~/.oxagen/user.json` as usual).
 */
export function loadProjectContext(
  cwd: string,
  configOpts: ResolveWorkspaceConfigOptions = {},
): ProjectContext {
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

  // Oxagen Workspace Config (design.md §9) — appended after the prose rules
  // above, sharing the same size budget. Best-effort: resolution failures
  // (malformed workspace.json, etc.) must never block session start.
  try {
    const remaining = MAX_TOTAL - total;
    if (remaining > 0) {
      const { config } = resolveWorkspaceConfig(cwd, configOpts);
      const rendered = renderWorkspaceConfigSections(config);
      if (rendered.text) {
        const clipped =
          rendered.text.length > remaining
            ? rendered.text.slice(0, remaining) + "\n… [truncated]"
            : rendered.text;
        chunks.push(clipped);
        sources.push(...rendered.sources);
        total += clipped.length;
      }
    }
  } catch {
    // best-effort — never let a config error block session start
  }

  return { text: chunks.join("\n\n"), sources };
}
