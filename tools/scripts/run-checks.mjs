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
 * `check:contracts` runs its guards the same way. It was a chain of 26
 * commands joined by `&&`, so one failing guard hid every guard after it
 * (#4664 item 9). Each guard is now a root script, and `check:contracts` is a
 * run-checks list of them. The checks job starts `check:contracts` from its
 * own run-checks step, so that runner is nested. `outputMode` below keeps
 * the nested one from opening GitHub log groups inside the outer one.
 *
 * Usage: node tools/scripts/run-checks.mjs check:manifest check:contracts ...
 */
import { spawnSync } from "node:child_process";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

/**
 * Run `pnpm run <name>` with inherited stdio and return its exit status.
 *
 * A check killed by a signal has a null status. It counts as a failure, since
 * a check that did not finish did not pass.
 */
export function runPnpmScript(name) {
  const result = spawnSync("pnpm", ["run", name], {
    stdio: "inherit",
    // A run-checks list started by this check reads the name of the outermost
    // check, the one whose log group it prints inside.
    env: {
      ...process.env,
      RUN_CHECKS_PARENT: process.env.RUN_CHECKS_PARENT || name,
    },
  });
  if (result.error) {
    console.error(
      `run-checks: could not start pnpm for ${name}: ${result.error.message}`,
    );
    return 1;
  }
  return result.status ?? 1;
}

/**
 * How the runner marks its output, read from the environment.
 *
 * On GitHub Actions, a top-level runner folds each check into a `::group::`
 * and annotates each failure. GitHub does not nest log groups, so a runner
 * started by another runner's check (it sees `RUN_CHECKS_PARENT`) prints a
 * plain header per check inside the outer group. Off GitHub Actions, as in
 * the pre-push hook, workflow commands are noise: the runner prints headers
 * and no annotations.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ groups: boolean, annotate: boolean, parent: string | undefined }}
 */
export function outputMode(env = process.env) {
  const actions = env.GITHUB_ACTIONS === "true";
  const parent = env.RUN_CHECKS_PARENT || undefined;
  return { groups: actions && parent === undefined, annotate: actions, parent };
}

/**
 * Run every check in order, whatever the earlier ones returned.
 *
 * `run` is injected so the test can drive the loop without spawning pnpm.
 * Returns each check's status and the names of the ones that failed.
 *
 * @param {string[]} names
 * @param {(name: string) => number} [run]
 * @param {{ groups: boolean, annotate: boolean, parent?: string | undefined }} [mode]
 * @returns {{ results: { name: string, status: number }[], failed: string[] }}
 */
export function runChecks(names, run = runPnpmScript, mode = outputMode()) {
  const results = [];
  for (const name of names) {
    console.log(mode.groups ? `\n::group::${name}` : `\n=== ${name}`);
    const status = run(name);
    if (mode.groups) console.log("::endgroup::");
    results.push({ name, status });
  }
  const failed = results.filter((r) => r.status !== 0).map((r) => r.name);
  return { results, failed };
}

/**
 * Escape a workflow-command property value, as @actions/core does.
 *
 * `:` and `,` separate properties, so a check named `check:manifest` would
 * otherwise be read as a property boundary.
 */
export function escapeProperty(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/** Escape a workflow-command message, as @actions/core does. */
export function escapeData(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/**
 * The lines printed after the last check, one per check, then one error
 * annotation per failure when `mode.annotate` is set.
 *
 * @param {{ results: { name: string, status: number }[], failed: string[] }} outcome
 * @param {{ annotate: boolean, parent?: string | undefined }} [mode]
 * @returns {string[]}
 */
export function summaryLines(
  { results, failed },
  mode = { annotate: true, parent: undefined },
) {
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
  if (!mode.annotate) return lines;
  // One annotation per failure, so each shows on the run's summary page
  // rather than only in the step log.
  for (const name of failed) {
    const where = mode.parent
      ? `under "=== ${name}" in the "${mode.parent}" group`
      : `in the "${name}" group`;
    lines.push(
      `::error title=${escapeProperty(`${name} failed`)}::${escapeData(`pnpm ${name} exited non-zero. Its output is ${where} of this step's log.`)}`,
    );
  }
  return lines;
}

// lib/is-entrypoint.mjs compares real paths. The `file://${argv[1]}` test
// reads false through a symlink, and this runner would then exit 0 having
// run no check, so the CI step would pass green.
if (isEntrypoint(import.meta.url)) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("run-checks: name at least one pnpm script to run.");
    process.exit(2);
  }
  const mode = outputMode();
  const outcome = runChecks(names, runPnpmScript, mode);
  for (const line of summaryLines(outcome, mode)) console.log(line);
  process.exit(outcome.failed.length === 0 ? 0 : 1);
}
