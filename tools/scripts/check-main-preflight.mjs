#!/usr/bin/env node
/**
 * The full gate must not run to completion for a commit a later merge on
 * main already supersedes.
 *
 * ADR-046 gives every push to main its own concurrency group so a queued run
 * can never be evicted (#2730) — a queued run is protected, but nothing
 * protects a run that has already STARTED from doing 60+ minutes of `checks`
 * and `test` work for a commit that stopped mattering the moment a later
 * commit merged behind it. The later commit's run checks and ships
 * everything this one would (check-deploy-tip.mjs ships any commit newer
 * than what is live), so that work buys nothing, yet it holds a runner for
 * the full run, and under sustained merge pressure the queue of
 * full runs grows without bound: on 2026-09-21 `gh run list` showed 15
 * queued `pipeline.yml` runs on main behind 2 in progress, each costing the
 * full ~75-minute gate.
 *
 * The fix runs at the front of the workflow rather than by cancelling a run
 * in flight: cancellation mid-run is exactly what produced #2730 (a queued
 * run evicted before it ever executed a step), so this checks the tip once,
 * cheaply, before the expensive jobs start, and lets an already-running job
 * finish rather than killing it.
 *
 * Two parts, the same shape as check-deploy-tip.mjs:
 *
 * 1. Run as the `preflight` job's only step, it asks whether this run's event
 *    is a push to main at all. Every other trigger (a pull request, a manual
 *    dispatch) writes `proceed=true` immediately with no API call — the race
 *    this guards against exists only between pushes to main. For a push to
 *    main, it asks the API for the tip at that moment, the same call
 *    check-deploy-tip.mjs makes. When this commit is that tip it proceeds.
 *    When it is not, it asks `compare/{sha}...{tip}` whether the tip
 *    descends from this commit, and skips only on the answer `ahead`. Any
 *    other answer runs the gate: `behind` and `diverged` mean main was reset
 *    or force-pushed and this commit's checks are not implied by the tip's,
 *    and no answer at all is no evidence either way.
 *
 *    `preflight` itself always succeeds (a branch of its one step, never a
 *    skip), so `checks` / `test` / `e2e` / `rls-integration` /
 *    `rds-compatibility` can add `needs: [preflight]` and read its output
 *    without the default skip-propagation rule (a job skipped by its own
 *    `if:` skips everything that needs it) forcing every PR run to skip the
 *    whole gate.
 *
 *    An unreachable API fails open (runs the gate, with a warning): the same
 *    call blocking every commit's CI is the outage #2730 already was once.
 *
 * 2. Run as `node tools/scripts/check-main-preflight.mjs --guard` from
 *    `check:contracts`, it reads pipeline.yml and asserts the shape: every
 *    gated job needs `preflight` and carries the gate in its `if:`. Losing
 *    the gate from one job would look like a tidy-up in review and would
 *    restore the unbounded queue for that job alone.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_TIMEOUT_MS, readMainTip } from "./check-deploy-tip.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pipelinePath = join(repoRoot, ".github", "workflows", "pipeline.yml");

export const PREFLIGHT_JOB = "preflight";
export const PREFLIGHT_GATE = "needs.preflight.outputs.proceed == 'true'";
export const GATED_JOBS = [
  "checks",
  "test",
  "e2e",
  "rls-integration",
  "rds-compatibility",
];

/**
 * The preflight decision, separated from I/O so the race case is testable.
 *
 * `compare` is the API's answer to `compare/{sha}...{tip}`, read only when
 * the tip is another commit: `ahead` says the tip descends from this commit.
 * That is the one answer that lets the gate skip, because it is the one case
 * where the tip's own run checks everything this commit's would have.
 *
 * @param {{ eventName: string, ref: string | undefined, sha: string, tip: string | null, error?: string, compare?: { status: string | null, error?: string } }} input
 * @returns {{ proceed: boolean, reason: string, warning?: string }}
 */
export function decidePreflight({ eventName, ref, sha, tip, error, compare }) {
  if (!(eventName === "push" && ref === "refs/heads/main")) {
    return {
      proceed: true,
      reason: `${eventName} does not race another run on main; running the full gate`,
    };
  }
  const short = sha.slice(0, 9);
  if (tip === null || tip === undefined) {
    return {
      proceed: true,
      reason: `could not read the tip of main (${error ?? "no answer"}); running the full gate for ${short} rather than blocking on the API`,
      warning: `check-main-preflight could not read the tip of main: ${error ?? "no answer"}`,
    };
  }
  if (tip === sha) {
    return { proceed: true, reason: `${short} is the tip of main` };
  }
  const tipShort = tip.slice(0, 9);
  const status = compare?.status ?? null;
  if (status === "ahead") {
    return {
      proceed: false,
      reason: `${short} is no longer the tip of main (${tipShort} is) and the tip descends from it; the tip's run covers this commit, so this one skips`,
    };
  }
  if (status === null) {
    return {
      proceed: true,
      reason: `${short} is not the tip of main (${tipShort} is), and whether the tip descends from it could not be read (${compare?.error ?? "no answer"}); running the full gate`,
      warning: `check-main-preflight could not compare ${short} with the tip ${tipShort}: ${compare?.error ?? "no answer"}`,
    };
  }
  return {
    proceed: true,
    reason: `${short} is not the tip of main (${tipShort} is) and the tip does not descend from it (compare says ${status}); the tip's run does not cover this commit, so this one runs the full gate`,
  };
}

/**
 * Ask the GitHub API how `tip` relates to `sha`: `ahead` when `tip` descends
 * from `sha`, `behind` when main was reset to an ancestor, `diverged` after a
 * force-push, `identical` when they are one commit. Never throws.
 */
export async function readCompare({
  repository,
  token,
  sha,
  tip,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repository}/compare/${sha}...${tip}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return { status: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    const status = body?.status;
    if (typeof status !== "string" || status.length === 0)
      return { status: null, error: "response carried no status" };
    return { status };
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the `if:` value of a top-level job block, comments dropped, folded to
 * one line. Deliberately a string reader, like check-main-concurrency and
 * check-deploy-tip: GitHub evaluates these server-side and what can be held
 * still locally is the shape.
 */
function jobBlock(yaml, job) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z][\w-]*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start, end)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Every problem with the gated jobs' shape, or an empty list. */
export function guardProblems(yaml) {
  if (jobBlock(yaml, PREFLIGHT_JOB) === null) {
    return [`no "${PREFLIGHT_JOB}" job found`];
  }
  const problems = [];
  for (const job of GATED_JOBS) {
    const block = jobBlock(yaml, job);
    if (block === null) {
      problems.push(`${job}: job not found`);
      continue;
    }
    if (!/^\s*needs:.*\bpreflight\b/m.test(block)) {
      problems.push(`${job}: does not list "needs: [preflight]" (or similar)`);
    }
    if (!block.includes(PREFLIGHT_GATE)) {
      problems.push(
        `${job}: its "if:" does not include \`${PREFLIGHT_GATE}\`, so it runs the full gate even when a later push already supersedes it`,
      );
    }
  }
  return problems;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  if (process.argv.includes("--guard")) {
    const problems = guardProblems(readFileSync(pipelinePath, "utf8"));
    if (problems.length > 0) {
      console.error(
        "check-main-preflight: a job can run the full gate for a commit a later push already supersedes.\n\n" +
          problems.map((p) => `  ${p}`).join("\n") +
          "\n\nUnbounded, that queue burns runner-minutes and delays every commit behind it.",
      );
      process.exit(1);
    }
    console.log("check-main-preflight: every gated job skips when superseded.");
  } else {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const ref = process.env.GITHUB_REF;
    const sha = process.env.GITHUB_SHA;
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!eventName || !sha || !repository || !token) {
      console.error(
        "check-main-preflight: GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REPOSITORY and GH_TOKEN must be set",
      );
      process.exit(1);
    }
    let tip = null;
    let error;
    let compare;
    if (eventName === "push" && ref === "refs/heads/main") {
      ({ tip, error } = await readMainTip({ repository, token }));
      if (tip !== null && tip !== sha) {
        compare = await readCompare({ repository, token, sha, tip });
      }
    }
    const verdict = decidePreflight({
      eventName,
      ref,
      sha,
      tip,
      error,
      compare,
    });
    if (verdict.warning) console.log(`::warning::${verdict.warning}`);
    console.log(
      `${verdict.proceed ? "running the full gate" : "::notice::skipping the full gate"}: ${verdict.reason}`,
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${verdict.proceed}\n`);
    }
  }
}
