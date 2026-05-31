# Continuous Integration and Deployment

CI/CD rules for the monorepo. The pipeline is fast, cached, and runs only what a change actually affects. Green CI is a non-negotiable (see `0-prime-directives.md`); these rules keep green cheap to reach.

## Principles

- Run work once. A given commit is validated on PR; it is not re-validated on merge. No suite runs twice for the same code.
- Run only what changed. A PR builds and tests the affected packages and their dependents, never the whole graph.
- Cache aggressively. Turborepo remote caching plus dependency caching mean unchanged work is restored, not recomputed.
- The merge to `main` is the deploy event. Production deploys happen on merge, gated by the checks that already passed on the PR.

## Trigger Model

Two events, two distinct jobs, no overlap:

- **On PR open and update (push to the PR branch):** run lint, type check, unit tests, e2e tests, and affected builds. This is the full quality gate. Everything that can fail a change fails here.
- **On merge to `main`:** deploy to production. Do **not** re-run the test suite. The exact commit was already validated on the PR; rerunning is wasted time and money. Merge is allowed only when the PR checks are green, so the deploy job trusts that result and ships.

If a fast post-merge sanity signal is ever wanted, it is a smoke check against the deployed environment, never a re-run of the unit or e2e suites.

## Affected-Only Execution

- Use Turborepo's affected detection (`turbo run ... --filter=...[<base>]`) to compute the set of packages touched by the PR relative to its merge base, plus everything that depends on them.
- Lint, type check, test, and build run only over that affected set. An untouched package is neither rebuilt nor retested.
- A change to a shared package correctly fans out to its dependents; a change isolated to one app does not drag in unrelated services.
- Migrations and their gates (per migration patterns) run only when the PR touches schema or migration files.

## Caching

- **Turborepo remote cache** is enabled for all `build`, `lint`, `type-check`, and `test` tasks. Task outputs are keyed by input hash, so identical inputs restore from cache instead of re-executing.
- **Dependency caches** are keyed by lockfile hash: pnpm store keyed by `pnpm-lock.yaml`, uv cache keyed by `uv.lock`. Because versions are pinned (see prime directives), these caches are stable and hit reliably.
- Cache restore happens before any task runs; cache save happens after success. A cache miss degrades gracefully to a full run, never a failure.
- Never cache across a dependency change silently. The lockfile hash is part of the key, so a version bump invalidates exactly the affected caches and nothing more.

## Deployment

- Vercel is the host (see vendor and observability policies). Apps deploy on merge to `main`.
- Production deploys are driven from the `main` merge commit only. Feature branches may produce Vercel preview deployments for review, which are not production and run no production migrations.
- Schema migrations run as a gated step in the deploy, following the expand-then-contract pattern; a migration failure aborts the deploy before traffic shifts.
- Rollback is a deploy of the prior known-good `main` commit, fast because its artifacts are already cached.

## Required Checks

- The PR cannot merge until lint, type check, unit tests, e2e tests, and affected builds are all green with zero warnings and zero errors.
- Branch protection on `main` enforces this. There is no merge-on-red and no skipping suites.
- The deploy job requires those checks as passed status; it never re-derives them.
