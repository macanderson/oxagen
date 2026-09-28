#!/usr/bin/env node
/**
 * Report a pull request whose CI runs keep getting cancelled by newer pushes
 * before any of them finishes (#3257, ADR-215).
 *
 * `pipeline.yml` groups a pull request's runs by branch and cancels the run in
 * progress when a new push arrives (ADR-046). The ruleset on `main` requires
 * `checks` and `test`, and a `cancelled` conclusion is not a pass. So a branch
 * pushed faster than CI finishes can never satisfy its required checks, and
 * nothing goes red: every run reads `cancelled`, which looks like ordinary
 * cleanup. On 2026-09-18 PR #3233's branch had nine CI runs in 100 minutes,
 * eight cancelled and none finished.
 *
 * ## Three states, not two
 *
 * The runs are read newest first. Runs still queued or in progress are no
 * answer yet and are skipped. Each `cancelled` run extends the streak. The
 * first run that concluded any other way (success, failure, timed out, and so
 * on) ends it, because that run reported something a person can see.
 *
 *   superseded  the streak reached THRESHOLD: the branch keeps getting cancelled
 *   answered    a run concluded before the streak reached THRESHOLD
 *   pending     no run has concluded yet and the streak is short
 *
 * Only `superseded` reports. One supersede followed by a finished run is
 * `answered`, and a first run still going is `pending`, so neither fires.
 *
 * ## Where it reports
 *
 * A failing commit status named `ci-superseded` on the pull request's head
 * commit, which shows in the PR's checks list, and one PR comment carrying
 * MARKER, edited in place rather than posted again. When a later run
 * concludes, the status turns to success and the comment says the streak
 * ended. The status is not a required check, so it never blocks a merge.
 *
 * ## Paging
 *
 * A short page of runs reads the same as no runs. The script pages until a run
 * concluded with an answer, the history ends, or MAX_PAGES is read, and says
 * "at least" when the page cap cut the streak short.
 *
 * ## It fails open
 *
 * An unreadable API or a missing token prints a warning and exits 0. The
 * detector must never be the thing that blocks a merge.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- ci-superseded -->";
export const RESOLVED_MARKER = "<!-- ci-superseded:resolved -->";
export const STATUS_CONTEXT = "ci-superseded";
const WORKFLOW = "pipeline.yml";
const MAX_PAGES = 5;
const PER_PAGE = 100;

/**
 * Keep the runs that belong to this pull request's branch.
 *
 * `branch=` in the API filters by branch name only, so a fork with a branch of
 * the same name would mix in. A branch reused by an earlier, closed pull
 * request would mix in that PR's runs too, and cancel-closed-pr-runs.yml
 * cancels those on close. `since` (the PR's creation time) drops them.
 */
export function relevantRuns(runs, { headRepo, since } = {}) {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  return runs.filter((run) => {
    if (run.event !== "pull_request") return false;
    if (headRepo && run.head_repository?.full_name !== headRepo) return false;
    if (!Number.isNaN(sinceMs) && Date.parse(run.created_at) < sinceMs) return false;
    return true;
  });
}

/**
 * Classify one branch's runs, given newest first.
 *
 * Returns the state, the cancelled streak (newest first), and the run that
 * ended it, or null when none did.
 */
export function classify(runs, { threshold = 3 } = {}) {
  const streak = [];
  let answered = null;
  for (const run of runs) {
    if (run.status !== "completed") continue;
    if (run.conclusion === "cancelled") {
      streak.push(run);
      continue;
    }
    answered = run;
    break;
  }
  const state = streak.length >= threshold ? "superseded" : answered ? "answered" : "pending";
  return { state, streak, answered };
}

/** Minutes between consecutive run creations in the streak, as the median. */
export function medianGapMinutes(streak) {
  const times = streak
    .map((run) => Date.parse(run.created_at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (times.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 60000);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.round(median);
}

/** The comment posted, or edited in place, while the branch is superseded. */
export function supersededBody({ streak, capped = false, threshold = 3 }) {
  const last = `${capped ? "At least the last" : "The last"} ${streak.length}`;
  const gap = medianGapMinutes(streak);
  const rows = streak
    .slice(0, 10)
    .map(
      (run) =>
        `| [${run.id}](${run.html_url}) | \`${String(run.head_sha).slice(0, 9)}\` | ${run.created_at} |`,
    );
  const lines = [
    MARKER,
    `**${last} CI runs on this branch were cancelled by newer pushes before they finished.**`,
    "",
    "The required `checks` and `test` did not conclude on any of them. A cancelled required check is not a pass, so neither can pass until a run finishes (ADR-215).",
    "",
    "| Run | Commit | Created |",
    "|---|---|---|",
    ...rows,
  ];
  if (streak.length > 10) lines.push("", `${streak.length - 10} older cancelled runs are not listed.`);
  if (gap !== null) lines.push("", `New runs started a median of ${gap} minutes apart.`);
  lines.push(
    "",
    "To get an answer, let the current run finish before you push again.",
    `This comment updates in place. The \`${STATUS_CONTEXT}\` status clears when a run finishes. It reports after ${threshold} cancelled runs in a row.`,
  );
  return lines.join("\n");
}

/** The comment's text once a run concluded after the streak. */
export function resolvedBody({ answered }) {
  return [
    MARKER,
    RESOLVED_MARKER,
    `The streak of cancelled CI runs this comment reported has ended. Run [${answered.id}](${answered.html_url}) on \`${String(answered.head_sha).slice(0, 9)}\` concluded \`${answered.conclusion}\` at ${answered.updated_at ?? answered.created_at}.`,
  ].join("\n");
}

/**
 * The streak length that reports, from CI_SUPERSEDED_THRESHOLD.
 *
 * Unset, empty, or anything but a whole number of at least 2 reads as 3.
 * `Number("")` is 0, and a threshold of 0 would report every branch with a
 * finished run as superseded; 1 would fire on the ordinary single supersede
 * the detector must stay silent on.
 */
export function parseThreshold(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 2 ? n : 3;
}

/**
 * @typedef {{
 *   kind: "status" | "comment-create" | "comment-update",
 *   state?: "failure" | "success",
 *   description?: string,
 *   targetUrl?: string,
 *   id?: number,
 *   body?: string,
 * }} Action
 */

/**
 * What to write for a verdict, given what is already there.
 *
 * Pure, so the test can assert that a superseded branch gets one failing
 * status and one comment, that an answered branch clears only what an earlier
 * report left, and that a pending branch writes nothing.
 *
 * @param {{ state: string, streak: any[], answered: any }} verdict
 * @param {{
 *   existingComment?: { id: number, body: string } | null,
 *   existingStatus?: string | null,
 *   capped?: boolean,
 *   threshold?: number,
 * }} [options]
 * @returns {Action[]}
 */
export function plan(verdict, { existingComment = null, existingStatus = null, capped = false, threshold = 3 } = {}) {
  const actions = [];
  if (verdict.state === "superseded") {
    const body = supersededBody({ streak: verdict.streak, capped, threshold });
    actions.push({
      kind: "status",
      state: "failure",
      description: `${capped ? "At least " : ""}${verdict.streak.length} CI runs in a row were cancelled by newer pushes`,
      targetUrl: verdict.streak[0]?.html_url,
    });
    if (!existingComment) actions.push({ kind: "comment-create", body });
    else if (existingComment.body !== body) actions.push({ kind: "comment-update", id: existingComment.id, body });
  } else if (verdict.state === "answered") {
    if (existingStatus === "failure") {
      actions.push({
        kind: "status",
        state: "success",
        description: "A CI run finished after the cancelled streak",
        targetUrl: verdict.answered.html_url,
      });
    }
    if (existingComment && !existingComment.body.includes(RESOLVED_MARKER)) {
      actions.push({ kind: "comment-update", id: existingComment.id, body: resolvedBody(verdict) });
    }
  }
  return actions;
}

// ---------------------------------------------------------------------------
// GitHub I/O. Everything below talks to the API; everything above is pure.

const REPO = process.env.GITHUB_REPOSITORY ?? "macanderson/oxagen";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

async function api(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** The open pull request the run belongs to, or null. */
async function findPullRequest({ prNumber, headRepo, headBranch }) {
  if (prNumber) {
    const pr = await api(`/repos/${REPO}/pulls/${prNumber}`);
    return pr.state === "open" ? pr : null;
  }
  if (!headRepo || !headBranch) return null;
  const owner = headRepo.split("/")[0];
  const list = await api(
    `/repos/${REPO}/pulls?state=open&head=${encodeURIComponent(`${owner}:${headBranch}`)}&per_page=5`,
  );
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

/**
 * Page the branch's CI runs until the verdict is decided.
 *
 * `get` is the API reader, injected so the test can drive the paging.
 *
 * @param {(path: string) => Promise<any>} get
 * @param {{
 *   repo?: string,
 *   branch: string,
 *   headRepo?: string | null,
 *   since?: string | null,
 *   threshold?: number,
 * }} options
 * @returns {Promise<{ runs: any[], capped: boolean }>}
 */
export async function readRuns(get, { repo = REPO, branch, headRepo, since, threshold = 3 }) {
  const runs = [];
  let capped = false;
  for (let page = 1; ; page++) {
    const res = await get(
      `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&event=pull_request&per_page=${PER_PAGE}&page=${page}`,
    );
    const batch = res.workflow_runs ?? [];
    runs.push(...relevantRuns(batch, { headRepo, since }));
    if (classify(runs, { threshold }).answered) break;
    if (batch.length < PER_PAGE) break;
    // Runs come newest first, so once a page reaches back before the PR was
    // opened, the older pages hold nothing relevantRuns would keep.
    const oldest = batch[batch.length - 1];
    if (since && Date.parse(oldest.created_at) < Date.parse(since)) break;
    if (page >= MAX_PAGES) {
      capped = true;
      break;
    }
  }
  return { runs, capped };
}

async function findComment(prNumber) {
  for (let page = 1; page <= 10; page++) {
    const list = await api(`/repos/${REPO}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    const hit = list.find((c) => typeof c.body === "string" && c.body.startsWith(MARKER));
    if (hit) return hit;
    if (list.length < 100) return null;
  }
  return null;
}

async function currentStatus(sha) {
  const list = await api(`/repos/${REPO}/commits/${sha}/statuses?per_page=100`);
  // Newest first: the first entry for the context is its current state.
  const hit = list.find((s) => s.context === STATUS_CONTEXT);
  return hit ? hit.state : null;
}

async function apply(actions, { prNumber, sha }) {
  for (const action of actions) {
    if (action.kind === "status") {
      await api(`/repos/${REPO}/statuses/${sha}`, {
        method: "POST",
        body: JSON.stringify({
          state: action.state,
          context: STATUS_CONTEXT,
          description: action.description.slice(0, 140),
          ...(action.targetUrl ? { target_url: action.targetUrl } : {}),
        }),
      });
    } else if (action.kind === "comment-create") {
      await api(`/repos/${REPO}/issues/${prNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: action.body }),
      });
    } else if (action.kind === "comment-update") {
      await api(`/repos/${REPO}/issues/comments/${action.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: action.body }),
      });
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
  const threshold = parseThreshold(process.env.CI_SUPERSEDED_THRESHOLD);
  const pr = await findPullRequest({
    prNumber: process.env.PR_NUMBER || null,
    headRepo: process.env.HEAD_REPO || null,
    headBranch: process.env.HEAD_BRANCH || null,
  });
  if (!pr) {
    console.log("[ci-superseded] No open pull request for this run. Nothing to report.");
    return;
  }
  const { runs, capped } = await readRuns(api, {
    branch: pr.head.ref,
    headRepo: pr.head.repo?.full_name,
    since: pr.created_at,
    threshold,
  });
  const verdict = classify(runs, { threshold });
  console.log(
    `[ci-superseded] #${pr.number} ${pr.head.ref}: ${verdict.state}, ${capped ? "at least " : ""}${verdict.streak.length} cancelled in a row, ${runs.length} runs read.`,
  );
  if (verdict.state === "pending") return;

  const existingComment = await findComment(pr.number);
  const existingStatus = await currentStatus(pr.head.sha);
  const actions = plan(verdict, { existingComment, existingStatus, capped, threshold });
  if (dryRun) {
    console.log("[ci-superseded] Dry run. Would write:");
    console.log(JSON.stringify(actions, null, 2));
    return;
  }
  await apply(actions, { prNumber: pr.number, sha: pr.head.sha });
  console.log(`[ci-superseded] Wrote ${actions.length} change(s).`);
}

// Real paths, not `file://${argv[1]}`: node resolves symlinks in the main
// module's URL but not in argv[1], and a false here would exit 0 having
// reported nothing. run-checks.test.ts proves the symlink case.
const isEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    // Fails open, loudly. This check reports; it must never block a merge.
    console.log(`::warning title=ci-superseded did not run::${err.message}`);
    process.exit(0);
  });
}
