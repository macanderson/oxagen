# ADR-147: A merge queue runs the full gate before a PR lands on main

- **Status:** Accepted
- **Date:** 2026-09-23
- **Owners:** platform
- **Decided by:** the maintainer, 2026-09-23, asking for a CI process that
  keeps main from breaking this way again
- **Related:** ADR-046 (per-commit concurrency on main), ADR-110 (lost fixes
  in main integrations), #3653 (whether CI may apply migrations)

## Context

On 2026-09-23 main went red twice with nothing wrong on either side of a
merge.

- #3739 and #3745 both rewrote the block quote in the Context PR body. #3745
  inlined its own version, which left #3739's `blockquote` helper unused.
  Handlers lint failed on main.
- #3732 and #3739 both edited `apps/app/src/features/spend/spend.tsx`. The
  merged file called `ReadFailure`, which it never imported. The Spend test
  failed on main.

Each PR was green on its own run. A PR's run tests the PR merged with the
main it last saw, and only the packages it touches (`--filter=...[origin/main]`).
The full gate runs only after the merge, on main. With twenty or more agents
merging within minutes of each other, the gap between those two runs is where
main breaks. When a run on main fails, every open PR inherits the failure
through its next merge from main, and the deploys stop.

## Decision

`pipeline.yml` runs on `merge_group`. With the merge queue on for `main`, a PR
no longer merges directly. It joins the queue, and GitHub builds the commit
main would become: main, plus every PR queued ahead of it, plus this one. The
full gate runs on that commit, the same unfiltered gate a push to main runs.
A PR lands only when that run passes. A failure removes the PR from the queue
and main never sees it.

- `checks`, `test`, `e2e`, `atlas-validate`, `rls-integration` and
  `rds-compatibility` run on `merge_group`. The turbo filter applies only on
  `pull_request`, so a queue run is unfiltered.
- Deploys and `migration-gate` stay on push to main. A queue run touches no
  production store.
- `dod` does not run on `merge_group`. `dod-check.yml` is pinned by four other
  repositories (`check-dod-stub-parity`), and the definition of done belongs to
  the PR, where it was already judged. Do not mark `dod` as a required check
  for the queue.

## Repository settings this needs

The workflow change does nothing until the maintainer turns the queue on.
Under Settings, Rules, Rulesets, for `main`:

1. Require a pull request before merging.
2. Require status checks to pass: `checks`, `test`, `e2e`, `atlas-validate`,
   `rls-integration`, `rds-compatibility`.
3. Require merge queue. Merge method squash. Build concurrency 5. Group size
   between 1 and 5, so a burst of merges shares one run.

## Consequences

- A semantic collision between two PRs fails in the queue, not on main.
- A merge waits for one full gate, about 40 minutes, instead of landing at
  once. Grouping spreads that cost across up to five PRs.
- A red run on main now means a flake or an outside change, not a collision,
  which makes the red worth reading.

## Rejected

- **Require branches to be up to date before merging.** It closes the same
  gap, but each merge forces every other open PR to merge main and run again.
  With twenty agents that is a rebuild storm and most PRs never catch up.
- **Run the full gate on every PR push.** It costs the full gate on every
  push and still tests against a main that moves before the merge.
