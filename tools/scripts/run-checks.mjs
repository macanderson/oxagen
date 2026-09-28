#!/usr/bin/env node
/**
 * Run every named `pnpm` check, then fail if any of them failed (#3428).
 *
 * The `checks` job in `pipeline.yml` used to chain eight checks with `&&`:
 * `check:manifest && check:contracts && env:check && ...`. The first failure
 * ended the step, so a branch with two independent problems learned about one
 * per CI cycle. PR #3385 paid three cycles for two ESLint errors and one knip
 * finding on 2026-09-19.
 *
 * The checks do not depend on each other. This runner runs each one in order
 * with the step's own stdout and stderr, records its exit status, and prints
 * a summary that names every failure. It exits 1 when any check failed, so the
 * step and the job still fail. Only the amount a contributor learns per run
 * changes.
 *
 * Usage: node tools/scripts/run-checks.mjs check:manifest check:contracts ...
 */
import { spawnSync } from "node:child_process";

/**
 * Run `pnpm run <name>` with inherited stdio and return its exit status.
 *
 * A check killed by a signal has a null status. It counts as a failure, since
 * a check that did not finish did not pass.
 */
export function runPnpmScript(name) {
  const result = spawnSync("pnpm", ["run", name], { stdio: "inherit" });
  if (result.error) {
    console.error(
      `run-checks: could not start pnpm for ${name}: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * Run every check in order, whatever the earlier ones returned.
 *
 * `run` is injected so the test can drive the loop without spawning pnpm.
 * Returns each check's status and the names of the ones that failed.
 */
export function runChecks(names, run = runPnpmScript) {
  const results = [];
  for (const name of names) {
    console.log(`\n::group::${name}`);
    const status = run(name);
    console.log("::endgroup::");
    results.push({ name, status });
  }
  const failed = results.filter((r) => r.status !== 0).map((r) => r.name);
  return { results, failed };
}

/** The lines printed after the last check, one per check. */
export function summaryLines({ results, failed }) {
  const lines = ["", "run-checks summary:"];
  for (const { name, status } of results) {
    lines.push(
      `  ${status === 0 ? "pass" : "FAIL"}  ${name}${status === 0 ? "" : ` (exit ${status})`}`,
    );
  }
  lines.push(
    failed.length === 0
      ? `All ${results.length} checks passed.`
      : `${failed.length} of ${results.length} checks failed: ${failed.join(", ")}`,
  );
  // One annotation per failure, so each shows on the run's summary page
  // rather than only in the step log.
  for (const name of failed)
    lines.push(
      `::error title=${name} failed::pnpm ${name} exited non-zero. Its output is in the "${name}" group of this step's log.`,
    );
  return lines;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("run-checks: name at least one pnpm script to run.");
    process.exit(2);
  }
  const outcome = runChecks(names);
  for (const line of summaryLines(outcome)) console.log(line);
  process.exit(outcome.failed.length === 0 ? 0 : 1);
}
