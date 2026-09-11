---
name: atlas-duplicate-timestamp-prefix-skips-migration
type: bug
domain: database
severity: P1
github: 2786
date: 2026-09-11
---

**Symptom:** three of four new handlers threw against tables that did not
exist, on a database where `pnpm db:migrate` had reported success.

**Root cause:** two migrations shared a version prefix —
`20260910120000_governed_action_meter.sql` (this branch) and
`20260910120000_ingestion_credential_rls.sql` (main). Atlas keys a revision by
the timestamp prefix, not the full filename, so on any database that had
already applied main's file the branch's file was recorded as applied and never
ran. The failure is silent at migrate time and surfaces far away, as a missing
relation in unrelated code.

**Fix:** renamed to a later prefix (`20260911120000_`), regenerated `atlas.sum`
with `atlas migrate hash --dir "file://atlas/migrations"` from
`packages/database`, applied locally and confirmed by `SELECT` that
`billing.governed_action_counters` exists and `billing.plans
.included_actions_annual` backfilled per tier.

**Guard:** `pnpm db:lint-migrations` already reported this as a hard FAIL — the
signal existed and nobody ran it. Run it after adding a migration, before
anything else.

**Watch-outs:** parallel branches pick timestamps independently, so a collision
is likely rather than exotic whenever two sessions add a migration on the same
day. Pick a prefix later than every existing file AND later than the shared
local database's current version. The prefix is the identity; the descriptive
suffix is decoration and does not disambiguate. See
[[migration-prefix-collision-parallel-agents]].
