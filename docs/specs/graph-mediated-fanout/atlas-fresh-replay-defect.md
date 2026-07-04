# Atlas fresh-replay defect: `pg_trgm` never created by any migration

**Status:** needs team decision · **Found:** 2026-07-03 (while generating the
`subagent_runs.summary` migration for PR #527) · **Blast radius:** any fresh
environment bootstrap + every local `atlas migrate diff`

> Ready to paste into Linear (`oxagen-v2`): suggested labels `database`,
> `infra`, `tech-debt` · estimate S(2) · priority P2 — filed as a doc because
> the repo `LINEAR_API_KEY` was stale (401) at time of writing.

## Problem

`packages/database/atlas/migrations/20260625130000_*.sql` creates
`catalog_servers_search_trgm_idx` using the `gin_trgm_ops` operator class, but
**no migration creates the `pg_trgm` extension**. The baseline
(`20260611233016_initial_schema.sql:2-8`) creates only `citext`, `uuid-ossp`,
and the `pg_uuidv7` fallback.

Consequences, verified locally:

1. **`atlas migrate diff` is broken for everyone** since 2026-06-25. Atlas
   replays the migration directory on the `atlas_dev` scratch DB (wiping it
   first, extensions included) and dies at `20260625130000` with
   `operator class "gin_trgm_ops" does not exist` — so recent migrations have
   been hand-written + `atlas migrate hash`, bypassing drift detection.
2. **A fresh environment cannot bootstrap.** `atlas migrate apply` on an empty
   database fails at the same version. Existing envs (local, preview, prod)
   only work because `pg_trgm` was present before that migration was applied.

Interim mitigation already merged (PR #527): `tools/scripts/atlas-dev-setup.sh`
now installs `pg_trgm` in `atlas_dev` — but Atlas's start-of-run wipe drops it
again mid-replay, so this alone does NOT restore `migrate diff`; only a
migration-resident `CREATE EXTENSION` does.

## Why this needs a decision (not a drive-by fix)

The clean fix edits an **applied** migration, and this repo's policy says
migrations are immutable after merge. More concretely: Atlas records a hash per
applied version in `atlas_schema_revisions`; `migrate apply` errors on any
already-applied file whose hash changed. An uncoordinated edit would brick
deploys on every environment simultaneously.

## Options

### Option A — edit the offending migration + re-baseline revisions (recommended)

1. Prepend `CREATE EXTENSION IF NOT EXISTS pg_trgm;` to
   `20260625130000_widen_installed_plugins_type_check.sql` (idempotent — a
   no-op everywhere it already ran).
2. `atlas migrate hash` (updates `atlas.sum`).
3. On each env that already applied it (prod, preview, any long-lived local):
   `atlas migrate set 20260625130000 --env <env>` (or newest applied version)
   to re-baseline the revision hashes. One-time, read-only w.r.t. schema.
4. Verify: `atlas migrate status --env <env>` clean, and a scratch
   `atlas migrate apply` on an empty DB completes end-to-end.

Pros: restores both fresh bootstrap AND `migrate diff`; content change is
provably a no-op on applied envs. Cons: touches applied-migration policy;
step 3 must run on every env before its next deploy (sequence it in one PR +
one ops window).

### Option B — new "extensions repair" migration + documented dev-DB caveat

Add `2026MMDD_create_pg_trgm.sql` (CREATE EXTENSION IF NOT EXISTS) so *future*
schema state is self-describing, and accept that replay-from-zero still fails
at `20260625130000` — fresh bootstrap would need a documented manual
`CREATE EXTENSION pg_trgm` before `migrate apply`, and `migrate diff` stays
broken (or requires a template dev-DB image with pg_trgm preinstalled, e.g.
`dev = "docker://postgres/17/dev"` swapped for a custom image).

Pros: zero applied-migration edits. Cons: `migrate diff` stays broken — the
actual day-to-day pain — and bootstrap gains a manual step that WILL be
forgotten.

### Option C — squash to a new baseline

Re-baseline the whole directory (`atlas migrate new --baseline`-style) with
extensions correct. Largest blast radius; only worth it bundled with other
migration-hygiene work.

## Recommendation

**Option A.** The edit is a provable no-op on every applied environment, the
revision re-baseline is a supported Atlas flow, and it is the only option that
restores `migrate diff` (drift detection) — which is the tool that would have
caught this class of bug in the first place.

## Acceptance checklist

- [ ] `atlas migrate apply --env local` on an EMPTY scratch database completes 0→HEAD
- [ ] `bash tools/scripts/atlas-dev-setup.sh && atlas migrate diff --env local <name>` produces a diff (no replay error)
- [ ] `atlas migrate status` clean on prod + preview after re-baseline
- [ ] CI migration job green on the next real migration PR

## Rollback

Step 3 (`migrate set`) is metadata-only; reverting the file edit +
`atlas migrate hash` + re-running `migrate set` restores the prior state. No
schema objects are created or dropped anywhere (`IF NOT EXISTS` no-op).
