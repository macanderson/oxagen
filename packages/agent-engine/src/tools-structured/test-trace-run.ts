// tools-structured/test-trace-run.ts
//
// test.trace.run (model-facing test_trace_run) — run ONE failing test under a
// V8 coverage tracer and return the EXECUTED PATH: which repo files (and which
// functions in them) actually ran, ranked. Phase 2 "debugger in the loop" v1
// (docs/ideas/agentic-cli-roadmap-2026-07-10.md): debugging grounded in runtime
// truth instead of search-and-guess — the model reads the files the failure
// actually traversed, not the files whose names looked relevant.
//
// ADR-021: ZERO model calls. The trace summarization is a deterministic node
// one-liner executed WHERE THE TEST RAN (via workspace.exec), so the multi-MB
// raw V8 coverage JSON never crosses the tool boundary — only a compact,
// bounded, typed ranking does.
//
// STATE, not STRUCTURE: this answers "what code did this failing test actually
// execute?" — a runtime STATE question. "What tests cover symbol X?" is a search;
// "does it pass?" stays with test_unit_run.

import { tool, type Tool } from "ai";
import { z } from "zod";
import type { Workspace, CodingEvent } from "../types";
import { parseVitestJson, shQuote, clipStr, MAX_STDERR_TAIL } from "./parse";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Ceiling on ranked files reported back to the model. */
export const TRACE_FILE_CAPS = {
  minimal: 12,
  standard: 20,
  verbose: 32,
} as const;
/** Top executed function names reported per file. */
const TOP_FUNCTIONS_PER_FILE = 8;
/** Failing assertions carried alongside the trace. */
const TRACE_FAILURE_CAP = 10;

/** One repo file the traced test actually executed. */
export interface ExecutedFile {
  path: string;
  /** Count of functions in this file that ran at least once. */
  executedFunctions: number;
  /** Names of the most-called functions (anonymous ones excluded). */
  topFunctions: string[];
}

/**
 * Build the traced vitest command. The trace rides vitest's NATIVE V8
 * coverage provider (`@vitest/coverage-v8`, a devDependency of every package
 * in this repo) rather than a raw NODE_V8_COVERAGE env: vite transforms the
 * TS sources, so raw V8 script URLs point at transform artifacts, while the
 * provider's istanbul-style `coverage-final.json` is SOURCE-MAPPED back to
 * the original files with per-function hit counts — exactly the executed
 * path the model needs. Config-declared coverage thresholds are zeroed on
 * the CLI so tracing one file never fails a whole-package coverage gate.
 */
export function buildTraceCommand(opts: {
  file: string;
  testName?: string;
  coverageDir: string;
}): string {
  const parts = ["pnpm", "exec", "vitest", "run", shQuote(opts.file)];
  if (opts.testName) parts.push("-t", shQuote(opts.testName));
  parts.push(
    "--reporter=json",
    "--no-color",
    "--coverage.enabled",
    "--coverage.provider=v8",
    "--coverage.reporter=json",
    `--coverage.reportsDirectory=${shQuote(opts.coverageDir)}`,
    "--coverage.thresholds.lines=0",
    "--coverage.thresholds.functions=0",
    "--coverage.thresholds.branches=0",
    "--coverage.thresholds.statements=0",
  );
  return parts.join(" ");
}

/**
 * The deterministic summarizer, executed where the test ran. Reads the
 * provider's `coverage-final.json` (istanbul format: abs path → {fnMap, f}),
 * keeps files under the workspace root (excluding node_modules), counts the
 * functions that actually ran (f[id] > 0; the provider's "(empty-report)"
 * placeholder rows for never-loaded files are skipped), and prints ONE
 * compact JSON line: {"files":[{"p":rel,"n":execFns,"t":[topNames]}],"scanned":N}.
 * The multi-MB report never crosses the tool boundary. Exported for tests.
 */
export function buildTraceSummarizeCommand(opts: {
  coverageDir: string;
  root: string;
  maxFiles: number;
}): string {
  const script = [
    'const fs=require("fs"),path=require("path");',
    "const dir=process.argv[1],root=process.argv[2],max=Number(process.argv[3]);",
    'const doc=JSON.parse(fs.readFileSync(path.join(dir,"coverage-final.json"),"utf8"));',
    "let scanned=0;const rows=[];",
    "for(const[abs,cov]of Object.entries(doc)){",
    "scanned++;",
    'if(!abs.startsWith(root)||abs.includes("node_modules"))continue;',
    "const f=cov.f||{},fnMap=cov.fnMap||{};",
    "const names=[];let n=0;",
    "for(const[id,count]of Object.entries(f)){",
    "if(!(count>0))continue;",
    "const meta=fnMap[id];",
    "const name=meta&&meta.name;",
    'if(name==="(empty-report)")continue;',
    "n++;",
    'if(name&&!name.startsWith("(anonymous"))names.push(name);',
    "}",
    "if(n>0)rows.push({p:path.relative(root,abs),n,t:names.slice(0," +
      String(TOP_FUNCTIONS_PER_FILE) +
      ")});",
    "}",
    "rows.sort((a,b)=>b.n-a.n);",
    "process.stdout.write(JSON.stringify({files:rows.slice(0,max),scanned}));",
  ].join("");
  return [
    "node",
    "-e",
    shQuote(script),
    shQuote(opts.coverageDir),
    shQuote(opts.root),
    String(opts.maxFiles),
  ].join(" ");
}

/** Parse the summarizer's single-line JSON into typed executed files. */
export function parseTraceSummary(
  stdout: string,
): { files: ExecutedFile[]; scanned: number } | null {
  const start = stdout.indexOf('{"files":');
  if (start === -1) return null;
  try {
    const doc = JSON.parse(stdout.slice(start)) as {
      files?: Array<{ p?: unknown; n?: unknown; t?: unknown }>;
      scanned?: unknown;
    };
    const files: ExecutedFile[] = [];
    for (const f of doc.files ?? []) {
      if (typeof f.p !== "string" || typeof f.n !== "number") continue;
      files.push({
        path: f.p,
        executedFunctions: f.n,
        topFunctions: Array.isArray(f.t)
          ? f.t.filter((x): x is string => typeof x === "string")
          : [],
      });
    }
    return {
      files,
      scanned: typeof doc.scanned === "number" ? doc.scanned : 0,
    };
  } catch {
    return null;
  }
}

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

export function buildTestTraceRunTool(
  workspace: Workspace,
  deps: StructuredToolDeps,
): Tool {
  return tool({
    description:
      "Run ONE test file under a V8 execution tracer and return the EXECUTED PATH — which " +
      "repo files (and which functions in them) the test actually ran, ranked — alongside the " +
      "typed pass/fail summary. Use this FIRST when debugging a failing test instead of " +
      "searching for suspects: read the top executedPath files, they are the code the failure " +
      "actually traversed. Optionally narrow to one test with `test_name`. Anti-triggers: " +
      "for plain pass/fail over several files use `test_unit_run`; for 'what tests cover " +
      "symbol X' use `search`; this tool runs exactly one test file, never " +
      "a package or the repo.",
    inputSchema: z.object({
      test_file: z
        .string()
        .describe("The single test file to trace (repo-relative or absolute)."),
      test_name: z
        .string()
        .optional()
        .describe("Narrow to tests whose name matches (vitest -t)."),
      timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Max run time in ms (default 120000, max 600000)."),
      max_files: z
        .number()
        .int()
        .optional()
        .describe(
          `Max executed files to report (default ${TRACE_FILE_CAPS.standard}, max ${TRACE_FILE_CAPS.verbose}).`,
        ),
    }),
    execute: async ({ test_file, test_name, timeout_ms, max_files }) => {
      const maxFiles = Math.min(
        max_files ?? TRACE_FILE_CAPS.standard,
        TRACE_FILE_CAPS.verbose,
      );
      const timeout = Math.min(
        timeout_ms ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      // Unique per-invocation dir keeps parallel turns from cross-reading.
      const coverageDir = `.oxagen-trace-${Date.now().toString(36)}-${process.pid}`;
      const runCommand = buildTraceCommand({
        file: test_file,
        testName: test_name,
        coverageDir,
      });

      let run;
      try {
        run = await workspace.exec(runCommand, {
          timeoutMs: timeout,
          signal: deps.signal,
        });
      } catch (err) {
        return {
          testFile: test_file,
          error: `Failed to run traced vitest: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      deps.onEvent?.({
        type: "command",
        command: runCommand,
        exitCode: run.exitCode,
      });

      try {
        if (run.timedOut) {
          return {
            testFile: test_file,
            timedOut: true,
            hint: `traced vitest timed out after ${timeout}ms; narrow with test_name or raise timeout_ms.`,
          };
        }

        const parsed = parseVitestJson(run.stdout, TRACE_FAILURE_CAP);

        // Summarize the trace where it ran; the raw coverage JSON never crosses here.
        const summarizeCommand = buildTraceSummarizeCommand({
          coverageDir,
          root: workspace.root,
          maxFiles,
        });
        let executedPath: { files: ExecutedFile[]; scanned: number } | null =
          null;
        try {
          const summary = await workspace.exec(summarizeCommand, {
            timeoutMs: 30_000,
            signal: deps.signal,
          });
          executedPath = parseTraceSummary(summary.stdout);
        } catch {
          executedPath = null; // trace degraded, pass/fail still useful
        }

        if (parsed.parseError) {
          const tail = clipStr(
            run.stderr.slice(-MAX_STDERR_TAIL),
            MAX_STDERR_TAIL,
          );
          return {
            testFile: test_file,
            parseError: true,
            exitCode: run.exitCode,
            passed: run.exitCode === 0,
            stderrTail: tail || "(no stderr)",
            executedPath: executedPath ?? undefined,
          };
        }

        return {
          testFile: test_file,
          testName: test_name,
          passed: parsed.passed,
          failed: parsed.failed,
          skipped: parsed.skipped,
          durationMs: parsed.durationMs,
          failures: parsed.failures,
          executedPath: executedPath ?? undefined,
          traceDegraded: executedPath === null || undefined,
          hint:
            parsed.failed > 0 && executedPath && executedPath.files.length > 0
              ? "Ground the debugging in executedPath: these files/functions actually ran during the failure — read the top entries before searching elsewhere."
              : undefined,
        };
      } finally {
        // Always drop the coverage dir — even on timeout/parse failure.
        try {
          await workspace.exec(`rm -rf ${shQuote(coverageDir)}`, {
            timeoutMs: 15_000,
          });
        } catch {
          // best-effort cleanup; a leftover dir is harmless and gitignored dot-prefixed
        }
      }
    },
  });
}
