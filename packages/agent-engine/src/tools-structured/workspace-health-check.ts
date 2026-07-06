// tools-structured/workspace-health-check.ts
//
// workspace_health_check — one compact snapshot of repo state: git branch /
// dirty / ahead-behind (always cheap), plus opt-in typecheck and lint summaries.
// ADR-021 §3: composes the porcelain + tsc + eslint parsers so the model gets a
// single typed object instead of three raw command dumps. ADR-021 §1: every
// check is a pure parser over a command's output — ZERO model calls.

import { tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import { parsePorcelainV2, parseTscErrors, clipStr } from "./parse";

const GIT_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 300_000;
/** How many sample items to surface per non-git check (kept tiny — this is a glance). */
const SAMPLE_LIMIT = 5;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/** Parse `eslint --format json` into pass/fail + a bounded first-N sample. */
export function parseEslintJson(raw: string): {
  status: "pass" | "fail";
  errorCount: number;
  warningCount: number;
  sample: string[];
} {
  let files: Array<{
    filePath?: string;
    errorCount?: number;
    warningCount?: number;
    messages?: Array<{ line?: number; ruleId?: string | null; message?: string; severity?: number }>;
  }>;
  try {
    const parsed = JSON.parse(raw.trim());
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { status: "fail", errorCount: 0, warningCount: 0, sample: ["(eslint output unparseable)"] };
  }
  let errorCount = 0;
  let warningCount = 0;
  const sample: string[] = [];
  for (const f of files) {
    errorCount += f.errorCount ?? 0;
    warningCount += f.warningCount ?? 0;
    for (const m of f.messages ?? []) {
      if (sample.length < SAMPLE_LIMIT) {
        const rel = f.filePath ?? "";
        sample.push(clipStr(`${rel}:${m.line ?? "?"} ${m.ruleId ?? ""} ${m.message ?? ""}`.trim(), 200));
      }
    }
  }
  // Gate is --max-warnings 0, so any error OR warning is a failure.
  return { status: errorCount + warningCount === 0 ? "pass" : "fail", errorCount, warningCount, sample };
}

export function buildWorkspaceHealthCheckTool(workspace: Workspace, deps: StructuredToolDeps) {
  return tool({
    description:
      "One compact snapshot of repo health: git branch, dirty-file count, and ahead/behind vs " +
      "upstream (always cheap), with OPT-IN typecheck and lint summaries. Prefer this over a " +
      "sequence of `bash git status` / `bash tsc` / `bash eslint` when you want a quick 'where " +
      "am I and is the tree clean?' at the start or end of a task. Anti-triggers: keep the " +
      "default (git-only) unless you specifically need typecheck/lint — those cost real time; " +
      "for full compiler errors use `build_execute`; to run tests use `test_run_unit`.",
    inputSchema: z.object({
      checks: z
        .array(z.enum(["git", "typecheck", "lint"]))
        .optional()
        .describe("Which checks to run (default ['git']). typecheck/lint are opt-in because they cost time."),
    }),
    execute: async ({ checks }) => {
      const requested = new Set(checks && checks.length > 0 ? checks : ["git"]);
      const out: Record<string, unknown> = {};

      if (requested.has("git")) {
        try {
          const res = await workspace.exec("git status --porcelain=v2 --branch", {
            timeoutMs: GIT_TIMEOUT_MS,
            signal: deps.signal,
          });
          out.git = res.exitCode === 0 ? parsePorcelainV2(res.stdout) : { error: "not a git repository" };
        } catch (err) {
          out.git = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (requested.has("typecheck")) {
        try {
          const res = await workspace.exec("pnpm exec tsc --noEmit --pretty false", {
            timeoutMs: CHECK_TIMEOUT_MS,
            signal: deps.signal,
          });
          const parsed = parseTscErrors(`${res.stdout}\n${res.stderr}`);
          out.typecheck = {
            status: res.exitCode === 0 && parsed.errorCount === 0 ? "pass" : "fail",
            errorCount: parsed.errorCount,
            sample: parsed.errors.slice(0, SAMPLE_LIMIT),
          };
        } catch (err) {
          out.typecheck = { status: "fail", error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (requested.has("lint")) {
        try {
          const res = await workspace.exec("pnpm exec eslint . --format json --max-warnings 0", {
            timeoutMs: CHECK_TIMEOUT_MS,
            signal: deps.signal,
          });
          out.lint = parseEslintJson(res.stdout || res.stderr);
        } catch (err) {
          out.lint = { status: "fail", error: err instanceof Error ? err.message : String(err) };
        }
      }

      return out;
    },
  });
}
