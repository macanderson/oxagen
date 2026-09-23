#!/usr/bin/env node
/**
 * File a P0 issue when main goes red or a production deploy fails, and close
 * it when main recovers.
 *
 * Mac asked for this on 2026-09-23, after main sat red for over an hour on a
 * typecheck break that three PRs then fixed at once. No deploy ran for the
 * whole window, and nothing outside the Actions tab said so. The issue is the
 * record: its count is how often main breaks, and the time from open to close
 * is how long it stays broken. Filter on the `deployment-failure` label.
 *
 * ## One issue per incident, not per run
 *
 * During a merge burst every commit on a red main produces a red run. An issue
 * per run would file a dozen for one break and make the count measure merge
 * rate. So a red run opens an issue only when none is open for the same kind
 * of failure; later red runs comment on it. The first green run closes it.
 *
 * ## The two kinds
 *
 * - `deploy`: a job that writes to production failed, meaning a `deploy …`
 *   job or `migration-gate`. The checks passed and the ship failed.
 * - `main-red`: any other job failed. The commit never reached the deploy.
 *
 * They are separate issues because they have different owners and fixes, and
 * a label per kind (`deployment-failure:deploy`, `deployment-failure:main-red`)
 * lets each be counted on its own.
 *
 * ## What counts as green
 *
 * A run on a superseded commit concludes `success` having run nothing past
 * preflight (check-main-preflight.mjs). That proves nothing, so a run closes
 * a `main-red` issue only if `checks` and `test` both ran and passed, and
 * closes a `deploy` issue only if a deploy job ran and none failed.
 *
 * ## Runs finish out of order
 *
 * An older commit's run can conclude after a newer one. A result is ignored
 * when a newer run on main has already concluded the other way, so a late red
 * run cannot reopen a recovered incident and a late green run cannot close a
 * live one.
 *
 * Invoked by .github/workflows/deployment-failure.yml with RUN_ID set.
 */

const REPO = process.env.GITHUB_REPOSITORY ?? "macanderson/oxagen";
const TOKEN = process.env.GITHUB_TOKEN;
const WORKFLOW = "pipeline.yml";

export const LABEL = "deployment-failure";
export const KIND_LABEL = {
  deploy: "deployment-failure:deploy",
  "main-red": "deployment-failure:main-red",
};
const LABEL_SPECS = {
  [LABEL]: {
    color: "b60205",
    description: "CI filed this: main went red or a production deploy failed",
  },
  [KIND_LABEL.deploy]: {
    color: "d93f0b",
    description: "A deploy or migration-gate job failed on main",
  },
  [KIND_LABEL["main-red"]]: {
    color: "e99695",
    description: "A check failed on main before the deploy",
  },
  P0: { color: "b60205", description: "Priority 0" },
};

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** Jobs that write to production. A failure here is a failed ship. */
export function isDeployJob(name) {
  return (
    /^deploy\b/i.test(name) ||
    name === "Production schema is ready for this commit" ||
    name === "Manual production app deployment"
  );
}

export function failedJobs(jobs) {
  return jobs.filter((j) => FAILED.has(j.conclusion));
}

/**
 * What a concluded run says about main: `deploy`, `main-red`, `green` (the
 * gate ran and passed), or `none` (cancelled, or superseded and skipped, so
 * it says nothing).
 */
export function classifyRun(run, jobs) {
  const failed = failedJobs(jobs);
  if (failed.some((j) => isDeployJob(j.name))) return "deploy";
  if (failed.length > 0 || FAILED.has(run.conclusion)) return "main-red";
  if (run.conclusion !== "success") return "none";
  const passed = (name) =>
    jobs.some((j) => j.name === name && j.conclusion === "success");
  return passed("checks") && passed("test") ? "green" : "none";
}

/** Did this run ship? Closes a `deploy` issue. */
export function deployedCleanly(jobs) {
  const deploys = jobs.filter((j) => isDeployJob(j.name));
  return (
    deploys.some((j) => j.conclusion === "success") &&
    !deploys.some((j) => FAILED.has(j.conclusion))
  );
}

/** The PR a squash-merge commit came from, if its subject names one. */
export function prNumberFrom(message) {
  const m = /\(#(\d+)\)\s*$/m.exec((message ?? "").split("\n")[0]);
  return m ? Number(m[1]) : null;
}

const MARKER = (kind) => `<!-- deployment-failure:kind=${kind} -->`;

export function titleFor(kind, jobs) {
  const names = [...new Set(jobs.map((j) => j.name))];
  const shown =
    names.slice(0, 3).join(", ") +
    (names.length > 3 ? `, +${names.length - 3} more` : "");
  return kind === "deploy"
    ? `P0 · ops/Deploy · Production deploy failed on main: ${shown}`
    : `P0 · ops/CI · main is red: ${shown || "the pipeline failed"}`;
}

function jobLines(jobs) {
  return jobs
    .map((j) => {
      const step = (j.steps ?? []).find((s) => FAILED.has(s.conclusion));
      return `- [${j.name}](${j.html_url}) ${j.conclusion}${step ? ` at step "${step.name}"` : ""}`;
    })
    .join("\n");
}

function commitLine(run) {
  const sha = run.head_sha.slice(0, 7);
  const subject = (run.head_commit?.message ?? "").split("\n")[0];
  const pr = prNumberFrom(run.head_commit?.message);
  return `\`${sha}\` ${subject}${pr ? ` (from #${pr})` : ""}`;
}

export function bodyFor(kind, run, jobs) {
  const what =
    kind === "deploy"
      ? "A job that writes to production failed on `main`. The checks passed, so this commit and every commit after it are merged but not live until a deploy succeeds."
      : "A check failed on `main`. Nothing deploys while `main` is red, including commits merged after this one.";
  return `${MARKER(kind)}
${what}

**Commit:** ${commitLine(run)}
**Run:** ${run.html_url}
**Started:** ${run.run_started_at ?? run.created_at}

## Failed jobs

${jobLines(jobs)}

## What happens next

CI filed this issue (\`.github/workflows/deployment-failure.yml\`). Later failures of the same kind are added here as comments instead of new issues. The first ${kind === "deploy" ? "run that deploys cleanly" : "green run on `main`"} ticks the box below and closes the issue, so the time from open to close is the time to recover.

Record the root cause and the fixing PR in a comment before or after it closes.

## Definition of done

- [ ] ${kind === "deploy" ? "A later run on `main` deploys cleanly" : "A later run on `main` passes `checks` and `test`"} (CI ticks this and closes the issue)
`;
}

export function recoveredBody(body) {
  return body.replace(/^- \[ \] (A later run on `main`)/m, "- [x] $1");
}

function minutesBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 60000);
}

async function api(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 404 && init?.allow404) return null;
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function jobsOf(runId) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await api(
      `/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    out.push(...r.jobs);
    if (r.jobs.length < 100) break;
  }
  return out;
}

async function ensureLabels() {
  for (const [name, spec] of Object.entries(LABEL_SPECS)) {
    const got = await api(`/repos/${REPO}/labels/${encodeURIComponent(name)}`, {
      allow404: true,
    });
    if (!got) {
      await api(`/repos/${REPO}/labels`, {
        method: "POST",
        body: JSON.stringify({ name, ...spec }),
      });
      console.log(`  created label ${name}`);
    }
  }
}

async function openIssues(kind) {
  const list = await api(
    `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100&sort=created&direction=asc`,
  );
  return list.filter(
    (i) => !i.pull_request && (i.body ?? "").includes(MARKER(kind)),
  );
}

/** Has a newer main run already concluded the other way? Then this result is stale. */
async function supersededBy(run, verdict) {
  const recent = await api(
    `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&event=push&status=completed&per_page=15`,
  );
  const newer = recent.workflow_runs.filter(
    (r) => r.id !== run.id && new Date(r.created_at) > new Date(run.created_at),
  );
  for (const r of newer) {
    const other = classifyRun(r, await jobsOf(r.id));
    if (other === "none") continue;
    const redNow = verdict !== "green";
    const redThen = other !== "green";
    if (redNow !== redThen) return r;
  }
  return null;
}

async function comment(number, body) {
  await api(`/repos/${REPO}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

async function recordFailure(kind, run, jobs) {
  const failed = failedJobs(jobs);
  const open = await openIssues(kind);
  if (open.length > 0) {
    const issue = open[0];
    if ((issue.body ?? "").includes(run.html_url))
      return console.log(`  #${issue.number} already names this run`);
    const seen = await api(
      `/repos/${REPO}/issues/${issue.number}/comments?per_page=100`,
    );
    if (seen.some((c) => (c.body ?? "").includes(run.html_url))) {
      return console.log(`  #${issue.number} already names this run`);
    }
    await comment(
      issue.number,
      `Still failing at ${commitLine(run)}.\n\n**Run:** ${run.html_url}\n\n${jobLines(failed)}`,
    );
    return console.log(`  commented on #${issue.number}`);
  }
  await ensureLabels();
  const made = await api(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: titleFor(kind, failed),
      body: bodyFor(kind, run, failed),
      labels: ["P0", LABEL, KIND_LABEL[kind]],
    }),
  });
  console.log(`  filed #${made.number}`);
  // Two runs can fail within seconds of each other and both find no open
  // issue. Keep the oldest and close the rest as its duplicates.
  const after = await openIssues(kind);
  for (const dup of after.slice(1)) {
    await comment(
      dup.number,
      `Duplicate of #${after[0].number}: two runs failed at the same moment.\n\n**Run:** ${run.html_url}`,
    );
    await api(`/repos/${REPO}/issues/${dup.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "duplicate" }),
    });
  }
}

async function recordRecovery(kind, run) {
  for (const issue of await openIssues(kind)) {
    const minutes = minutesBetween(
      issue.created_at,
      run.updated_at ?? new Date().toISOString(),
    );
    await comment(
      issue.number,
      `Recovered at ${commitLine(run)}.\n\n**Run:** ${run.html_url}\n**Time to recover:** ${minutes} minutes from this issue opening.`,
    );
    await api(`/repos/${REPO}/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        body: recoveredBody(issue.body ?? ""),
        state: "closed",
        state_reason: "completed",
      }),
    });
    console.log(`  closed #${issue.number} after ${minutes}m`);
  }
}

async function main() {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error("RUN_ID is required");
  const run = await api(`/repos/${REPO}/actions/runs/${runId}`);
  if (run.event !== "push" || run.head_branch !== "main") {
    return console.log(
      `[deployment-failure] run ${runId} is ${run.event} on ${run.head_branch}, not a push to main`,
    );
  }
  const jobs = await jobsOf(runId);
  const verdict = classifyRun(run, jobs);
  console.log(
    `[deployment-failure] run ${runId} at ${run.head_sha.slice(0, 7)}: ${verdict}`,
  );
  if (verdict === "none") return;

  const newer = await supersededBy(run, verdict);
  if (newer) {
    return console.log(
      `  ignored: newer run ${newer.id} at ${newer.head_sha.slice(0, 7)} already concluded the other way`,
    );
  }

  if (verdict === "green") {
    await recordRecovery("main-red", run);
    if (deployedCleanly(jobs)) await recordRecovery("deploy", run);
    return;
  }
  await recordFailure(verdict, run, jobs);
  // A deploy failure means the checks passed, so main itself is not red.
  if (verdict === "deploy") await recordRecovery("main-red", run);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    // Unlike main-verified, this one fails loudly: a failure alert that
    // silently did not file is the thing Mac asked to stop.
    console.error(
      `[deployment-failure] could not record this run: ${err.message}`,
    );
    process.exit(1);
  });
}
