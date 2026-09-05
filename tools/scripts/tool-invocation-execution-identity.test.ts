/**
 * tool-invocation-execution-identity.test.ts — repo-wide regression guard for
 * ClickHouse `tool_invocations.execution_step_id` (#2597, #2615).
 *
 * `tool_invocations` carries an `execution_step_id` column so a recorded tool
 * call can be joined back to the run that made it. Every producer used to
 * write a hardcoded `null` into it, which is indistinguishable from a run that
 * genuinely did nothing — the column had the right shape, a query was already
 * written against it, and no writer ever filled it in. #2597 fixed the shared
 * factory; #2615 fixed the remaining five.
 *
 * Each of those fixes was proved by a test in its own package, and none of
 * them can see a producer added later or a sibling producer reverted. This
 * guard is the cross-package half: it finds every call site of the one writer
 * seam and fails if any of them assigns a bare `null` literal to the identity.
 *
 * WHAT IS AND IS NOT A REGRESSION. A row with no run behind it — an API call,
 * an external tool, a person — must still record absence, so `?? null` on a
 * value that may be missing is the correct shape and passes. A bare `null`
 * literal is the regression: it says "no run" for every row unconditionally,
 * including the ones that had one.
 *
 * Narrow run:
 *   pnpm --filter @oxagen/scripts test:unit -- tool-invocation-execution-identity.test.ts
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Recursively collect *.ts / *.tsx source files under a root, skipping noise. */
function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir may not exist in every checkout
    }
    for (const name of entries) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

const sourceFiles = [
  ...collectSourceFiles(join(repoRoot, "packages")),
  ...collectSourceFiles(join(repoRoot, "apps")),
];

/**
 * `insertToolInvocation` is the only writer of the table, so calling it is
 * what makes a file a producer. Declaring the seam is not calling it, which is
 * why the module that exports it is excluded rather than special-cased below.
 */
const WRITER_MODULE = join(
  repoRoot,
  "packages",
  "telemetry",
  "src",
  "clickhouse.ts",
);
const CALLS_WRITER = /\binsertToolInvocation\s*\(/;

const producerFiles = sourceFiles.filter(
  (file) =>
    file !== WRITER_MODULE && CALLS_WRITER.test(readFileSync(file, "utf8")),
);

/**
 * The producers known when this guard was written. A new producer is expected
 * and simply gets scanned; this list exists so a *disappearance* — a rename, a
 * move, a path bug — is reported rather than silently shrinking the scan.
 */
const KNOWN_PRODUCERS = [
  "packages/agent/src/runtime/materialize-tools.ts",
  "packages/handlers/src/graph.telemetry.ts",
  "packages/inngest-functions/src/functions/agent.background-task.execute.ts",
  "packages/inngest-functions/src/functions/agent.execute-subagent.ts",
  "packages/inngest-functions/src/functions/agent.workflow.task.execute.ts",
  "packages/inngest-functions/src/functions/playbook.run.execute.ts",
];

/** Matches `execution_step_id: null` (or `undefined`) in an object literal. */
const NULL_IDENTITY = /execution_step_id\s*:\s*(null|undefined)\s*[,}]/g;

const relativeToRepo = (file: string) =>
  relative(repoRoot, file).split("\\").join("/");

describe("tool_invocations execution identity (#2597, #2615)", () => {
  it("collected a non-trivial set of source files to scan", () => {
    // Guard against a path bug silently scanning nothing and passing.
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it("still finds every producer known when this guard was written", () => {
    const found = new Set(producerFiles.map(relativeToRepo));
    const missing = KNOWN_PRODUCERS.filter((p) => !found.has(p));
    expect(
      missing,
      "a known tool_invocations producer is no longer detected — if it moved, " +
        "update KNOWN_PRODUCERS; if it stopped writing telemetry, say so in the PR",
    ).toEqual([]);
  });

  it("no producer writes a bare null execution identity", () => {
    const offenders: string[] = [];
    for (const file of producerFiles) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        NULL_IDENTITY.lastIndex = 0;
        if (NULL_IDENTITY.test(line)) {
          offenders.push(`${relativeToRepo(file)}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      "a tool_invocations producer hardcodes execution_step_id to null, which " +
        "makes every one of its rows unjoinable to the run that produced it. " +
        "Pass the run identity the producer already uses as its message key; " +
        "where a call genuinely has no run, write `?? null` on that value so " +
        "absence stays conditional rather than universal (#2615).",
    ).toEqual([]);
  });
});
