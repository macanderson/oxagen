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
 * ## Three states, not two
 *
 * A run that is still going is not an answer either, and counting one as an
 * answer is how a stuck window reports "every commit is verified" over commits
 * with no completed run. So:
 *
 *   verified    every commit in the window has a concluded run
 *   pending     some do not yet, and their runs are still in flight
 *   unverified  some have no run at all, or only cancelled ones
 *
 * `pending` exits 0 and closes nothing. A recovery is claimed off an answer,
 * never off the absence of one.
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

/** Fold per-commit states into the overall verdict. */
export function verdictOf(states) {
  if (states.some((s) => s.state === "none")) return "unverified";
  if (states.some((s) => s.state === "in_flight")) return "pending";
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
  const states = [];
  for (const c of commits) {
    const runs = await api(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?head_sha=${c.sha}&per_page=20`,
    );
    states.push({
      sha: c.sha.slice(0, 8),
      state: classifyRuns(runs.workflow_runs),
    });
  }

  const verdict = verdictOf(states);
  const unverified = states.filter((s) => s.state === "none").map((s) => s.sha);
  const inFlight = states
    .filter((s) => s.state === "in_flight")
    .map((s) => s.sha);

  console.log(`[main-verified] window=${states.length} verdict=${verdict}`);
  if (inFlight.length > 0)
    console.log(`  still running: ${inFlight.join(", ")}`);
  if (unverified.length > 0)
    console.log(`  NO run at all: ${unverified.join(", ")}`);

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
