# ADR-207: CI runs its own turbo cache on S3

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** ci
- **Related:** issue #4233 (Vercel's cache answers 402), issue #4463 and PR
  #4464 (the parallel build and unit lanes), ADR-046 (CI concurrency).

## Context

Turbo's remote cache was Vercel's hosted cache, reached with the
`TURBO_TOKEN` and `TURBO_TEAM` repository secrets. From 2026-09-25 every
request to it answered 402. Turbo reads that as a warning, so every job kept
passing while it ran every task cold. The whole-repo gate took 40 minutes on
one runner (run 36283641852). #4464 split that job into parallel lanes, which
cut the wall clock but still rebuilt and retested every package on every run.

Turbo talks to a remote cache over an HTTP API (`/v8/artifacts`), not over
S3. Pointing it at a bucket takes a server that speaks that API.

## Decision

1. **Cache entries live in S3 in the production account.** The bucket is
   `oxagen-turbo-cache-916294258235` in `us-east-1`, defined in
   `infra/stacks-new/ci-deploy/turbo-cache.tf`. It blocks public access,
   encrypts with SSE-S3, expires entries after 14 days, and aborts incomplete
   multipart uploads after 1 day. A missing entry costs one rebuild.
2. **Each job starts its own cache server on loopback.**
   `.github/actions/turbo-cache` installs `turborepo-remote-cache` 2.14.1 from
   a committed lockfile, with install scripts off and outside the checkout,
   and runs it on `127.0.0.1`. No server runs between jobs, so there is
   nothing to patch, nothing on the internet, and no cost while CI is idle.
3. **The job reaches the bucket through GitHub OIDC.** It assumes
   `gha-turbo-cache`, which any job in `macanderson/oxagen` can assume and
   which can read and write this bucket and nothing else. A fork's pull
   request gets no OIDC token. The credentials go to the server process only.
   The action exports no `AWS_*` variable, so tests and builds never see them.
4. **The cache fails open.** The action sets `TURBO_API`, `TURBO_TOKEN`, and
   `TURBO_TEAM` only after it writes a test entry and reads the same bytes
   back. On any failure it logs a `Turbo remote cache off` warning and turbo
   uses its local cache. The workflow-level `TURBO_TOKEN` and `TURBO_TEAM`
   secrets are gone, so a job without the action has no remote cache at all
   and cannot fall back to Vercel.
5. **Gate jobs read the cache and deploy jobs do not.** `checks`, `build`,
   `unit`, and `e2e` in `pipeline.yml`, and `full` and `e2e` in
   `nightly.yml`, start the action. `deploy-web`, `deploy-node`,
   `manual-app-deploy`, and `rls-integration` do not, so nothing that ships to
   production is restored from this cache.
6. **Uploads get 300 seconds.** `turbo.json` sets `remoteCache.timeout` to 60
   and `uploadTimeout` to 300, and the server accepts bodies up to 1 GiB,
   because a Next.js build output runs to hundreds of megabytes.

## Consequences

- **A hit replays a test without running it.** `test:coverage` and
  `test:e2e` are cached tasks. When a package's inputs match an entry, turbo
  restores the logs and outputs and reports the task as passed. This is how
  the gate behaved before the 402s. It also means a flaky test that passed
  once for a given input hash stays passed until the inputs change. A run
  that must execute everything passes `--force`.
- **Any branch can write an entry main later restores.** A writer to this
  repository could compute the hash main will ask for and store a forged
  result under it, so main's gate would report a check that never ran. The
  blast radius is the gate's verdict, not a deploy, because deploy jobs never
  read the cache (decision 5). Anyone who can push a branch here can already
  open and merge a pull request. The hardening, if that changes, is a second
  role that only `refs/heads/main` can assume for writes, with every other job
  set to `TURBO_CACHE=local:rw,remote:r`.
- **Credentials last one hour.** The role's maximum session is 3600 seconds.
  A job still running after that loses its late uploads, turbo warns, and the
  job carries on. Today only the nightly jobs run that long.
- **Egress is the cost that grows.** GitHub's hosted runners are outside AWS,
  so every restore leaves AWS as internet data transfer, billed per gigabyte
  after the account's first 100 GB each month. Storage stays small because
  entries expire after 14 days. Read the bucket's line in Cost Explorer after
  the first full week before deciding whether a runner inside AWS would pay
  for itself.
- **The stack is applied by hand until this merges.** `infra.yml` applies
  `ci-deploy` from `main`, and `main` had no `turbo-cache.tf` when this was
  applied. A `main` run that plans `ci-deploy` before this merges would try
  to destroy the bucket and the role. The cache fails open if that happens.
