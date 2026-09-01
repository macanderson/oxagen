// tools-structured/workspace-health-check.ts
//
// workspace.health.check (model-facing workspace_health_check) — one compact
// snapshot of repo state: git branch / dirty / ahead-behind (always cheap), plus
// opt-in typecheck and lint summaries. ADR-021 §3: composes the porcelain + tsc +
// eslint parsers so the model gets a single typed object instead of three raw
// command dumps. ADR-021 §1: every check is a pure parser over a command's
// output — ZERO model calls.
//
// STATE, not STRUCTURE: "where am I and is the tree clean/green?" is runtime
// STATE. This tool never describes how the code is organised or connected —
// symbol locations and dependencies are found by reading and searching.

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import {
  scopeSchema,
  verbositySchema,
  resolveLimit,
  type Verbosity,
} from "../tools-shared";
import { parsePorcelainV2, parseTscErrors, clipStr, shQuote } from "./parse";

const GIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 300_000;
/** How many sample items to surface per non-git check (per verbosity — kept small; this is a glance). */
export const HEALTH_SAMPLE_CAPS = {
  minimal: 5,
  standard: 15,
  verbose: 40,
} as const;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/** One eslint result file, as it appears in `eslint --format json`. */
interface EslintFileResult {
  filePath?: string;
  errorCount?: number;
  warningCount?: number;
  messages?: Array<{
    line?: number;
    ruleId?: string | null;
    message?: string;
    severity?: number;
  }>;
}

/**
 * Parse `eslint --format json` into pass/fail + a bounded first-N sample.
 * `sampleLimit` (default {@link HEALTH_SAMPLE_CAPS.minimal}) caps the sample so a
 * noisy lint doesn't flood the glance.
 */
export function parseEslintJson(
  raw: string,
  sampleLimit: number = HEALTH_SAMPLE_CAPS.minimal,
): {
  status: "pass" | "fail";
  errorCount: number;
  warningCount: number;
  sample: string[];
} {
  let files: EslintFileResult[];
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    files = Array.isArray(parsed) ? (parsed as EslintFileResult[]) : [];
  } catch {
    return {
      status: "fail",
      errorCount: 0,
      warningCount: 0,
      sample: ["(eslint output unparseable)"],
    };
  }
  let errorCount = 0;
  let warningCount = 0;
  const sample: string[] = [];
  for (const f of files) {
    errorCount += f.errorCount ?? 0;
    warningCount += f.warningCount ?? 0;
    for (const m of f.messages ?? []) {
      if (sample.length < sampleLimit) {
        const rel = f.filePath ?? "";
        sample.push(
          clipStr(
            `${rel}:${m.line ?? "?"} ${m.ruleId ?? ""} ${m.message ?? ""}`.trim(),
            200,
          ),
        );
      }
    }
  }
  // Gate is --max-warnings 0, so any error OR warning is a failure.
  return {
    status: errorCount + warningCount === 0 ? "pass" : "fail",
    errorCount,
    warningCount,
    sample,
  };
}

export function buildWorkspaceHealthCheckTool(
  workspace: Workspace,
  deps: StructuredToolDeps,
): Tool {
  return tool({
    description:
      "One compact snapshot of repo health: git branch, dirty-file count, and ahead/behind vs " +
      "upstream (always cheap), with OPT-IN typecheck and lint summaries. Prefer this over a " +
      "sequence of `bash git status` / `bash tsc` / `bash eslint` when you want a quick 'where " +
      "am I and is the tree clean?' at the start or end of a task. Set `scope.package` to scope " +
      "the typecheck/lint to one package. Anti-triggers: keep the default (git-only) unless you " +
      "specifically need typecheck/lint — those cost real time; for full compiler errors use " +
      "`build_package_run`; to run tests use `test_unit_run`; for how the code is structured " +
      "(modules, symbols, dependencies) use `search` — this reports STATE, not structure.",
    inputSchema: z.object({
      checks: z
        .array(z.enum(["git", "typecheck", "lint"]))
        .optional()
        .describe(
          "Which checks to run (default ['git']). typecheck/lint are opt-in because they cost time.",
        ),
      scope: scopeSchema
        .optional()
        .describe(
          "Scope typecheck/lint to a {package}; omit to check the whole cwd. (git is always repo-wide.)",
        ),
      verbosity: verbositySchema.optional(),
    }),
    execute: async ({ checks, scope, verbosity }) => {
      const requested = new Set(checks && checks.length > 0 ? checks : ["git"]);
      const sampleLimit = resolveLimit(
        (verbosity ?? "minimal") as Verbosity,
        HEALTH_SAMPLE_CAPS,
      );
      const pkg = scope?.package;
      const filter = pkg ? `--filter ${shQuote(pkg)} ` : "";
      const out: Record<string, unknown> = {};

      if (requested.has("git")) {
        try {
          const res = await workspace.exec(
            "git status --porcelain=v2 --branch",
            {
              timeoutMs: GIT_TIMEOUT_MS,
              signal: deps.signal,
            },
          );
          out.git =
            res.exitCode === 0
              ? parsePorcelainV2(res.stdout)
              : { error: "not a git repository" };
        } catch (err) {
          out.git = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (requested.has("typecheck")) {
        try {
          const res = await workspace.exec(
            `pnpm ${filter}exec tsc --noEmit --pretty false`,
            {
              timeoutMs: CHECK_TIMEOUT_MS,
              signal: deps.signal,
            },
          );
          const parsed = parseTscErrors(
            `${res.stdout}\n${res.stderr}`,
            sampleLimit,
          );
          out.typecheck = {
            status:
              res.exitCode === 0 && parsed.errorCount === 0 ? "pass" : "fail",
            errorCount: parsed.errorCount,
            sample: parsed.errors.slice(0, sampleLimit),
          };
        } catch (err) {
          out.typecheck = {
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      if (requested.has("lint")) {
        try {
          const res = await workspace.exec(
            `pnpm ${filter}exec eslint . --format json --max-warnings 0`,
            {
              timeoutMs: CHECK_TIMEOUT_MS,
              signal: deps.signal,
            },
          );
          out.lint = parseEslintJson(res.stdout || res.stderr, sampleLimit);
        } catch (err) {
          out.lint = {
            status: "fail",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return out;
    },
  });
}
