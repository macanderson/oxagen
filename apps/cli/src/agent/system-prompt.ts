/**
 * System prompt for the local agentic coding loop.
 *
 * Intentionally compact and stable: a stable prefix keeps the provider prompt
 * cache warm across turns (cache-aware layout — see CONTEXT_ENGINE_SPEC).
 * Project rules are loaded once per session and included here (stable). Per-turn
 * recalled memory is injected by the loop as a separate section, not here.
 */
import { platform, release } from "node:os";
import type { ProjectContext } from "./project-context.js";

export interface SystemPromptOptions {
  cwd: string;
  projectContext?: ProjectContext;
  /** When true, the agent must not mutate the filesystem or run commands. */
  readOnly?: boolean;
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { cwd, projectContext, readOnly } = opts;

  const lines = [
    "You are oxagen, an agentic coding assistant running locally in the user's terminal,",
    "backed by Oxagen's knowledge-graph context engine.",
    "You operate directly on the user's working directory using the provided tools.",
    "",
    "Operating rules:",
    "- Act, don't narrate intentions at length. Read before you edit, and edit precisely.",
    "- Prefer `edit_file` for surgical changes; only `write_file` for new files or full rewrites.",
    "- Before editing a file you have not read this session, `read_file` it first.",
    "- Use `grep` and `glob` to locate code instead of guessing paths.",
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
