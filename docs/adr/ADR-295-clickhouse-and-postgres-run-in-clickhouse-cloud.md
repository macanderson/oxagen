# ADR-295: ClickHouse and Postgres run in ClickHouse Cloud

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** platform
- **Amends:** ADR-181 (its limits now govern only the node's own ClickHouse
  container, which production stops reading at the switch), ADR-240
  (Parameter Store still holds every setting, and the Cloud values take the
  place of the node's and Aurora's under the same names).
- **Supersedes:** the statement in `infra/modules/app-node/main.tf` that
  ClickHouse stays on the app node.
- **Related:** issue #5395, issue #4243 (reads refused at the node's memory
  cap), issue #5311 (the Spend page stuck on September's findings), ADR-042
  (the data plane), ADR-246 (CI runners),
  `.github/actions/open-store-tunnels/action.yml`,
  `.github/workflows/store-migrate.yml`, `infra/tools/clickhouse-tunnel.sh`,
  `packages/database/atlas/migrations/20261003233000_uuid_generate_v7_native_on_pg18.sql`.

## Context

Production ClickHouse runs in a container on the app node, capped at 1.5 GiB
of server memory (ADR-181). Since 2026-10-02 19:00 UTC it has refused 300 to
640 queries an hour with code 241, `Memory limit (total) exceeded` (#4243).
The findings pass, run progress, and run reads fail with it. The Spend page
has shown September's findings since Sep 28 (#5311).

Production Postgres runs on Aurora PostgreSQL 16.8. Every table's id default
calls `public.uuid_generate_v7()`, and on Aurora that function is a stub that
returns a random v4 id, because Aurora has no `pg_uuidv7` extension.

On 2026-10-03 Mac decided to move both stores to ClickHouse Cloud.

## Decision

1. **ClickHouse moves to ClickHouse Cloud.** The service is `production`, in
   AWS us-east-1, with 2 replicas of 8 to 32 GiB each and idle scaling off.
   Its `oxagen` database holds every table and the view, created from
   production's own DDL. The HTTPS interface listens on port 8443.
2. **Postgres moves to ClickHouse Cloud Postgres.** The service is
   `sql-production`: Postgres 18.6 on r6gd.medium with an async standby. It
   has the roles `oxagen` (LOGIN CREATEROLE, not superuser, no BYPASSRLS) and
   `oxagen_app` (NOLOGIN), an `oxagen` database owned by `oxagen`, and the
   extensions citext, pg_trgm, pgcrypto, uuid-ossp, and vector.
3. **Neo4j stays on the app node.** Nothing about it changes.
4. **Only the node's NAT address reaches ClickHouse Cloud.** The service's
   IP access list names one address: 3.228.254.156, the Elastic IP of the NAT
   instance the app node's private subnet routes through (`aws_eip.nat` in
   `infra/modules/network/main.tf`). The platform's containers on the node
   reach Cloud directly, and CI reaches Cloud Postgres through the node, the
   way it reached Aurora.
5. **CI reaches Cloud through the node.** A GitHub runner has no fixed
   address to admit. Every CI path that reads or migrates production
   ClickHouse opens an SSM port forward through the node to the Cloud host
   (`AWS-StartPortForwardingSessionToRemoteHost`), so the connection leaves
   AWS from the NAT address. The runner maps the Cloud host name to 127.0.0.1
   in `/etc/hosts` and keeps that name in `CLICKHOUSE_URL`, so TLS checks the
   certificate against the real name. The Aurora coordinator tunnel already
   worked this way.
   `infra/tools/clickhouse-tunnel.sh` makes the choice from the scheme of
   `CLICKHOUSE_URL`: `http` is the node's own ClickHouse on port 8123, as
   before, and `https` is Cloud. Both `open-store-tunnels` and
   `store-migrate.yml` call it, so CI follows the parameter and needs no
   change at the switch. The CI role's `PortForwardDocument` statement
   already allows the remote-host document, and the node's security group
   already allows any outbound port, so no Terraform changes.
6. **Parameter Store stays the one store (ADR-240).** The Cloud values are
   staged as `CLICKHOUSE_CLOUD_URL`, `CLICKHOUSE_CLOUD_USERNAME`,
   `CLICKHOUSE_CLOUD_PASSWORD`, `DATABASE_CLOUD_URL` (the `oxagen` role), and
   `DATABASE_CLOUD_ADMIN_URL`, all under `/oxagen/production/`. The switch
   copies them into `DATABASE_URL`, `/oxagen-app/postgres/password`, and the
   four `CLICKHOUSE_*` parameters the platform already reads.
7. **Ids become time-ordered after the switch.** Migration
   `20261003233000_uuid_generate_v7_native_on_pg18.sql` makes
   `uuid_generate_v7()` a PL/pgSQL function that returns `uuidv7()` on
   Postgres 18 and later and a v4 id before that. It reads the version when it
   runs. It applies to Aurora when this change merges, `pg_dump` carries the
   body to Cloud, and new ids there are v7 with no further migration. Ids
   written before the switch stay v4.
8. **The per-query limits rise after the switch, not before.** The limits in
   `cost-frames.ts`, `tacho-events.ts`, `table-rebuild.ts`, and
   `tools/scripts/fleet-capacity/reconcile.ts` fit the node's 1.5 GiB cap.
   Raised before the switch, they would make the node fail more often. A
   second change raises them for an 8 GiB replica right after it.
9. **The node's ClickHouse container stays for now.** It is the rollback
   target. A later change removes it, along with the parts of ADR-181 that
   only it needs.
10. **A partition-key rebuild accepts Cloud's databases.** A `REBUILD TABLE`
    migration swaps tables with `EXCHANGE TABLES`. ClickHouse Cloud creates
    its databases with the `Shared` engine, or `Replicated` on an older
    service, and both can swap, so the rebuild accepts them beside `Atomic`.
    A table that already has the new key passes without the engine being
    read, which is the case for every table in Cloud today.

## Cutover

1. Merge the CI tunnel change.
2. Stop api, app, mcp, and admin on the node.
3. Truncate the Cloud ClickHouse data tables, then copy every table from the
   node, one day at a time.
4. `pg_dump` Aurora (a Postgres 18 client, `app.rls_bypass` on,
   `--enable-row-security`), then `pg_restore` into Cloud as the admin login.
   Compare exact row counts.
5. Point `DATABASE_URL`, `/oxagen-app/postgres/password`, and the four
   `CLICKHOUSE_*` parameters at Cloud.
6. Redeploy api, app, mcp, and admin, since containers read Parameter Store
   at deploy time.
7. Verify that a Tacho upload lands, a run page reads, and the next findings
   pass moves the window past Sep 28.

**Rollback** is to restore the old parameter values and redeploy. Rows
written to Cloud after step 6 stay in Cloud until someone copies them back.

## Consequences

- No pull request job opens the production tunnels, so the `https` branch of
  the tunnel first runs after step 5. The first `migration-gate` after the
  switch would run it inside a deploy, where a failure blocks `deploy-node`.
  Dispatch `store-migrate-drift.yml` right after step 5 instead. It is
  read-only and runs the same action.
- `packages/telemetry/src/migrate.ts` sends
  `CREATE DATABASE IF NOT EXISTS` before anything else. The Cloud user needs
  the grant for it even though the database exists.
- The ClickHouse migration lock lives in the Postgres that `DATABASE_URL`
  names. After the switch it lives in Cloud Postgres, and CI reaches it
  through the same coordinator tunnel.
- A real `REBUILD TABLE` on Cloud is unproven at two points. The shadow table
  is created from the live table's `engine_full`, which on Cloud names the
  replication path, and a `Shared` or `Replicated` database may refuse an
  explicit path. And the wait for inserts that began before the swap reads
  `system.processes`, which lists only the replica that answers. Prove both on
  a Cloud service before the next rebuild migration ships.
- The node's NAT address is now part of production. Replacing `aws_eip.nat`
  changes the address and cuts the platform and CI off from both stores until
  the Cloud allow lists name the new one.

## Alternatives considered

- **Allow-list the CI runners.** GitHub-hosted runners have no fixed
  address. Admitting every address range GitHub publishes for them would
  admit any GitHub Action, not only Oxagen's.
