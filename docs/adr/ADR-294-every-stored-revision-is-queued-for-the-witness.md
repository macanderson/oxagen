# ADR-294: Every stored revision is queued for the witness

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** repositories, work, evidence
- **Related:** issue #5380, ADR-288 (the forge store and its diff-ready
  event), ADR-292 (every pull request read comes from the forge store),
  ADR-064 (the witness), ADR-002 (Inngest is the queue),
  `packages/inngest-functions/src/functions/forge.revision-certification.ts`,
  `packages/handlers/src/lib/forge-pull-requests/certification.ts`.

## Context

The witness (ADR-064) is meant to certify that a change meets its
definition of done. It is not built, and it had nowhere to start.
`forge/pull-request-sync` already sends `forge/pull-request-diff.ready` once
per stored revision, with the revision's id, its S3 key, and its sha256
(ADR-288). Nothing subscribed to it, and nothing recorded which revisions
still need a verdict.

The ingestion design behind ADR-288 ended in a Redis event for work outcome
validation. Oxagen runs no Redis. Adding one means a new hosted service, an
always-on cost, and an infrastructure change, while the Inngest event already
reaches every subscriber in this repository.

## Decision

1. **A queue table.** `forge.revision_certifications` holds one row per
   revision whose diff is stored, unique on the revision. A row starts
   `pending`. The witness sets it to `certified` when the change meets its
   definition of done, or `rejected` when it does not, with the time it
   decided (`decided_at`) and its verdict (`verdict`, a JSON object in the
   form the witness defines). A check constraint holds the three together: a
   pending row has no decision time and no verdict, and a decided row has a
   decision time. The row names its pull request and revision, both with
   cascading foreign keys. The pull request's runs, work orders, and issues
   reach it through the link tables of ADR-288 and ADR-292, so the queue
   copies none of them. It carries standard tenant row-level security.
2. **The diff-ready event fills it.** `forge/revision-certification`
   subscribes to `forge/pull-request-diff.ready`. Its first step writes the
   pending row. A second delivery of the same event finds the row and writes
   nothing. A revision deleted since the event was sent answers `gone`.
3. **The witness plugs in at one seam.** The function's second step calls
   the runner's `certify` for a row that is still pending. Today
   `certifyRevision` leaves the row pending with the reason
   `witness_not_built`. The witness replaces that function's body: it reads
   the stored diff by key, checks it against the digest, decides, and writes
   the row. Neither the function nor the queue changes when it does. A row
   the witness already decided is never certified again.
4. **The queue starts complete.** The migration queues every revision whose
   diff was already stored, with the time its diff was captured as the time
   it was requested.
5. **Inngest, not Redis.** The event stays on Inngest, as ADR-288 already
   decided. A Redis stream, if one is ever added for a consumer outside this
   repository, is a second subscriber to the same event, not a replacement
   for the queue.

## Consequences

- Every stored change has a recorded place for its verdict, so no revision
  can skip certification of done unnoticed. The witness's backlog is a query
  on `(org_id, workspace_id, state, requested_at)`, which an index serves.
- A revision whose diff was not stored (`too_large`, `unreadable`,
  `unconfigured`) is not queued, because the witness needs the bytes. If its
  diff is stored later, the sync sends the event then and the row is written.
- No page shows the queue yet. A page that does reads it through the same
  link tables as the change set reads (ADR-292).

## Alternatives considered

- **A Redis stream now.** It adds a hosted service and a monthly cost for a
  consumer that does not exist outside this repository. Inngest already
  retries, deduplicates by event id, and fans out.
- **A seam with no table.** The witness would have no backlog to work from,
  and nothing would show which revisions it never saw.
- **Copy the runs, work orders, and issues onto the row.** The link tables
  already hold them, and a copy would drift as links are added.
