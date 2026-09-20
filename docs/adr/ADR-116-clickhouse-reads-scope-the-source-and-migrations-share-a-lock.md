# ADR-116: ClickHouse reads scope the source and migrations share a lock

- Status: Accepted
- Date: 2026-09-20
- Related: #2972, #2192, #2687

## Context

`chSelect` accepted a query whenever its text mentioned `org_id`. A projection, comment, or disjunction met that test without isolating the rows. The migration ledger prevented sequential replay but did not serialize processes that read it at the same time.

## Decision

`chSelect` admits one SELECT over one unqualified table, optionally with FINAL. It replaces that source with a derived table filtered by the active organization and workspace. The filter runs before outer predicates and aggregates. Caller parameters cannot replace the scope parameters.

The helper refuses joins, subqueries, set operations, comments, statement separators, and unsupported source syntax. Existing fixed queries fit this subset. This is a constrained helper for repository queries, not a SQL parser or a public query language. Queries that need another shape require a separate reviewed reader. Raw system reads stay explicit inside telemetry.

Every `migrate()` call takes a Postgres transaction advisory lock before any ClickHouse work. The stable key is `(1869768558, 2687)`. All ClickHouse migration targets using the same Postgres database serialize on it. A fixed key avoids treating two URLs for one ClickHouse server as different locks. The existing process queue remains.

`DATABASE_URL` is the coordination database and is required. Every operator targeting the same ClickHouse deployment must use the same coordination database. Missing credentials or a failed lock stops the migration before ClickHouse DDL. The dedicated connection holds only the advisory lock and closes after success or failure. It accesses no tenant tables. The telemetry package uses the Postgres driver directly to avoid a dependency cycle through `@oxagen/database`.

The manual production store workflow reads `/oxagen/production/DATABASE_URL` and opens an SSM remote-host tunnel through the app node to that same Aurora database when applying ClickHouse migrations. It retains the database hostname for TLS verification and changes only the runner-side port. The deploy role in `infra/stacks-new/ci-deploy` grants the remote-host port-forwarding document; the `infra` workflow must apply that grant before running production store migrations. Read-only dispatches and Neo4j-only applies do not need this coordinator tunnel.

## Consequences

ClickHouse-only migration invocations now also need Postgres. A Postgres outage blocks migration rather than allowing concurrent DDL. The lock serializes different ClickHouse targets sharing the coordinator, which trades migration throughput for a stable coordination identity.

This does not make ClickHouse DDL transactional. A failed migration file may still need replay, and its statements must remain individually safe to retry. The lock does not replace the ledger or justify destructive migration design.

The CI concurrency case starts two OS processes against its Postgres and ClickHouse services and checks that a pending destructive migration gets one ledger row. Tenant tests exercise outer OR predicates, aggregates, FINAL, parameter spoofing, and refused query shapes. Neither test proves production schema state.
