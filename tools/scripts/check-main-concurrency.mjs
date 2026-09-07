#!/usr/bin/env node
/**
 * A push to main must not share a concurrency group with the push after it.
 *
 * GitHub holds one *queued* run per concurrency group. While a run is going, a
 * second waits and a third evicts the second before it starts. When merges
 * arrive faster than a run finishes, that chain never terminates: every run is
 * evicted before executing, nothing ever concludes, and `deploy-web` /
 * `deploy-node` never run because they need a passing check. Cancelled runs
 * read as ordinary cleanup, so nothing goes red.
 *
 * That is not hypothetical. On 2026-09-07 the last finished run on main was
 * `40585e52` at 19:23 UTC, and eight commits merged behind it undeployed
 * (#2730).
 *
 * The fix is a per-commit group for pushes to main, and the property worth
 * guarding is narrow: the group expression must vary with `github.sha` for that
 * case. A future edit that simplifies the expression back to `ci-${{ github.ref }}`
 * restores the outage, and it would look like a tidy-up in review.
 *
 * Deliberately a string check on the expression rather than a behavioural test.
 * GitHub evaluates these expressions server-side; there is nothing to run
 * locally, so what can be held still is the shape.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const path = join(repoRoot, ".github", "workflows", "pipeline.yml");

/** The `concurrency:` block's `group:` value, comments and folding removed. */
export function concurrencyGroup(yaml) {
  const block = yaml.match(/^concurrency:\n((?:[ \t]+.*\n|\n)*)/m);
  if (!block) return null;
  const body = block[1]
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const group = body.match(
    /^\s*group:\s*(>-|\|-|>|\|)?\s*\n?((?:.|\n)*?)(?=\n\s*\w[\w-]*:|$)/,
  );
  if (!group) return null;
  return group[2].replace(/\s+/g, " ").trim();
}

/** Does the group vary per commit for a push to main? */
export function isPerCommitOnMain(group) {
  if (!group) return false;
  return (
    group.includes("github.sha") &&
    group.includes("refs/heads/main") &&
    /push/.test(group)
  );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  const group = concurrencyGroup(readFileSync(path, "utf8"));
  if (!isPerCommitOnMain(group)) {
    console.error(
      "check-main-concurrency: a push to main must get its own concurrency group.\n\n" +
        `  found: ${group ?? "(no group: found)"}\n\n` +
        "Without github.sha in the group, a queued run is evicted by the next\n" +
        "merge. Under sustained merge pressure nothing finishes and deploys stop\n" +
        "silently — eight commits shipped nowhere on 2026-09-07 (#2730).",
    );
    process.exit(1);
  }
  console.log("check-main-concurrency: a push to main gets its own group.");
}
