# ADR-218: A pull request whose CI runs keep getting cancelled is reported

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** ci
- **Decided under:** SCR-002. Issue #3257 listed three options and chose none.
- **Related:** issue #3257, ADR-046 (per-commit CI concurrency on main),
  ADR-147 (the merge queue), issue #3686 (the `main` ruleset's bypass actor),
  `.github/workflows/ci-superseded.yml`, `tools/scripts/check-superseded-runs.mjs`

## Context

`pipeline.yml` groups a pull request's runs by branch and cancels the run in
progress when a new push arrives (ADR-046). The ruleset on `main` requires
`checks` and `test`. A `cancelled` conclusion on a required check is not a
pass.

Together those two rules trap a branch pushed faster than CI finishes. Every
run is cancelled before it reports, so the required checks never conclude,
and nothing goes red. A cancelled run looks the same as the ordinary cleanup
after one supersede.

On 2026-09-18 PR #3233's branch had nine CI runs in 100 minutes: eight
cancelled, one in progress, none finished. Pushes came every 9 to 12 minutes
against a run that needed longer. Its unrelated, non-required `dod` check was
red and hid the real blocker from the session reading it.

Issue #3257 named three ways out:

1. Detect and report the state.
2. Protect a pull request run that has started, as `main` already is.
3. Require the run only at merge time, through a merge queue.

## Decision

**Option 1. A detector reports a pull request whose last 3 concluded CI runs
were all cancelled.**

`.github/workflows/ci-superseded.yml` runs after every CI run on a pull
request completes. `tools/scripts/check-superseded-runs.mjs` reads the
branch's CI runs, newest first, and skips runs still queued or in progress.
Each `cancelled` run extends a streak. The first run that concluded any other
way ends it, because that run reported something a person can see.

- **Superseded:** the streak reached 3. The script sets a failing
  `ci-superseded` commit status on the pull request's head and posts one
  comment, edited in place on later runs.
- **Answered:** a run concluded before the streak reached 3. If an earlier
  report exists, the status turns to success and the comment says the streak
  ended. Otherwise nothing is written.
- **Pending:** no run has concluded and the streak is short. Nothing is
  written. This is how "not finished yet" stays apart from "keeps getting
  superseded".

One supersede followed by a finished run is answered and reports nothing.
The status is not a required check, so the detector never blocks a merge. The
script fails open: an unreadable API prints a warning and exits 0.

The script pages the run history until a run answered, the history ends, or
5 pages of 100 are read. A short page and no runs read the same, so a
single page is not enough. It drops runs from a fork's branch of the same
name and runs from before the pull request opened, which covers the runs
`cancel-closed-pr-runs.yml` cancels when an earlier pull request on a reused
branch closed.

## Why not the other two

**Option 2** makes every pull request pay for runs nobody needs. A branch
under active work would hold one runner per push until each run finished,
where today a push frees the runner of the run it replaces. ADR-046 pays that
cost on `main` because `main` deploys. A pull request does not deploy, and
the runner pool is already the resource the `main` deploy waits on
(`cancel-closed-pr-runs.yml` exists for that reason).

**Option 3** is ADR-147's merge queue, accepted on 2026-09-23. It removes the
trap: the required checks run on the `merge_group` commit at merge time, so
runs cancelled while the branch is still being pushed stop mattering. It does nothing until the ruleset on `main` turns the queue on,
and #3686 records that the ruleset still carries an actor with
`bypass_mode: always`, so a pull request can merge before its checks report.
That is a maintainer decision this record cannot make. The detector does not
conflict with the queue and stays useful once the queue is on, because a pull
request still needs its own finished run for review.

## What it costs

- One job of about 20 seconds after each CI run on a pull request, including
  successful runs, since a finished run is what clears a report.
- One comment per pull request that reaches the streak, edited in place.
- The report arrives after the third cancelled run, not the first. A lower
  threshold would fire on ordinary back-to-back pushes.
- Live proof waits for the merge. `workflow_run` runs the copy of the
  workflow on the default branch, so the workflow cannot run from this
  branch. The unit tests rebuild #3233's three cancelled runs and a
  one-cancel-then-green branch.

## Consequences

- ADR-046 now states that `cancelled` on a required check is not a pass, next
  to its note that cancelled runs look like ordinary cleanup.
- The repository variable `CI_SUPERSEDED_THRESHOLD` changes the streak
  length without a code change. It must be a whole number of at least 2.
  Anything else, including unset, reads as 3, because 1 would fire on a
  single supersede.
- `pipeline.yml`'s `name: CI` is what `workflow_run` matches. The test in
  `check-superseded-runs.test.ts` fails if that name changes.
- Not customer-facing. No published documentation changes.
