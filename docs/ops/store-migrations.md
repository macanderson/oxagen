# Runbook: ClickHouse and Neo4j migrations in production

The path from a committed migration to the production copies of these two
stores, and the thing that notices when nobody has walked it. Postgres is next
door and different — see `infra/tools/run-db-migrations.sh` and ADR-054.

Answers the first item of #1370: *is there an out-of-band path already applying
these?* No. There never was one, and this file plus the two workflows below are
the replacement.

## Where the stores are

Both run as containers on the `oxagen-app` EC2 node in account `916294258235`,
bound to `127.0.0.1` and exposed to nothing — not to the VPC, not to the load
balancer. ClickHouse answers HTTP on 8123, Neo4j speaks Bolt on 7687. The only
way in from outside the node is an SSM port-forwarding session, which is what
both workflows open.

Redshift Serverless was removed in #2693; ClickHouse is the analytics store and
it is self-hosted.

## Applying a migration

**`.github/workflows/store-migrate.yml`** — Store Migrate (manual). Dispatch it.

1. Run it first with `apply` left **false**. That opens the tunnels, proves they
   reach the stores, and prints the pending list. It writes nothing.
2. Read the pending list. If it shows the entire history pending against a store
   you believe is populated, **stop**. The runner treats a database with no
   pre-existing tables as a fresh deployment and will execute every file, which
   is right for an empty store and wrong for one whose ledger was lost.
3. Re-run with `apply` true.

It is a manual dispatch rather than a step in the deploy, matching the decision
already made for Postgres: `pipeline.yml` used to apply migrations to prod on
every push and that job was retired (#1341). A schema change to a live store is
read before it is applied, and the dispatch is where a person does the reading.

## Noticing that nobody applied it

**`.github/workflows/store-migrate-drift.yml`** — Store Drift (scheduled).
Daily at 06:20 UTC, and on demand.

It opens the same tunnels, reads only, and compares production against the
repository:

| Store | Declared by | Production asked via |
|---|---|---|
| ClickHouse | `packages/telemetry/src/migrations/*.sql` | `SELECT DISTINCT filename FROM <db>._migrations` |
| Neo4j | named constraints and indexes in `packages/ontology/src/schema.cypher` | `SHOW CONSTRAINTS` / `SHOW INDEXES` |

The logic lives in `infra/tools/check-store-drift.sh` and is unit-tested by
`infra/tools/tests/check-store-drift.test.sh`, which runs in CI through
`check:db-migrate-script`.

On a failing run it opens or comments on the issue carrying the `store-drift`
label, and closes it again when the check next passes — the same shape
`infra-drift.yml` uses next door, found by label rather than by matching a title.
A red scheduled run on its own is something people learn to scroll past.

Exit 2 neither closes the issue nor reports drift. It says the check did not
happen, under its own title, because a recovery is claimed off an answer and
never off the absence of one.

Three outcomes, deliberately kept apart:

- **0** — both stores carry everything declared.
- **1** — a store is behind. A migration merged and never reached production.
- **2** — the check could not be made. The store's state is *unknown*, which is
  not the same as current, and does not read as a pass.

### Why the Neo4j half is narrower

Neo4j keeps no migration ledger; its migration is idempotent
`CREATE ... IF NOT EXISTS` and forgets what it did. Every constraint and index
in `schema.cypher` is named, though, and `SHOW CONSTRAINTS` returns those names,
so the same set difference works. What it cannot see is a relabel or a backfill
step — those leave no name behind. Narrower and true beats broad and guessed,
and the constraints are where a missed migration actually bites.

## What this cost before it existed

Production ClickHouse carried **no schema at all** from the 2026-08-27 cutover
onward. The API's error-reporting sink failed on every capture with
`Table oxagen.error_events does not exist`, and nothing reported it — a failing
error reporter is the one component whose failure it cannot report.

CI has always run these migrations: the `test` and `e2e` jobs both call
`db-migrate.ts` with `DB_MIGRATE_STORES=clickhouse,neo4j` against their own
ephemeral service containers. So the migrations were known to *apply*. Nothing
established that anyone had applied them to the store the platform uses.

## Adding a migration

- **ClickHouse:** a new `packages/telemetry/src/migrations/NNNN_*.sql`. The
  drift check picks it up with no edit here.
- **Neo4j:** a named `CREATE CONSTRAINT` / `CREATE INDEX` in
  `packages/ontology/src/schema.cypher`. Name it — an unnamed index gets an
  auto-generated name the check can never match, so it would be invisible.

Either way the drift check goes red the morning after the merge and stays red
until Store Migrate is dispatched. That is the intended behaviour, not a defect:
it is the window between committing a schema change and applying it, and it
should be short.
