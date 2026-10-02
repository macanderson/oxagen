#!/usr/bin/env node
/**
 * Rerun a CI job whose runner went away mid-job.
 *
 * CI runs on EC2 spot instances (ADR-246). AWS can take a spot instance back
 * at any time, and the job running on it fails with "The runner has received
 * a shutdown signal". ADR-246 expected about one such loss in 40,000 jobs. In
 * the 17 hours after the move, the termination watcher counted 63 on the large
 * x64 pool alone. On `main` a loss turned the branch red and filed a P0
 * (#5180). On a pull request it left a red check for the PR's watcher to
 * rerun by hand.
 *
 * ## What counts as a lost runner
 *
 * A failed job whose last `##[error]` log line is the runner's shutdown or
 * lost-communication message, or whose check run carries that message as an
 * annotation. The job API cannot tell: the step that was running can read
 * `success`, and the job has no annotation for a spot reclaim. Only the
 * last error line counts, so a test that prints the phrase and then fails on
 * its own is not mistaken for a loss. A trailing "The operation was
 * canceled." is skipped, because GitHub logs it after the shutdown message.
 *
 * ## What gets rerun
 *
 * The lost jobs and the jobs that depend on them, not the whole run. A job
 * that failed because a lost job never finished (the `test` aggregator after
 * a lost `unit` lane) reruns as a dependent. With one lost job, a job that
 * failed on its own keeps its failure, so a draft pull request's deliberate
 * `test` failure is not retried for nothing. Several lost jobs use "rerun
 * failed jobs", which retries every failed job, because GitHub refuses a
 * second per-job rerun while the first attempt is running.
 *
 * ## Limits
 *
 * - At most two automatic reruns per run (MAX_RUN_ATTEMPT). A third loss in a
 *   row points at the runner pool, not at bad luck, and stays red for a person.
 * - On a pull request, only the run on the branch's current head. A newer
 *   commit's run is the one that matters there.
 * - On the default branch, every run. Large-pool jobs can wait 30 to 50
 *   minutes for a runner, so by the time a lost job's run ends, `main` has
 *   usually moved on (it had in #5180). The rerun is what closes the P0, and
 *   check-deploy-tip.mjs keeps an older commit from deploying backwards.
 *
 * Invoked by .github/workflows/rerun-lost-runner.yml with RERUN_RUN_ID set.
 */
import { appendFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY ?? "oxageninc/product";
const TOKEN = process.env.GITHUB_TOKEN;

/** No automatic rerun after this attempt. Attempts 2 and 3 are reruns. */
export const MAX_RUN_ATTEMPT = 3;

const LOSS_MESSAGES = [
  /The runner has received a shutdown signal/,
  /lost communication with the server/,
];

/** Is this text the runner's own message that it stopped mid-job? */
export function isRunnerLossMessage(text) {
  return LOSS_MESSAGES.some((re) => re.test(text ?? ""));
}

// GitHub often logs this right after the shutdown message, as the steps
// still running are stopped. It says nothing about why the job ended.
const CANCEL_ECHO = /##\[error\]The operation was canceled\.\s*$/;

/**
 * The last `##[error]` line of a job log that says why the job ended, or
 * null. A trailing "The operation was canceled." is skipped: 3 of the 10
 * lost runners on 2026-10-02 logged it after the shutdown message.
 */
export function lastErrorLine(log) {
  const lines = (log ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("##[error]") && !CANCEL_ECHO.test(lines[i])) {
      return lines[i];
    }
  }
  return null;
}

/** Did this job fail because its runner went away? */
export function lostRunner({ log, annotations = [] }) {
  if (isRunnerLossMessage(lastErrorLine(log))) return true;
  return annotations.some(
    (a) => a.annotation_level === "failure" && isRunnerLossMessage(a.message),
  );
}

/**
 * What to do with a concluded CI run.
 *
 * `run` is the workflow run, `branchHead` the SHA its branch points at now
 * (null when the branch is gone), `defaultBranch` the repository's default
 * branch, and `lost` the failed jobs that lost their runner. Returns
 * `{ action, reason }`, where action is `none`, `job` (rerun `jobId` and its
 * dependents) or `failed-jobs`.
 */
export function decide({ run, branchHead, defaultBranch = "main", lost }) {
  if (run.conclusion !== "failure") {
    return { action: "none", reason: `the run concluded ${run.conclusion}` };
  }
  if (lost.length === 0) {
    return { action: "none", reason: "no failed job lost its runner" };
  }
  const names = lost.map((j) => j.name).join(", ");
  if ((run.run_attempt ?? 1) >= MAX_RUN_ATTEMPT) {
    return {
      action: "none",
      reason: `${names} lost its runner on attempt ${run.run_attempt}, and ${MAX_RUN_ATTEMPT} is the limit`,
    };
  }
  const onDefaultBranch =
    run.event === "push" && run.head_branch === defaultBranch;
  if (!onDefaultBranch && branchHead !== run.head_sha) {
    return {
      action: "none",
      reason: `${names} lost its runner, but ${run.head_branch} has moved past ${run.head_sha.slice(0, 7)}`,
    };
  }
  if (lost.length === 1) {
    return {
      action: "job",
      jobId: lost[0].id,
      reason: `${names} lost its runner`,
    };
  }
  return { action: "failed-jobs", reason: `${names} lost their runners` };
}

async function api(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 404 && init?.allow404) return null;
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.status === 201 || res.status === 204 ? null : res.json();
}

/**
 * A job's log as text. The API answers with a redirect to signed blob
 * storage. Follow it without the token, which that host neither needs nor
 * should see. Null when the log is gone.
 */
async function jobLog(jobId) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`,
    {
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${TOKEN}`,
      },
    },
  );
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    const blob = await fetch(location);
    return blob.ok ? blob.text() : null;
  }
  return res.ok ? res.text() : null;
}

/**
 * Did this failed job lose its runner? Reads the job's log and annotations.
 * A read that fails answers false, so a caller that files or reruns falls
 * back to treating the job as an ordinary failure.
 */
export async function jobLostRunner(jobId) {
  const [log, annotations] = await Promise.all([
    jobLog(jobId).catch(() => null),
    api(`/repos/${REPO}/check-runs/${jobId}/annotations?per_page=50`).catch(
      () => [],
    ),
  ]);
  return lostRunner({ log, annotations: annotations ?? [] });
}

/** The failed jobs of a run that lost their runner, each with id and name. */
export async function lostJobs(runId) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await api(
      `/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    for (const job of r.jobs.filter((j) => j.conclusion === "failure")) {
      if (await jobLostRunner(job.id)) out.push({ id: job.id, name: job.name });
    }
    if (r.jobs.length < 100) break;
  }
  return out;
}

async function main() {
  const runId = process.env.RERUN_RUN_ID;
  if (!runId) throw new Error("RERUN_RUN_ID is required");
  if (!TOKEN) throw new Error("GITHUB_TOKEN is required");
  const run = await api(`/repos/${REPO}/actions/runs/${runId}`);
  const lost = run.conclusion === "failure" ? await lostJobs(runId) : [];
  const branch = await api(
    `/repos/${REPO}/branches/${encodeURIComponent(run.head_branch)}`,
    { allow404: true },
  );
  const branchHead = branch?.commit?.sha ?? null;
  const defaultBranch = process.env.DEFAULT_BRANCH || "main";
  const verdict = decide({ run, branchHead, defaultBranch, lost });

  if (verdict.action === "job") {
    await api(`/repos/${REPO}/actions/jobs/${verdict.jobId}/rerun`, {
      method: "POST",
    });
  } else if (verdict.action === "failed-jobs") {
    await api(`/repos/${REPO}/actions/runs/${runId}/rerun-failed-jobs`, {
      method: "POST",
    });
  }
  const line =
    verdict.action === "none"
      ? `No rerun of run ${runId} attempt ${run.run_attempt}: ${verdict.reason}.`
      : `Reran run ${runId} after attempt ${run.run_attempt}: ${verdict.reason}.`;
  console.log(`[rerun-lost-runner] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(`[rerun-lost-runner] ${err.message}`);
    process.exit(1);
  });
}
