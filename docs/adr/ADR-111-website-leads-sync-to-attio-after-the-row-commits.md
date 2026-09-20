# ADR-111: Website leads sync to Attio after the row commits, with the outcome on the row

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform
- **Related:** ADR-102 (the cms lead gate); ADR-043 (Oxagen governs agents,
  it does not run them: this is a marketing seam, not a capability)
- **Delivered by:** `apps/api/src/lib/cms/attio.ts` (the client),
  `apps/api/src/lib/cms/crm-sync.ts` (the sync and the backfill query),
  `apps/api/src/scripts/cms-crm-backfill.ts`, migration
  `20260920140000_cms_leads_crm_sync.sql`, `ATTIO_API_KEY` in the env registry

## Context

The oxagen.sh forms ("Get a demo" and the field-manual gate) post to
`POST /v1/cms/leads`, which upserts `cms.leads` in Postgres and, for the book,
emails a reader link. Sales now works out of Attio, so a lead that only exists
in a Postgres table is a lead nobody follows up.

Three ways to get the lead into Attio were on the table:

1. Call Attio inside the request, before answering the visitor.
2. Emit an Inngest event and sync in a durable function with retries.
3. Call Attio after the row commits, without blocking the response, and
   record the outcome on the row so a missed lead is visible and re-syncable.

## Decision

Option 3. Postgres stays the record and the form's answer never depends on a
third party. After `cms.leads` commits, the route hands the lead id to
`queueCrmSync`, which asserts a company (by email domain, skipped for
consumer mailboxes), asserts a person (by email) linked to it, writes a
note on the person carrying the fields Attio has no attribute for, and, for
a lead who asked for the book, adds the person to the "Inbound lead
nurture" list with Asset set to each edition their access codes name and
Branch left blank for the nurture sequence's day-3 job. A demo request is
a conversation, not a nurture, so it stays off the list, and so does a lead
who declined marketing contact: consent gates the list, and a consent
withdrawn on a later form takes the person off it. The result is
written back to the row: `crm_record_id` and `crm_synced_at` on
success, `crm_sync_error` on failure. The client retries 429 and 5xx with
backoff and honours `Retry-After`. `pnpm --filter @oxagen/api
cms:crm-backfill` re-runs the same sync for every row with `crm_synced_at`
null, oldest first, so an outage or a key rotation is recovered with one
command instead of a database export. The API release bundles that script
beside the server (`dist/cms-crm-backfill.cjs`), so in production it runs
as `docker exec oxagen-api node cms-crm-backfill.cjs` on the app node, with
the container's own environment; nothing else in the account holds
`DATABASE_URL` and `ATTIO_API_KEY` together. Every resubmission clears
`crm_synced_at` (the record id stays), so a lead who comes back is pending
again until the CRM has seen the new version.

Person and company asserts are idempotent (Attio matches on the one unique
attribute of each object), so a retry or a backfill cannot create a second
record. A note is a new object each time, which is intended: a visitor who
submits twice shows two notes, and the second one is the signal. Within one
sync, though, a note whose response was lost is not retried, because Attio
offers no idempotency key for notes and the first attempt may have landed;
the failure is recorded on the row and the backfill writes the note once. The list
entry is asserted with no values and the asset is then appended with the
PATCH form, because a PUT with values overwrites a multi-select (verified
against the workspace on 2026-09-19): a second form must add its asset to
the entry, never reset it, or the good leads restart the sequence.

## Consequences

- The sync is unmetered, unaudited and outside the capability kernel. It is
  a marketing seam like `/v1/cms/*` itself (ADR-102) and `/v1/telemetry`,
  not an agent capability, so it has no contract, MCP tool or CLI command.
- A sync that fails after the response is not retried by anything but the
  backfill. That is a deliberate trade against option 2: Inngest has been the
  single point of failure for every background job in this repo (PR #3464),
  and a marketing sync should not share its blast radius. If the pending set
  ever grows faster than a daily backfill clears it, wire `syncPendingLeads`
  to a cron and this ADR is amended, not reversed.
- Option 1 was rejected because a slow or down CRM would slow or break the
  form, and the visitor is the one person who must not pay for that.
- The key is the workspace's Attio access token with
  `record_permission:read-write`, `object_configuration:read` and
  `note:read-write`. It lives in Parameter Store under
  `/oxagen/production/ATTIO_API_KEY` like every other API secret; unset, the
  sync is off and the code path is a no-op, which is the local and CI state.
