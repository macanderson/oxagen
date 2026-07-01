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
    "- Use `grep` and `glob` to locate code instead of guessing paths.",
    "- Use `code_graph` for structural questions — `search` to find where a symbol is",
    "  defined, `dependents` to see what imports a file before you change it. It is a",
    "  precomputed symbol/import index, more precise than grep for those questions.",
    "- Use `bash` for builds, tests, git, and anything the dedicated tools don't cover.",
    "- Keep changes minimal and consistent with the surrounding code's style and conventions.",
    "- Reporting: the user sees your prose plus a one-line chip for each tool call — never",
    "  the tool's actual output. The answer must therefore live in YOUR reply. After any",
    "  command or read that gathers information (git or `gh`, CI / PR / check status, test",
    "  or build output, logs, a file's contents), read what came back and state the concrete",
    "  finding. Never end a turn on a bare tool call assuming the user can see the result —",
    "  they cannot.",
    "- A status or diagnostic question ('did the PR pass?', 'what's the CI status?', 'is it",
    "  green?') is not done when the command runs — it is done when you have READ the output",
    "  and reported the real state: pass/fail, which checks ran, and the failing step or error",
    "  if any. Keep gathering (the run URL, the failing job's log) until you can answer with",
    "  specifics, not just that you looked.",
    "- Always close a turn with a substantive reply — a short summary of what you changed, or",
    "  the concrete answer you gathered. Do not pad, but never finish silent or with only a",
    "  tool chip and no words.",
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
