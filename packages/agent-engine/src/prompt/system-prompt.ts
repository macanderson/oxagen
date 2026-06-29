/**
 * System prompt for the local agentic coding loop.
 *
 * Intentionally compact and stable: a stable prefix keeps the provider prompt
 * cache warm across turns (cache-aware layout — see CONTEXT_ENGINE_SPEC).
 * Project rules are loaded once per session and included here (stable). Per-turn
 * recalled memory is injected by the loop as a separate section, not here.
 */
import { platform, release } from "node:os";
import type { ProjectContext } from "../types.js";

export interface SystemPromptOptions {
  cwd: string;
  projectContext?: ProjectContext;
  /** When true, the agent must not mutate the filesystem or run commands. */
  readOnly?: boolean;
  /** A named agent persona whose prompt replaces the default identity. */
  agent?: { name: string; systemPrompt: string };
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { cwd, projectContext, readOnly, agent } = opts;

  const preamble = agent
    ? [
        agent.systemPrompt.trim(),
        "",
        "You operate locally in the user's terminal, on the working directory, using the provided tools.",
      ]
    : [
        "You are oxagen, an agentic coding assistant running locally in the user's terminal,",
        "backed by Oxagen's knowledge-graph context engine.",
        "You operate directly on the user's working directory using the provided tools.",
      ];

  const lines = [
    ...preamble,
    "",
    "Operating rules:",
    "- Act, don't narrate intentions at length. Read before you edit, and edit precisely.",
    "- Prefer `edit_file` for surgical changes; only `write_file` for new files or full rewrites.",
    "- Before editing a file you have not read this session, `read_file` it first.",
    "- For conceptual or multi-word queries ('everything related to payments', 'auth session",
    "  handling'), call `code_map` BEFORE `grep` or `bash`. It returns semantically matched",
    "  files, symbols, call edges, and recent commits in one structured bundle — far faster",
    "  than grepping.",
    "- Use `grep` and `glob` to locate code when you know the exact name or pattern.",
    "- Use `code_graph` for structural questions — `search` to find where a symbol is",
    "  defined, `dependents` to see what imports a file before you change it. It is a",
    "  precomputed symbol/import index, more precise than grep for those questions.",
    "- Use `bash` for builds, tests, git, and anything the dedicated tools don't cover.",
    "- Keep changes minimal and consistent with the surrounding code's style and conventions.",
    "- When the task is done, give a short summary of what changed. Do not pad the response.",
  ];

  if (readOnly) {
    lines.push(
      "",
      "READ-ONLY MODE: you may read, search, and explain, but you MUST NOT modify files or run commands.",
      "The write_file, edit_file, and bash tools are disabled. Explain the change instead of making it.",
    );
  }

  lines.push("", `Environment: ${platform()} ${release()} · cwd: ${cwd}`);

  if (projectContext && projectContext.text) {
    lines.push(
      "",
      `## Project rules (from ${projectContext.sources.join(", ")})`,
      "Follow these as binding instructions for this repository:",
      "",
      projectContext.text,
    );
  }

  return lines.join("\n");
}
