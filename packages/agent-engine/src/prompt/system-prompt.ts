/**
 * System prompt for the local agentic coding loop.
 *
 * Intentionally compact and stable: a stable prefix keeps the provider prompt
 * cache warm across turns (cache-aware layout — see CONTEXT_ENGINE_SPEC).
 * Project rules are loaded once per session and included here (stable). Per-turn
 * recalled memory is injected by the loop as a separate section, not here.
 */
import { platform, release } from "node:os";
import type { ProjectContext } from "../types";

export interface SystemPromptOptions {
  cwd: string;
  projectContext?: ProjectContext;
  /** When true, the agent must not mutate the filesystem or run commands. */
  readOnly?: boolean;
  /** A named agent persona whose prompt replaces the default identity. */
  agent?: { name: string; systemPrompt: string };
  /**
   * Whether the `code_graph` tool is wired for this run (a CodeGraphProvider
   * was supplied). Defaults to true — it is the common case; pass false when
   * running without a provider so the prompt never references a missing tool.
   */
  hasCodeGraph?: boolean;
  /**
   * Whether the `code_map` tool is wired for this run (a CodeMapProvider was
   * supplied). Defaults to false — the tool is optional and rarely wired, and
   * a prompt rule pointing at a tool the model does not have silently breaks
   * the whole context-gathering habit.
   */
  hasCodeMap?: boolean;
  profile?: "interactive" | "headless";

}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const { cwd, projectContext, readOnly, agent } = opts;
  const hasCodeGraph = opts.hasCodeGraph ?? true;
  const hasCodeMap = opts.hasCodeMap ?? false;
  const profile = opts.profile ?? "interactive";
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

  // Profile-independent tool rules — BOTH profiles get these verbatim.
  const lines = [
    ...preamble,
    "",
    "Operating rules:",
    "- Act, don't narrate intentions at length. Read before you edit, and edit precisely.",
    "- Prefer `edit_file` for surgical changes; only `write_file` for new files or full rewrites.",
    "- Before editing a file you have not read this session, `read_file` it first.",
    ...(hasCodeGraph
      ? [
          "- GRAPH FIRST: `code_graph` is your FIRST choice for gathering context about code —",
          "  it is a precomputed symbol/import index, more precise and cheaper than grepping.",
          "  Use `search` for symbol lookups, `file_symbols` to understand a file before",
          "  editing it, `dependents` before changing any shared file (what a change could",
          "  break), and `imports` to trace dependencies.",
        ]
      : []),
    ...(hasCodeMap
      ? [
          "- For conceptual or multi-word queries ('everything related to payments', 'auth session",
          "  handling'), call `code_map` BEFORE `grep` or `bash`. It returns semantically matched",
          "  files, symbols, call edges, and recent commits in one structured bundle — far faster",
          "  than grepping.",
        ]
      : []),
    ...(hasCodeGraph
      ? [
          "- Only fall back to `grep`/`glob` when the graph returns no results or the target",
          "  is plain text (strings, comments, config keys) rather than a code symbol.",
        ]
      : ["- Use `grep` and `glob` to locate code instead of guessing paths."]),
    "- Use `bash` for builds, tests, git, and anything the dedicated tools don't cover.",
    "- Keep changes minimal and consistent with the surrounding code's style and conventions.",
  ];

  if (profile === "headless") {
    // No live watcher: drop the narration tax, mandate a verification loop.
    lines.push(
      "",
      "Verification protocol (headless — no live watcher, so do not narrate for an audience;",
      "let the tools carry the work and speak only in the final answer):",
      "- Reproduce the failure FIRST: run the failing test, or write a minimal repro, and",
      "  confirm it actually fails before you change anything.",
      "- Localize before editing: use `code_map`/`code_graph`/`grep` to find the real source",
      "  of the failure, and `read_file` a file before you edit it.",
      "- Make the SMALLEST root-cause fix that matches the surrounding style — no drive-by",
      "  rewrites, no unrelated cleanups.",
      "- Re-run the reproduction and the specific failing test(s); confirm they now pass.",
      "- Run the broader relevant test module to catch regressions, and fix any regression",
      "  you introduced.",
      "- Do NOT modify, delete, or weaken tests to make them pass — fix the code under test.",
      "- The deliverable is the code change. End only when the tests pass, stating in one or",
      "  two lines what you changed and the test result.",
    );
  } else {
    // Interactive: a human watches the stream live — report and narrate.
    lines.push(
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
      "- When fixing a bug, reproduce it first (run the failing test or a quick repro), make the",
      "  smallest root-cause fix, then re-run to confirm it passes and nothing nearby regressed.",
      "- NARRATE AS YOU GO — never work silently. Before a slow or multi-step action (a build,",
      "  a test run, a broad search, dispatching a subagent), say in one short line what you are",
      "  about to do and why; after it returns, say what you found. The user watches this stream",
      "  live, and a long tool call with no words looks like a hang. A steady trickle of brief,",
      "  concrete progress lines ('running the billing unit tests…', 'tests green, now wiring the",
      "  route') is required — the goal is that the user is NEVER left staring at a spinner for",
      "  30+ seconds with no idea what is happening. Think out loud; keep each line short.",
    );
  }

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
