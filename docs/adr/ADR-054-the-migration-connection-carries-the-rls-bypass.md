# ADR-054: The migration connection carries the RLS bypass; the policy is not changed

- **Status:** Accepted
- **Date:** 2026-09-11
- **Owners:** platform
- **Related:** issue #1368 (an Aurora rebuild cannot apply the migrations),
  issue #2652 (the same defect from the deploy end), issue #1366
  (`rds-compatibility`), `infra/tools/run-db-migrations.sh`,
  `.github/workflows/db-migrate.yml`, `tools/scripts/rds-sim-check.sh`,
  `packages/database/atlas/migrations/20260614000000_seed_official_mcp_registry.sql`

## Context

Applying the Atlas directory from empty to a managed Postgres stops at file 14:

```
pq: new row violates row-level security policy for table "registries" (42501)
Error: sql/migrate: executing statement "INSERT INTO mcp.registries …
       from version "20260614000000"
```

`mcp.registries` carries `FORCE ROW LEVEL SECURITY`, so the table's own owner is
subject to `tenant_isolation`. The policy in force at that point in the history
— created by `20260612210000_skills_builtin_readable_rls.sql` — is asymmetric:

```sql
USING      (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = …))
WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = …))
```

The seed inserts the global registry row with `org_id = NULL`. `NULL = <uuid>`
is NULL, the `WITH CHECK` fails, and the insert is refused.

This has never been seen because every Postgres the directory has been applied
to was a container whose `oxagen` role is a real superuser, and a superuser
bypasses RLS entirely. Aurora has none — the master user gets `rds_superuser`,
which is a different bit and cannot be granted `BYPASSRLS`. The arrangement that
made the seed land stopped existing at the 2026-08-27 cutover.

#1368 offered three candidate fixes: the deploy sets `app.rls_bypass`, the
policy gains the missing `org_id IS NULL` arm, or both.

## Decision

**The deploy sets `app.rls_bypass`. The policy is not changed.**

Every path that applies the directory to a cluster whose applying role is not a
superuser connects with `options=-c app.rls_bypass=on`, percent-encoded into the
connection URL:

```
postgres://…/oxagen?sslmode=require&options=-c%20app.rls_bypass%3Don
```

That is `infra/tools/run-db-migrations.sh` (production, from the app node) and
`.github/workflows/db-migrate.yml` (the preview target; its production target is
refused by a security group before it gets this far).
`tools/scripts/rds-sim-check.sh` already connected this way and keeps doing so.

## Why not the policy

**A forward migration cannot fix a statement ninety files behind it.** Atlas
replays in version order. The seed at `20260614000000` runs against the schema
as it stood at `20260612210000`. A policy corrected by a migration written today
is corrected long after the insert that needed it, so a rebuild from empty
fails in exactly the same place. The policy fix does not fix the reported
failure — it only makes the *current* policy symmetric.

**The historical file cannot be edited.** Its hash is in `atlas.sum` and in
every deployed `atlas_schema_revisions`. Changing it breaks checksum validation
on every existing database. #1368 rules this out explicitly and this ADR agrees.

**The security question, answered.** #1368 asked whether a role should be able
to write a globally-readable row, and said the answer is the decision rather
than a detail. The answer is **no**, and the schema has already said so:
`20260617120000_marketplace_workspace_scope.sql` re-created the policy with the
`org_id IS NULL` arm removed from `USING` as well, and made registries strictly
org- plus workspace-scoped. Adding an `IS NULL` arm to `WITH CHECK` today would
re-admit a concept the schema deliberately abandoned, and would let any tenant
session create a row every other tenant can read. The two clauses disagreeing in
the `20260612210000` era looks unintended, but correcting it now would be a
widening of a tenant boundary in service of a statement that already ran.

## Why the bypass is not a privilege escalation

`app.rls_bypass` is a custom GUC that the policies themselves read, not a
Postgres permission. Setting it costs the role nothing: it stays `NOSUPERUSER
NOBYPASSRLS`, so `rds-compatibility` still catches the class of migration that
genuinely needs a superuser — the two that #1333 found (`ALTER ROLE …
NOBYPASSRLS`, `CREATE FUNCTION … SET <guc>`) still fail there.

It is also the same GUC the application's own `withSystemDb` path sets for
system writes. A role applying schema changes and seeds is the system, by the
definition the application already uses.

## Consequences

- A rebuild from empty against Aurora can run the whole directory.
- The bypass is on the connection for the duration of the migration session and
  nothing else. No application connection gains it.
- Anyone removing `SIM_OPTS` from `rds-sim-check.sh` as apparent dead weight
  will fail `rds-compatibility` on file 14 — the script's comment now says so.
- Four assertions in `infra/tools/tests/render-remote-migration.test.sh` hold
  the production path to this. They fail against the pre-#1368 script.

## Alternatives rejected

**Both fixes.** The policy half buys nothing the deploy half does not already
buy, and costs a widened tenant boundary. Doing it "for tidiness" would be a
security change with no defect behind it.

**Squash the migration history so the seed runs under the current policy.**
Rebasing the directory invalidates every deployed revision table and is a far
larger blast radius than a connection parameter, for the same outcome.
