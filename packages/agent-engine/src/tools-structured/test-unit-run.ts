// tools-structured/test-unit-run.ts
//
// test.unit.run (model-facing test_unit_run) — run vitest deterministically over
// a SELECTED set of test files and return a small typed pass/fail summary instead
// of the reporter's raw scrollback. ADR-021 §1: file selection is a pure function
// (the lowest rung — no model); ADR-021 §3: the JSON reporter output passes a
// deterministic parser (parseVitestJson) before the model ever sees it, so a
// 500-line failing run collapses to counts + the first N assertion messages.
// ZERO model calls.
//
// STATE, not STRUCTURE: this tool answers "does the change pass?" — a runtime
// STATE question. It never answers "what tests exercise this symbol?" or "who
// imports this?" — for those the agent greps.
// It only uses import edges to SELECT which existing tests to execute.

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
import {
  parseVitestJson,
  siblingTestCandidates,
  importGrepPattern,
  testFilesFromGrepHits,
  shQuote,
  clipStr,
  MAX_TEST_FAILURES,
  MAX_SELECTED_TESTS,
  MAX_STDERR_TAIL,
} from "./parse";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Cap on grep hits scanned per changed module when finding importers. */
const IMPORTER_GREP_CAP = 200;

/** Per-verbosity ceiling on reported failing assertions (minimal = the default cap). */
export const TEST_FAILURE_CAPS = {
  minimal: MAX_TEST_FAILURES,
  standard: 40,
  verbose: 80,
} as const;

interface StructuredToolDeps {
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

/**
 * Deterministically select the test files to run for a set of changed files:
 *   (a) the sibling / same-name test (`<base>.test.ts`, `__tests__/<base>...`),
 *   (b) test files that import the changed module (bounded workspace grep),
 *   (c) a changed file that is ITSELF a test → run it directly.
 * Existence of (a) candidates is confirmed against the directory listing so we
 * never hand vitest a path that isn't there. Bounded to MAX_SELECTED_TESTS.
 */
export async function selectTestsForChanges(
  workspace: Workspace,
  changedFiles: string[],
): Promise<string[]> {
  const selected = new Set<string>();

  // Group sibling candidates by directory so we list each dir at most once.
  const candidatesByDir = new Map<string, Set<string>>();
  const directTests: string[] = [];
  const importPatterns: string[] = [];

  for (const changed of changedFiles) {
    const norm = changed.replace(/\\/g, "/");
    const siblings = siblingTestCandidates(norm);
    if (siblings.length === 0) {
      // siblingTestCandidates returns [] iff `changed` is itself a test — (c).
      directTests.push(norm);
      continue;
    }
    for (const cand of siblings) {
      const slash = cand.lastIndexOf("/");
      const dir = slash === -1 ? "." : cand.slice(0, slash);
      const name = slash === -1 ? cand : cand.slice(slash + 1);
      const set = candidatesByDir.get(dir) ?? new Set<string>();
      set.add(name);
      candidatesByDir.set(dir, set);
    }
    const pattern = importGrepPattern(norm);
    if (pattern) importPatterns.push(pattern);
  }

  for (const t of directTests) selected.add(t);

  // (a) Confirm sibling candidates against the real directory listing.
  await Promise.all(
    [...candidatesByDir.entries()].map(async ([dir, names]) => {
      let entries: string[];
      try {
        entries = await workspace.list(dir === "." ? undefined : dir);
      } catch {
        return; // dir doesn't exist → no siblings from it
      }
      const present = new Set(entries.map((e) => e.replace(/\/$/, "")));
      for (const name of names) {
        if (present.has(name))
          selected.add(dir === "." ? name : `${dir}/${name}`);
      }
    }),
  );

  // (b) Test files importing a changed module (bounded grep, test-shaped only).
  for (const pattern of importPatterns) {
    if (selected.size >= MAX_SELECTED_TESTS) break;
    let hits: string[];
    try {
      hits = await workspace.grep(pattern);
    } catch {
      continue;
    }
    for (const file of testFilesFromGrepHits(hits, IMPORTER_GREP_CAP)) {
      selected.add(file);
      if (selected.size >= MAX_SELECTED_TESTS) break;
    }
  }

  return [...selected].slice(0, MAX_SELECTED_TESTS);
}

/** Build the vitest command for a package and/or an explicit file list. */
export function buildVitestCommand(opts: {
  pkg?: string;
  files: string[];
  failFast?: boolean;
}): string {
  const parts: string[] = [];
  if (opts.pkg)
    parts.push("pnpm", "--filter", shQuote(opts.pkg), "exec", "vitest", "run");
  else parts.push("pnpm", "exec", "vitest", "run");
  for (const f of opts.files) parts.push(shQuote(f));
  parts.push("--reporter=json", "--no-color");
  if (opts.failFast) parts.push("--bail=1");
  return parts.join(" ");
}

export function buildTestUnitRunTool(
  workspace: Workspace,
  deps: StructuredToolDeps,
): Tool {
  return tool({
    description:
      "Run vitest over ONLY the test files implicated by a change and return a typed " +
      "pass/fail summary (counts + the first failing assertions with file:line), not the " +
      "reporter's raw scrollback. Prefer this over `bash pnpm vitest`/`test:unit` whenever " +
      "you want to know if a change PASSES: it selects the sibling test + importing tests of " +
      "your `changedFiles` deterministically and parses the JSON reporter, so you spend tokens " +
      "on failures, not logs. Set `scope.package` to run one package's suite or `scope.files` " +
      "for exact paths. Anti-triggers: it NEVER runs a whole-repo suite (`scope.all` and an " +
      "empty selection both return a hint, not everything); for a non-test command (build, git, " +
      "install) use `bash`; to typecheck use `build_package_run`. This answers the STATE " +
      "question 'does it pass?' — to find WHICH tests cover a symbol or who imports a module, " +
      "`search` for it, then pass those files here as `changedFiles`.",
    inputSchema: z.object({
      scope: scopeSchema
        .optional()
        .describe(
          "Where to run: {package} for one package's suite, {files} for exact test paths. " +
            "{all:true} is rejected — this tool never runs the whole repo. Omit to select purely from changedFiles.",
        ),
      changedFiles: z
        .array(z.string())
        .optional()
        .describe(
          "Source files you changed; their sibling tests + importing tests are selected and run.",
        ),
      failFast: z
        .boolean()
        .optional()
        .describe("Stop at the first failing test (--bail=1)."),
      timeoutMs: z
        .number()
        .int()
        .optional()
        .describe("Max run time in ms (default 120000, max 600000)."),
      verbosity: verbositySchema.optional(),
      limit: limitSchema(TEST_FAILURE_CAPS.verbose).describe(
        `Max failing assertions to report (1–${TEST_FAILURE_CAPS.verbose}). Omit to let verbosity choose.`,
      ),
    }),
    execute: async ({
      scope,
      changedFiles,
      failFast,
      timeoutMs,
      verbosity,
      limit,
    }) => {
      // Guardrail (ADR-021 §3 / CLAUDE.md "NEVER run all tests"): `all` would
      // mean the whole repo — refuse structurally before any command is built.
      if (scope?.all) {
        return {
          selected: [],
          hint:
            "This tool never runs the whole repo. Pass `scope.package` to run one package's " +
            "suite, or `scope.files` for explicit paths.",
        };
      }
      const pkg = scope?.package;
      const explicit = scope?.files ?? [];

      // Deterministic selection: explicit files ∪ derived-from-changedFiles.
      const derived =
        changedFiles && changedFiles.length > 0
          ? await selectTestsForChanges(workspace, changedFiles)
          : [];
      const selected = [...new Set([...explicit, ...derived])].slice(
        0,
        MAX_SELECTED_TESTS,
      );

      // With no files AND no package, running vitest would sweep the whole repo —
      // refuse and hint. A package with no selected files runs that package only.
      if (selected.length === 0 && !pkg) {
        return {
          selected: [],
          hint:
            "No test files matched. Pass `scope.package` to run one package's suite, or " +
            "`scope.files` for explicit paths — this tool never runs the whole repo.",
        };
      }

      const maxFailures = resolveLimit(
        (verbosity ?? "minimal") as Verbosity,
        TEST_FAILURE_CAPS,
        limit,
      );
      const command = buildVitestCommand({ pkg, files: selected, failFast });
      const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      let result;
      try {
        result = await workspace.exec(command, {
          timeoutMs: timeout,
          signal: deps.signal,
        });
      } catch (err) {
        return {
          selected,
          error: `Failed to run vitest: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      deps.onEvent?.({ type: "command", command, exitCode: result.exitCode });

      if (result.timedOut) {
        return {
          selected,
          timedOut: true,
          hint: `vitest timed out after ${timeout}ms; narrow the selection.`,
        };
      }

      const parsed = parseVitestJson(result.stdout, maxFailures);
      if (parsed.parseError) {
        // Reporter output unparseable → fall back to exit code + a bounded
        // stderr tail (never the whole firehose), flagged so the model knows the
        // summary is degraded rather than a clean pass.
        const tail = clipStr(
          result.stderr.slice(-MAX_STDERR_TAIL),
          MAX_STDERR_TAIL,
        );
        return {
          selected,
          parseError: true,
          exitCode: result.exitCode,
          passed: result.exitCode === 0,
          stderrTail: tail || "(no stderr)",
        };
      }

      return {
        selected,
        selectedTests: selected,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        durationMs: parsed.durationMs,
        failures: parsed.failures,
        truncated: parsed.truncatedFailures,
      };
    },
  });
}
