// tools-structured/git-diff-summarize.ts
//
// git.diff.summarize (model-facing git_diff_summarize) — a cheap, typed overview
// of what changed: per-file change type, +/- line counts, and the enclosing
// symbols touched (from git's own hunk headers — no AST). ADR-021 §3: this
// replaces dumping `git diff` into context with a bounded summary. ADR-021 §1:
// symbol extraction reads the enclosing declaration git already writes after
// `@@ … @@`, parsed by a pure function — ZERO model calls, no AST dependency.
//
// STATE, not STRUCTURE: the diff is the uncommitted STATE of the tree. The
// per-file `symbols` are the enclosing declarations git names in its hunk
// headers — names to grep for when the agent wants the STRUCTURE questions this
// tool never answers (callers of a changed function, its type, its neighbours).
// This tool is deliberately AST-free and does no structural search.

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import {
  verbositySchema,
  limitSchema,
  resolveLimit,
  type Verbosity,
} from "../tools-shared";
import { combineDiff, shQuote, MAX_DIFF_FILES } from "./parse";

const DEFAULT_TIMEOUT_MS = 60_000;

/** Per-verbosity ceiling on the reported file list (minimal = the default cap). */
export const DIFF_FILE_CAPS = {
  minimal: MAX_DIFF_FILES,
  standard: 100,
  verbose: 200,
} as const;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/** The two git diff invocations (numstat + U0), scoped to ref and optional path. */
export function buildDiffCommands(opts: { base: string; scope?: string }): {
  numstat: string;
  u0: string;
} {
  const scope = opts.scope ? ` -- ${shQuote(opts.scope)}` : "";
  const base = opts.base ? ` ${shQuote(opts.base)}` : "";
  return {
    numstat: `git diff --numstat -M${base}${scope}`,
    u0: `git diff -U0 -M${base}${scope}`,
  };
}

export function buildGitDiffSummarizeTool(
  workspace: Workspace,
  deps: StructuredToolDeps,
): Tool {
  return tool({
    description:
      "Summarize the current diff as a typed per-file overview: change type, +/- counts, and " +
      "the enclosing functions/classes touched — the cheap orientation before you dig in. " +
      "Prefer this over `bash git diff` to see the SHAPE of a change (which files, how big, " +
      "what symbols) without spending tokens on the actual patch text. The returned `symbols` " +
      "are declaration names — `grep` for one to find who calls a changed function or what it " +
      "depends on (this tool answers WHAT CHANGED, not how the code is " +
      "connected). Anti-triggers: do NOT use it to read the actual code changes — use " +
      "`read_file` for the real lines; do NOT use it for structural queries — that is `grep`.",
    inputSchema: z.object({
      ref: z
        .string()
        .optional()
        .describe(
          "Diff base (default: HEAD — i.e. all working-tree changes vs the last commit). Pass a branch/sha to compare against it.",
        ),
      path: z
        .string()
        .optional()
        .describe("Restrict to a path/subtree (e.g. 'packages/agent-engine')."),
      verbosity: verbositySchema.optional(),
      limit: limitSchema(DIFF_FILE_CAPS.verbose).describe(
        `Max files to list (1–${DIFF_FILE_CAPS.verbose}); totals always cover every file. Omit to let verbosity choose.`,
      ),
    }),
    execute: async ({ ref, path, verbosity, limit }) => {
      const base = ref ?? "HEAD";
      const maxFiles = resolveLimit(
        (verbosity ?? "minimal") as Verbosity,
        DIFF_FILE_CAPS,
        limit,
      );
      const { numstat, u0 } = buildDiffCommands({ base, scope: path });
      let numstatRes;
      let u0Res;
      try {
        [numstatRes, u0Res] = await Promise.all([
          workspace.exec(numstat, {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            signal: deps.signal,
          }),
          workspace.exec(u0, {
            timeoutMs: DEFAULT_TIMEOUT_MS,
            signal: deps.signal,
          }),
        ]);
      } catch (err) {
        return {
          error: `Failed to run git diff: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      deps.onEvent?.({
        type: "command",
        command: numstat,
        exitCode: numstatRes.exitCode,
      });

      if (numstatRes.exitCode !== 0) {
        const msg = (numstatRes.stderr || numstatRes.stdout)
          .trim()
          .slice(0, 500);
        return { error: `git diff failed: ${msg || "(no output)"}` };
      }

      const summary = combineDiff(numstatRes.stdout, u0Res.stdout, maxFiles);
      if (summary.files.length === 0) {
        return {
          files: [],
          totals: summary.totals,
          truncated: false,
          note: `No changes vs ${base}.`,
        };
      }
      return summary;
    },
  });
}
