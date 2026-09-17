#!/usr/bin/env node
/**
 * Has anything actually verified the recent commits on `main`?
 *
 * This is a different question from "is main red", and every other signal here
 * reads the absence of an answer as a pass. `pipeline.yml` reports pass or fail
 * on a commit that gets a run; it says nothing about a commit that never got
 * one. On 2026-09-07 merges outpaced the run and each evicted the one queued
 * behind it, so eight commits reached `main` with no run at all — and because an
 * evicted run concludes `cancelled`, nothing anywhere went red (#2730).
 *
 * ADR-046 removed that cause by giving each push to `main` its own concurrency
 * group. This catches the next cause, whatever it turns out to be: an Actions
 * outage, a push that raised no event, a workflow that failed to start.
 *
 * ## Three run states, not two
 *
 * A run that is still going is not an answer either, and counting one as an
 * answer is how a stuck window reports "every commit is verified" over commits
 * with no completed run. So:
 *
 *   verified    every commit in the window has a concluded run
 *   pending     some do not yet, and their runs are still in flight
 *   unverified  some have no run at all, or only cancelled ones
 *
 * Two later passes can resolve a `none` before it reaches the verdict:
 * `too_young` (the grace window below) and `superseded` (further below).
 *
 * `pending` exits 0 and closes nothing. A recovery is claimed off an answer,
 * never off the absence of one.
 *
 * ## Supersession — why a commit can stop being the finding
 *
 * A run is never created for a commit retroactively. So a commit that missed
 * its run stays missing it forever, and a guard that reports every such commit
 * reports the same one on every push and every scheduled tick until it falls
 * out of the window. That happened: #3125 re-posted `d3e5ebef` seven times
 * across two days while four later commits on `main` concluded `success`. An
 * alert that is permanently true is the shape that teaches people to scroll
 * past it, which costs exactly the signal #2730 exists to raise.
 *
 * The question this guard asks is whether `main` is flying blind — not whether
 * every commit in history has its own receipt. Once a *later* commit on `main`
 * concludes a run, the pipeline demonstrably ran and deployed past that point,
 * and the blindness ended. The earlier gap is then history that nothing can
 * answer, so it becomes:
 *
 *   superseded  no run of its own, but a strictly later `main` commit concluded
 *
 * `superseded` is still printed on every invocation — the gap is real and
 * hiding it entirely would be its own blindness — but it does not drive the
 * verdict and does not file or comment.
 *
 * HEAD can never be superseded: nothing is later than it. That is deliberate,
 * and it is what keeps the live case detectable. During the #2730 window HEAD
 * itself had no concluded run on every tick, so the guard still fires while the
 * incident is happening, which is when firing is worth anything.
 *
 * ## The grace window — a commit too young to judge
 *
 * This workflow triggers on the same push as `pipeline.yml`, so it races the
 * registration of the very run it is looking for. "No run in the API" and "no
 * run will ever exist" are the same shape and different facts, and the first
 * one is ordinary for a few seconds after a push.
 *
 * Measured on #3125: commit `78396892` was committed at 05:47:32Z, its run was
 * created at 05:47:35Z, and the guard filed `no run at all` at 05:47:39Z — four
 * seconds after the run it could not see already existed. The run was `queued`,
 * which `classifyRuns` calls `in_flight` and which announces nothing, so the
 * alert was purely a read-after-write race.
 *
 * A commit younger than `GRACE_MS` therefore resolves to `too_young` rather
 * than `none`. It folds into `pending`, which is the state that already means
 * "no answer yet, conclude nothing, close nothing". Past the grace the commit
 * is judged normally, so a genuine gap still alerts — later by the grace, and
 * that is the whole cost.
 *
 * ## It fails open, always
 *
 * An unreadable API, a missing token, an unexpected shape — all exit 0 saying
 * what went unasked. This must never be the thing blocking a repair, and a check
 * that did not run must not read as a check that found nothing.
 */

const REPO = process.env.GITHUB_REPOSITORY ?? "macanderson/oxagen";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const WINDOW = Number(process.env.MAIN_VERIFIED_WINDOW ?? 10);
/**
 * How long after a commit lands the guard refuses to conclude it has no run.
 *
 * Ten minutes rather than one: the observed race was seconds, but a queued
 * Actions backlog and an API that has not caught up both widen it, and the only
 * cost of a generous grace is that a real gap alerts that much later. A grace
 * too short is a false alert, which is the failure this guard cannot afford.
 */
const GRACE_MS =
  Number(process.env.MAIN_VERIFIED_GRACE_MINUTES ?? 10) * 60 * 1000;
const LABEL = "main-unverified";
const WORKFLOW = "pipeline.yml";

const announce = process.argv.includes("--announce");

async function api(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Classify one commit: `concluded`, `in_flight`, or `none`.
 *
 * A `cancelled` run is deliberately NOT a conclusion. Cancellation is exactly
 * what the incident produced, so counting it would make the guard blind to the
 * thing it exists for.
 */
export function classifyRuns(runs) {
  if (!runs || runs.length === 0) return "none";
  const real = runs.filter((r) => r.conclusion && r.conclusion !== "cancelled");
  if (real.length > 0) return "concluded";
  if (runs.some((r) => r.status !== "completed")) return "in_flight";
  return "none";
}

/**
 * Rewrite `none` to `too_young` for a commit that landed within the grace.
 *
 * `ageMs` is the commit's age at the moment the window was read. A commit with
 * no `ageMs` is left alone: an unknown age is not a young age, and guessing
 * would silence the guard on exactly the commits it could not date.
 *
 * Only `none` is rewritten. A commit whose run is already visible has an
 * answer coming and needs no grace.
 */
export function applyGrace(states, graceMs) {
  return states.map((s) =>
    s.state === "none" && typeof s.ageMs === "number" && s.ageMs < graceMs
      ? { ...s, state: "too_young" }
      : s,
  );
}

/**
 * Rewrite `none` to `superseded` for any commit a later `main` commit answered.
 *
 * `states` arrives newest-first, the order the commits API returns. "Later"
 * therefore means a LOWER index, and index 0 — HEAD — can never be superseded,
 * because nothing is later than it. Pure, and it does not mutate its argument.
 *
 * Only a `concluded` run supersedes. An `in_flight` one is not an answer yet
 * (the same reason `pending` closes nothing), and a `superseded` one never
 * carried an answer of its own to pass down.
 */
export function applySupersession(states) {
  let answered = false;
  return states.map((s) => {
    const next =
      answered && s.state === "none" ? { ...s, state: "superseded" } : s;
    if (s.state === "concluded") answered = true;
    return next;
  });
}

/**
 * Fold per-commit states into the overall verdict.
 *
 * `superseded` is deliberately inert here: it is a gap nothing can ever fill,
 * so letting it reach `unverified` would pin the verdict open forever.
 *
 * `too_young` folds into `pending` rather than into `verified`: the commit has
 * no answer yet, and `pending` is precisely the state that neither announces
 * nor closes.
 */
export function verdictOf(states) {
  if (states.some((s) => s.state === "none")) return "unverified";
  if (states.some((s) => s.state === "in_flight" || s.state === "too_young"))
    return "pending";
  return "verified";
}

async function openIssue() {
  const found = await api(
    `/repos/${REPO}/issues?state=open&labels=${LABEL}&per_page=1`,
  );
  return Array.isArray(found) && found.length > 0 ? found[0] : null;
}

async function main() {
  const commits = await api(
    `/repos/${REPO}/commits?sha=main&per_page=${WINDOW}`,
  );
  // One clock for the whole window. Reading `Date.now()` per commit would date
  // each one against a different instant, and the grace boundary is exactly
  // where that difference decides whether the guard speaks.
  const now = Date.now();
  const states = [];
  for (const c of commits) {
    const runs = await api(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${c.sha}&per_page=20`,
    );
    const committed = Date.parse(
      c.commit?.committer?.date ?? c.commit?.author?.date ?? "",
    );
    states.push({
      sha: c.sha.slice(0, 8),
      state: classifyRuns(runs.workflow_runs),
      // `undefined` when the API gave no parseable date, which `applyGrace`
      // treats as "not young" rather than guessing.
      ageMs: Number.isNaN(committed) ? undefined : now - committed,
    });
  }

  const judged = applySupersession(applyGrace(states, GRACE_MS));
  const verdict = verdictOf(judged);
  const unverified = judged.filter((s) => s.state === "none").map((s) => s.sha);
  const inFlight = judged
    .filter((s) => s.state === "in_flight")
    .map((s) => s.sha);
  const superseded = judged
    .filter((s) => s.state === "superseded")
    .map((s) => s.sha);
  const tooYoung = judged
    .filter((s) => s.state === "too_young")
    .map((s) => s.sha);

  console.log(`[main-verified] window=${judged.length} verdict=${verdict}`);
  if (inFlight.length > 0)
    console.log(`  still running: ${inFlight.join(", ")}`);
  if (unverified.length > 0)
    console.log(`  NO run at all: ${unverified.join(", ")}`);
  // Named separately from `still running` because the cause is different: no
  // run is visible yet at all, and it is too soon to call that an absence.
  if (tooYoung.length > 0)
    console.log(
      `  no run visible yet, within the ${GRACE_MS / 60000}m grace: ${tooYoung.join(", ")}`,
    );
  // Printed every time, never announced. The gap is real and permanent; what
  // changed is that a later commit answered the question it was asked about.
  if (superseded.length > 0)
    console.log(
      `  no run, answered by a later commit: ${superseded.join(", ")}`,
    );

  if (!announce) return;

  const existing = await openIssue();
  if (verdict === "unverified") {
    const body =
      `Commits on \`main\` with no concluded \`${WORKFLOW}\` run:\n\n` +
      unverified.map((s) => `- \`${s}\``).join("\n") +
      `\n\nA cancelled run does not count — cancellation is what #2730 produced, ` +
      `so counting it would blind this to the case it exists for.\n\n` +
      `This says nothing about whether \`main\` is broken. It says nothing has ` +
      `answered the question.`;
    if (existing) {
      await api(`/repos/${REPO}/issues/${existing.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      console.log(`  commented on #${existing.number}`);
    } else {
      const made = await api(`/repos/${REPO}/issues`, {
        method: "POST",
        body: JSON.stringify({
          title: "main has commits nothing verified",
          body,
          labels: [LABEL],
        }),
      });
      console.log(`  filed #${made.number}`);
    }
    return;
  }

  // Only a real answer closes it. `pending` leaves it open.
  if (verdict === "verified" && existing) {
    await api(`/repos/${REPO}/issues/${existing.number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
    console.log(`  closed #${existing.number}`);
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err) => {
    // Fails open, loudly. A check that could not run must not read as one that
    // found nothing, and must never be what blocks a repair.
    console.log(
      `[main-verified] UNAVAILABLE — THIS CHECK DID NOT RUN: ${err.message}`,
    );
    process.exit(0);
  });
}
