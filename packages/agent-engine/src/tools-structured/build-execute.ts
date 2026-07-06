// tools-structured/build-execute.ts
//
// build_execute — run a typecheck (default) or build and return deterministically
// parsed, deduped, file-grouped compiler errors instead of raw tsc output.
// ADR-021 §3: raw compiler scrollback never reaches the model — parseTscErrors
// truncates/dedupes/groups first. ADR-021 §1: parsing is a pure function; ZERO
// model calls. Default mode is `typecheck` because it is much faster feedback
// than a full build for the common "did my edit compile?" question.

import { tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import { parseTscErrors, shQuote } from "./parse";

const DEFAULT_TIMEOUT_MS = 300_000;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/**
 * Command for a typecheck/build. `--pretty false` on tsc keeps the stable
 * `file(line,col): error TSxxxx: message` format the parser expects (pretty mode
 * reflows with colour + carets). A package target scopes to that package's
 * tsconfig; no target typechecks the current cwd's tsconfig.
 */
export function buildCompileCommand(opts: { target?: string; mode: "typecheck" | "build" }): string {
  if (opts.mode === "build") {
    return opts.target
      ? `pnpm --filter ${shQuote(opts.target)} build`
      : `pnpm build`;
  }
  // typecheck
  return opts.target
    ? `pnpm --filter ${shQuote(opts.target)} exec tsc --noEmit --pretty false`
    : `pnpm exec tsc --noEmit --pretty false`;
}

export function buildBuildExecuteTool(workspace: Workspace, deps: StructuredToolDeps) {
  return tool({
    description:
      "Typecheck (default) or build a package and return deduped, file-grouped compiler " +
      "errors as a typed list — not raw tsc/build output. Prefer this over `bash tsc`/" +
      "`bash pnpm build` after an edit: it runs with a stable non-pretty format, collapses " +
      "duplicate diagnostics, and caps the list, so you read the distinct errors and their " +
      "file:line, not a wall of repeated messages. Default mode `typecheck` is the fast " +
      "feedback loop; use mode `build` only when you specifically need the full build. " +
      "Anti-triggers: to RUN tests use `test_run_unit`; for arbitrary shell use `bash`.",
    inputSchema: z.object({
      target: z
        .string()
        .optional()
        .describe("Workspace package name to scope to (e.g. '@oxagen/agent-engine'). Omit for cwd."),
      mode: z
        .enum(["typecheck", "build"])
        .optional()
        .describe("'typecheck' (default, fast) or 'build' (full package build)."),
    }),
    execute: async ({ target, mode }) => {
      const resolvedMode = mode ?? "typecheck";
      const command = buildCompileCommand({ target, mode: resolvedMode });
      const start = Date.now();
      let result;
      try {
        result = await workspace.exec(command, { timeoutMs: DEFAULT_TIMEOUT_MS, signal: deps.signal });
      } catch (err) {
        return { status: "error" as const, error: `Failed to run ${resolvedMode}: ${err instanceof Error ? err.message : String(err)}` };
      }
      deps.onEvent?.({ type: "command", command, exitCode: result.exitCode });
      const durationMs = Date.now() - start;

      if (result.timedOut) {
        return { status: "timeout" as const, mode: resolvedMode, durationMs };
      }

      // tsc writes errors to stdout; build tools vary — parse both streams.
      const combined = `${result.stdout}\n${result.stderr}`;
      const parsed = parseTscErrors(combined);
      const ok = result.exitCode === 0 && parsed.errorCount === 0;
      if (ok) {
        // Success: never echo the raw output — a compact status is all the model needs.
        return { status: "ok" as const, mode: resolvedMode, errorCount: 0, errors: [], durationMs };
      }
      return {
        status: "fail" as const,
        mode: resolvedMode,
        errorCount: parsed.errorCount,
        errors: parsed.errors,
        truncated: parsed.truncated,
        durationMs,
      };
    },
  });
}
