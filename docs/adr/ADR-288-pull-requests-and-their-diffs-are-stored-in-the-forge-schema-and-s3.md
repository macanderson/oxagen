# ADR-288: Pull requests and their diffs are stored in the forge schema and S3

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** repositories, runs, work
- **Related:** issue #5264, issue #5259, ADR-192 (pull request state per run),
  ADR-002 (no BullMQ), ADR-042 (data planes), ADR-251 (work order results),
  `packages/database/src/schema/forge.ts`,
  `packages/handlers/src/lib/forge-pull-requests/`,
  `packages/inngest-functions/src/functions/forge.pull-request-sync.ts`.

## Context

A run opens pull requests, and a work order is done when its pull request is
accepted and merged. A check that judges a run's work has to read what the
run changed. Before this decision, Oxagen kept none of it in a form a check
could cite:

1. **No diff was stored.** `get_pr_diff` read GitHub live. A force-push
   erased the bytes a run produced, and two reads of "the diff" could return
   different bytes.
2. **Each link had its own store.** `tacho.run_pull_requests` (ADR-192) keys a
   link on a session and a URL and holds the state alone. A work order holds
   its pull request as a `pr_linked` fact, and its projection keeps one per
   order. `cost.run_pr_outcomes` is a derived index over 30 days. Nothing let
   one pull request carry two runs and two work orders.
3. **State depended on one read.** Only the link-time read created a
   `tacho.run_pull_requests` row, and webhooks only updated rows that already
   existed. A failed read left "status unknown" for good.

## Decision

### Store

A Postgres schema of its own, `forge`, because a pull request is shared by
runs, work, and cost and none of those domains owns it. Four tables, each with
the org mixin and the standard tenant policy:

| Table | One row per | Key |
|---|---|---|
| `forge.pull_requests` | workspace and pull request | `(org, workspace, provider, host, provider_repository_id, number)` |
| `forge.pull_request_revisions` | head commit | `(pull_request_id, head_sha)` |
| `forge.pull_request_runs` | pull request and run | `(pull_request_id, run_id)` |
| `forge.pull_request_work_orders` | pull request and work order | `(pull_request_id, work_order_id)` |

- **The repository id is the key, not the path.** GitHub's repository id and
  GitLab's project id survive a rename. The lower-cased path is kept beside it
  for matching a recorded URL.
- **A row is per workspace.** The standard tenant policy judges a write by
  the scope's workspace, as ADR-192 found. Two workspaces connected to one
  repository each hold their own row.
- **A revision is keyed on its head alone.** The base branch's tip moves on
  every delivery, while the diff from the merge base stays the same. The base
  and the merge base are columns on the row.
- **A stored revision is final.** The writer replaces a revision only while
  it names no stored bytes, and `oxagen_app` cannot delete one.
- **A run is named by its public id** (`arun_` or `tse_`), the form the cost
  tables use for both kinds of run. A work order is named by `work.orders.id`,
  with no foreign key across the schema boundary.

### Bytes

Diffs go to one private S3 bucket of their own (`PR_DIFF_BUCKET`), through
`@oxagen/storage/s3`. They are customer source code, so they never pass
through the blob driver, which can be public.

- **The key is tenant first and head last:**
  `pr-diffs/<org>/<workspace>/<provider>/<repository id>/<number>/<head sha>.diff`.
  It never names two different diffs, so every put is write-once
  (`If-None-Match: *`), and a 412 means the same bytes are there.
- **The bytes are the forge's own,** read by commit id from the three-dot
  compare (`base...head`), never as "the pull request's current diff". A push
  that lands mid-capture cannot put another head's bytes under this key.
- **The sha256 is checked by S3.** Each put names the digest of the bytes it
  sends, and S3 refuses bytes that differ, so the revision's digest is the
  digest of the object a reader gets back.
- **A diff over 32 MiB, or one the forge refuses to render,** is recorded as
  `too_large` with its file list. A deployment with no bucket records
  `unconfigured`, and a later delivery fills that revision once a bucket
  exists.

### Pipeline

One Inngest function, `forge/pull-request-sync`, runs on
`forge/pull-request.observed`:

1. **Upsert the pull request and its links.** A GitHub delivery's facts come
   from the payload, so a delivery costs no GitHub read. A run's link and a
   GitLab delivery carry no facts, and the step reads the forge once.
2. **Capture the diff,** only when the head has no stored revision, and put
   the bytes in S3.
3. **Record the revision.**
4. **Send `forge/pull-request-diff.ready`,** with the id
   `forge-diff-ready:<revision id>`.

Each step retries alone, so a failed database write never reads the forge
again or puts the diff again. The diff never passes through step output,
which Inngest caps. One run per pull request runs at a time
(`event.data.pullKey`), and two per workspace, the plan's limit being five.

Three senders exist: the GitHub App route for every `pull_request` delivery
and each workspace connected to the installation, the GitLab project hook for
every merge request delivery, and the tacho ingest beside each
`run/pull-request.linked`.

### Reads

`list_runs` and `get_run` read a link's state from `tacho.run_pull_requests`
first and, for a link that row leaves without a state, from
`forge.pull_requests`. The two reads are merged in code, not joined across
schemas.

## Consequences

- **A check can cite a diff.** A definition-of-done check, a witness run, or
  an outcome reader subscribes to `forge/pull-request-diff.ready` and reads
  the exact bytes of a head by key, with the digest to prove it.
- **Two stores hold a link's state for now.** `tacho.run_pull_requests` stays
  as ADR-192 left it, and readers fall back to the forge row. A later change
  can retire it once every reader reads `forge.pull_request_runs`.
- **The work projection keeps one pull request per order.** The join table
  holds them all. Changing `reduce.ts` to read it is a follow-up this table
  makes possible, not part of this decision.
- **A ledger run (`arun_`) gets no run link yet.** Its pull requests come from
  `provider_publish` receipts, and no sender reads those.
- **Links before this decision get no forge row** until their pull request's
  next delivery. A one-off replay of `run/pull-request.linked` from the frames
  would fill them.
- **GitLab deliveries cost one read each,** because the hook's summary lacks
  the merge base. GitHub deliveries cost none.

## Redis

The ingestion design that prompted this decision ends in a Redis event for
work outcome validation. ADR-002 rejected BullMQ as a queue, and Inngest is
the queue here. `forge/pull-request-diff.ready` is the event outcome
validation subscribes to, and any number of functions can fan out from it. A
Redis stream, if one is added later, is a second consumer of that event, not
a replacement for the queue.

## Alternatives considered

- **Extend `tacho.run_pull_requests`.** It is keyed on a session and a URL, so
  one pull request is a row per run, and a work order has no place in it.
- **Keep the diff in Postgres.** Diffs reach tens of megabytes, and a row of
  that size slows every read of the table. Object storage keeps the row small
  and the bytes immutable.
- **Content-address the bytes by sha256.** Two workspaces with the same diff
  would share an object, and a tenant-first prefix could no longer delete one
  tenant's objects alone.
- **Fetch the diff in one step and store it in the next.** The diff would pass
  through step output, which Inngest caps at 4 MB.
