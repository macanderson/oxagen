// tools-structured/build-package-run.ts
//
// build.package.run (model-facing build_package_run) — run a typecheck (default)
// or build and return deterministically parsed, deduped, file-grouped compiler
// errors instead of raw tsc output. ADR-021 §3: raw compiler scrollback never
// reaches the model — parseTscErrors truncates/dedupes/groups first. ADR-021 §1:
// parsing is a pure function; ZERO model calls. Default mode is `typecheck`
// because it is much faster feedback than a full build for the common "did my
// edit compile?" question.
//
// STATE, not STRUCTURE: this answers "does the code compile right now?" — a
// runtime STATE question. It does NOT answer "what type does this symbol have?"
// or "what depends on this module?" — those are answered by reading the source.

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import {
  scopeSchema,
  verbositySchema,
  limitSchema,
  resolveLimit,
  type Verbosity,
} from "../tools-shared";
import { parseTscErrors, shQuote, MAX_BUILD_ERRORS } from "./parse";

const DEFAULT_TIMEOUT_MS = 300_000;

/** Per-verbosity ceiling on reported compiler errors (minimal = the default cap). */
export const BUILD_ERROR_CAPS = {
  minimal: MAX_BUILD_ERRORS,
  standard: 60,
  verbose: 120,
} as const;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/**
 * Command for a typecheck/build, resolved from the scope + mode. `--pretty false`
 * on tsc keeps the stable `file(line,col): error TSxxxx: message` format the
 * parser expects (pretty mode reflows with colour + carets). A `package` scope
 * targets that package's tsconfig; `files` typechecks those files (typecheck
 * mode only); `all` (or no scope) covers the whole repo / cwd.
 */
export function buildCompileCommand(opts: {
  pkg?: string;
  files?: string[];
  all?: boolean;
  mode: "typecheck" | "build";
}): string {
  if (opts.mode === "build") {
    // tsc can't emit a build for an arbitrary file list; a files-scope build
    // falls back to the package (or the whole build when no package is given).
    return opts.pkg ? `pnpm --filter ${shQuote(opts.pkg)} build` : `pnpm build`;
  }
  // typecheck
  if (opts.files && opts.files.length > 0) {
    return `pnpm exec tsc --noEmit --pretty false ${opts.files.map(shQuote).join(" ")}`;
  }
  return opts.pkg
    ? `pnpm --filter ${shQuote(opts.pkg)} exec tsc --noEmit --pretty false`
    : `pnpm exec tsc --noEmit --pretty false`;
}

export function buildBuildPackageRunTool(
  workspace: Workspace,
  deps: StructuredToolDeps,
): Tool {
  return tool({
    description:
      "Typecheck (default) or build a package and return deduped, file-grouped compiler " +
      "errors as a typed list — not raw tsc/build output. Prefer this over `bash tsc`/" +
      "`bash pnpm build` after an edit: it runs with a stable non-pretty format, collapses " +
      "duplicate diagnostics, and caps the list, so you read the distinct errors and their " +
      "file:line, not a wall of repeated messages. Set `scope.package` to check one package, " +
      "`scope.files` to typecheck exact files, or `scope.all` for the whole repo. Default mode " +
      "`typecheck` is the fast feedback loop; use mode `build` only when you specifically need " +
      "the full build. Anti-triggers: to RUN tests use `test_unit_run`; for arbitrary shell use " +
      "`bash`. This answers the STATE question 'does it compile?' — to ask what a symbol's type " +
      "is or what depends on a module, `grep` for it and read the source.",
    inputSchema: z.object({
      scope: scopeSchema
        .optional()
        .describe(
          "What to compile: {package}, {files} (typecheck only), or {all} for the whole repo. Omit for cwd.",
        ),
      mode: z
        .enum(["typecheck", "build"])
        .optional()
        .describe(
          "'typecheck' (default, fast) or 'build' (full package build).",
        ),
      verbosity: verbositySchema.optional(),
      limit: limitSchema(BUILD_ERROR_CAPS.verbose).describe(
        `Max compiler errors to report (1–${BUILD_ERROR_CAPS.verbose}). Omit to let verbosity choose.`,
      ),
    }),
    execute: async ({ scope, mode, verbosity, limit }) => {
      const resolvedMode = mode ?? "typecheck";
      const maxErrors = resolveLimit(
        (verbosity ?? "minimal") as Verbosity,
        BUILD_ERROR_CAPS,
        limit,
      );
      const command = buildCompileCommand({
        pkg: scope?.package,
        files: scope?.files,
        all: scope?.all,
        mode: resolvedMode,
      });
      const start = Date.now();
      let result;
      try {
        result = await workspace.exec(command, {
          timeoutMs: DEFAULT_TIMEOUT_MS,
          signal: deps.signal,
        });
      } catch (err) {
        return {
          status: "error" as const,
          error: `Failed to run ${resolvedMode}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      deps.onEvent?.({ type: "command", command, exitCode: result.exitCode });
      const durationMs = Date.now() - start;

      if (result.timedOut) {
        return { status: "timeout" as const, mode: resolvedMode, durationMs };
      }

      // tsc writes errors to stdout; build tools vary — parse both streams.
      const combined = `${result.stdout}\n${result.stderr}`;
      const parsed = parseTscErrors(combined, maxErrors);
      const ok = result.exitCode === 0 && parsed.errorCount === 0;
      if (ok) {
        // Success: never echo the raw output — a compact status is all the model needs.
        return {
          status: "ok" as const,
          mode: resolvedMode,
          errorCount: 0,
          errors: [],
          durationMs,
        };
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
