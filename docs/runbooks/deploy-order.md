# Deploy order

A production deploy job ships its commit only when two rules hold:

1. No newer commit is live for that service (ADR-164).
2. Production's schema holds no migration that the commit lacks (#5247).

This page covers the second rule. It says what a refusal looks like and how to
recover when older code reaches a newer schema anyway.

## Schema record

`migration-gate` in `.github/workflows/pipeline.yml` applies each commit's
migrations to production. When every store reads current, it records the
commit as a GitHub deployment in the `production` environment, with the task
`deploy:schema`. A deploy job reads this record because it cannot reach the
stores' own ledgers before it holds credentials.

The record only moves forward. When a gate's commit lacks a migration file that
the recorded commit holds, the gate records nothing.

This command prints the recorded commit:

```sh
gh api "repos/oxageninc/product/deployments?environment=production&task=deploy:schema&per_page=1" --jq '.[0].sha'
```

## Refused deploy

Each `deploy-node` service runs `tools/scripts/check-deploy-tip.mjs` before it
builds anything. The script lists the migration files under
`packages/database/atlas/migrations` and `packages/telemetry/src/migrations` at
the recorded commit and at its own commit. When the recorded commit holds a
file that its own commit lacks, the job skips every later step and records
nothing.

The job still shows green, the same way it does when a newer commit is already
live. The step log, a warning, and the run summary name each missing migration.

`manual-app-deploy` runs the same check and fails the job instead, because a
person dispatched it and needs to see the refusal. To get past it, dispatch a
newer commit, such as main's tip.

`deploy-web` and the installer publish skip the check. They open no database
connection.

A refused deploy needs no action. A newer commit carries the migrations, and
that commit's own run ships them.

## Recovery

When code older than the schema is live, every request that touches a renamed
or dropped table fails. On 2026-10-02 the steering API answered 500 for six
minutes (#5247).

Redeploy the newest green commit:

1. Print the recorded commit with the command above. Its run passed
   `migration-gate`, so its code matches the schema.
2. Find its run: `gh run list -R oxageninc/product --workflow pipeline.yml --commit <sha>`.
3. List the run's deploy jobs:
   `gh run view <run-id> -R oxageninc/product --json jobs --jq '.jobs[] | select(.name | startswith("deploy ")) | "\(.databaseId) \(.name)"'`.
4. Re-run each service that serves the older code:
   `gh run rerun --job <job-id> -R oxageninc/product`. The order check ships it,
   because that commit descends from what is live.

If that run is still going, let it finish. It ships on its own. A newer push run
also ships, because it carries the same migrations.

For `app` alone, `manual-app-deploy` with `source_commit` set to the recorded
commit is the break-glass path.

## Limits

- `DB Migrate (manual)` and `Store Migrate (manual)` apply migrations without
  moving the record. After a manual apply, the record lags until the next push
  run's gate records.
- A gate that applies some migrations and then fails records nothing. Until a
  later gate passes, a re-run of an older run's deploy job can still ship code
  older than those migrations.
- When the GitHub API cannot answer, the check deploys with a warning, as the
  live-commit check does (ADR-164).
- Neo4j keeps no migration ledger. It re-applies one idempotent schema file, so
  the check does not cover it.
