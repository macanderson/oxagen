// tools-structured/git-diff-summarize.ts
//
// git_diff_summarize — a cheap, typed overview of what changed: per-file change
// type, +/- line counts, and the enclosing symbols touched (from git's own hunk
// headers — no AST). ADR-021 §3: this replaces dumping `git diff` into context
// with a bounded summary. ADR-021 §1: symbol extraction reads the enclosing
// declaration git already writes after `@@ … @@`, parsed by a pure function —
// ZERO model calls, no AST dependency.

import { tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import { combineDiff, shQuote } from "./parse";

const DEFAULT_TIMEOUT_MS = 60_000;

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

export function buildGitDiffSummarizeTool(workspace: Workspace, deps: StructuredToolDeps) {
  return tool({
    description:
      "Summarize the current diff as a typed per-file overview: change type, +/- counts, and " +
      "the enclosing functions/classes touched — the cheap orientation before you dig in. " +
      "Prefer this over `bash git diff` to see the SHAPE of a change (which files, how big, " +
      "what symbols) without spending tokens on the actual patch text. Anti-trigger: do NOT " +
      "use it to read the actual code changes — use `read_file` for the real lines; this is " +
      "the overview, not the content.",
    inputSchema: z.object({
      ref: z
        .string()
        .optional()
        .describe("Diff base (default: HEAD — i.e. all working-tree changes vs the last commit). Pass a branch/sha to compare against it."),
      scope: z
        .string()
        .optional()
        .describe("Restrict to a path/subtree (e.g. 'packages/agent-engine')."),
    }),
    execute: async ({ ref, scope }) => {
      const base = ref ?? "HEAD";
      const { numstat, u0 } = buildDiffCommands({ base, scope });
      let numstatRes;
      let u0Res;
      try {
        [numstatRes, u0Res] = await Promise.all([
          workspace.exec(numstat, { timeoutMs: DEFAULT_TIMEOUT_MS, signal: deps.signal }),
          workspace.exec(u0, { timeoutMs: DEFAULT_TIMEOUT_MS, signal: deps.signal }),
        ]);
      } catch (err) {
        return { error: `Failed to run git diff: ${err instanceof Error ? err.message : String(err)}` };
      }
      deps.onEvent?.({ type: "command", command: numstat, exitCode: numstatRes.exitCode });

      if (numstatRes.exitCode !== 0) {
        const msg = (numstatRes.stderr || numstatRes.stdout).trim().slice(0, 500);
        return { error: `git diff failed: ${msg || "(no output)"}` };
      }

      const summary = combineDiff(numstatRes.stdout, u0Res.stdout);
      if (summary.files.length === 0) {
        return { files: [], totals: summary.totals, truncated: false, note: `No changes vs ${base}.` };
      }
      return summary;
    },
  });
}
