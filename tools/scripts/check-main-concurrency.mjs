#!/usr/bin/env node
/**
 * Pushes to main share one concurrency group, and nothing cancels a running
 * main run (ADR-287).
 *
 * GitHub runs one run per group and keeps one more waiting. A newer push
 * replaces the waiting run, which never starts and costs nothing. Because
 * `cancel-in-progress` is false for a push, the running run always finishes
 * and the newest waiting push starts next. Main therefore runs one full gate
 * at a time, in commit order, and each run checks and ships every merge since
 * the run before it.
 *
 * Three edits would each look like a tidy-up in review:
 *
 * 1. Keying the group by `github.sha` again, as ADR-046 did from 2026-09-07 to
 *    2026-10-02. Every merge then runs the full gate, about three times the
 *    runner time (#5248), and several main runs in flight let an older commit
 *    deploy after a newer commit's migration (#5247).
 * 2. Letting `cancel-in-progress` be true for a push. A running main run
 *    applies production migrations in `migration-gate`, and cancelling it
 *    mid-apply strands production behind the committed migrations. When
 *    merges arrive faster than a run finishes, every run is cancelled and
 *    nothing deploys.
 * 3. Dropping the push test from the group, so a manual dispatch on main
 *    shares the push group. A dispatch skips the gate, so a dispatch that
 *    replaces a waiting push run leaves the newest commit unchecked and
 *    undeployed until the next merge.
 *
 * Deliberately a string check on the expressions rather than a behavioural
 * test. GitHub evaluates them server-side; there is nothing to run locally,
 * so what can be held still is the shape.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = join(repoRoot, ".github", "workflows", "pipeline.yml");

/** The workflow-level `concurrency:` block, comment lines removed. */
function concurrencyBody(yaml) {
  const block = yaml.match(/^concurrency:\n((?:[ \t]+.*\n|\n)*)/m);
  if (!block) return null;
  return block[1]
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** The `concurrency:` block's `group:` value, comments and folding removed. */
export function concurrencyGroup(yaml) {
  const body = concurrencyBody(yaml);
  if (body === null) return null;
  const group = body.match(
    /^\s*group:\s*(>-|\|-|>|\|)?\s*\n?((?:.|\n)*?)(?=\n\s*\w[\w-]*:|$)/,
  );
  if (!group) return null;
  return group[2].replace(/\s+/g, " ").trim();
}

/** The `concurrency:` block's `cancel-in-progress:` value, or null. */
export function cancelInProgress(yaml) {
  const body = concurrencyBody(yaml);
  if (body === null) return null;
  const value = body.match(/^\s*cancel-in-progress:\s*(.+?)\s*$/m);
  return value ? value[1] : null;
}

const PULL_REQUESTS_ONLY =
  /^\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/;

/**
 * Every problem with the workflow's concurrency, or an empty list.
 *
 * @param {string | null} group the value `concurrencyGroup` returns
 * @param {string | null} cancel the value `cancelInProgress` returns
 */
export function concurrencyProblems(group, cancel) {
  const problems = [];
  if (!group) {
    problems.push("no `group:` found in the workflow's concurrency block");
  } else {
    if (group.includes("github.sha")) {
      problems.push(
        "the group is keyed by github.sha, so every push to main runs the full gate at once (#5248, #5247)",
      );
    }
    if (
      !group.includes("github.event_name == 'push'") ||
      !group.includes("refs/heads/main")
    ) {
      problems.push(
        "the group does not keep pushes to main apart from other events on main, so a manual dispatch can replace a waiting push run",
      );
    }
  }
  if (cancel !== "false" && !PULL_REQUESTS_ONLY.test(cancel ?? "")) {
    problems.push(
      `cancel-in-progress is ${cancel ?? "missing"}; it must be false or true for pull requests only, because a main run applies production migrations`,
    );
  }
  return problems;
}

if (isEntrypoint(import.meta.url)) {
  const yaml = readFileSync(path, "utf8");
  const group = concurrencyGroup(yaml);
  const problems = concurrencyProblems(group, cancelInProgress(yaml));
  if (problems.length > 0) {
    console.error(
      "check-main-concurrency: pushes to main must share one group that never cancels a running run.\n\n" +
        `  found: ${group ?? "(no group: found)"}\n\n` +
        problems.map((p) => `  ${p}`).join("\n") +
        "\n\nADR-287 has the reasoning.",
    );
    process.exit(1);
  }
  console.log(
    "check-main-concurrency: pushes to main share one group, and nothing cancels a running main run.",
  );
}
