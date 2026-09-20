# ADR-125: Audit partition maintenance and telemetry boundaries

Status: Accepted for implementation. Production application remains a separate deployment.

## Context

The Atlas baseline creates `security.security_events` as a heap. Its scheduled job issues partition DDL, which fails because the parent is not partitioned. The composite primary key already includes `occurred_at`, so restoring partitioning does not change event identity. Issue #2972 recommends this restoration and retains seven years of audit events.

The same backlog identifies ClickHouse calls that bypass circuit breakers and malformed tenant attribution that shares the missing-scope error code.

## Decision

Keep PostgreSQL as the security-event store. Restore monthly RANGE partitions on `occurred_at`. Rename the existing heap to the DEFAULT partition without deleting its rows. Copy the parent policies and grants before attaching it. Refuse conversion when incoming foreign keys, dependent views, user triggers, or column grants need a separate migration.

The daily 03:00 UTC job calls `security.maintain_audit_partitions()` with no arguments. The function takes an advisory transaction lock and a parent table lock. It creates the current and next two UTC calendar months. It moves matching DEFAULT rows before attaching each new child, in the same transaction. Existing names that belong to another parent cause a refusal.

Retention uses PostgreSQL server time minus seven calendar years. A named partition can expire only when its catalog upper bound is at or before the cutoff. Named partitions can retain the oldest partial month beyond seven years until that upper bound expires. DEFAULT cleanup uses the exact cutoff. Each call also deletes at most 10,000 expired DEFAULT rows. A remaining backlog appears in the job result and warning log. The DEFAULT partition remains available for late or future events.

The maintenance function uses `SECURITY DEFINER` with a fixed `pg_catalog, pg_temp` search path and qualified application identifiers. Putting `pg_temp` last prevents temporary relations from shadowing catalog reads. Its trusted migration owner must be unavailable to `oxagen_app`. The migration also refuses application CREATE privileges on the security schema. PUBLIC has no execute grant. The application can execute maintenance but cannot choose a cutoff, table name, or SQL statement. A private invoker helper copies table security and is unavailable to the application.

Preserve application access through the parent. Force RLS on children and withhold direct child grants. This avoids stale child access after a later migration changes the parent's policies. The maintenance function owns child DDL and row movement.

Wrap shared and dedicated ClickHouse clients when they are constructed. Query, insert, command, exec, and ping calls enter a breaker. Query bodies and streams hold their lease until completion, failure, or cancellation. Receiving headers alone does not mark a failed body healthy. Dedicated configurations have separate breakers. Client close stays outside the breaker so cleanup works during an outage.

Validate tenant and principal identifiers before entering async local storage. Malformed attribution raises `invalid_tenant_scope` and produces an error event. Missing scope keeps `no_tenant_scope` and its denial event. Store one immutable attribution projection per scope without exposing tenant identifiers through that projection.

## Consequences and verification

Partition creation and retention take an exclusive parent lock. The migration preserves existing data but needs a deployment window sized for catalog changes and DEFAULT validation. A large retention backlog can take multiple daily batches. Production apply is not part of this source change.

CI integration tests invoke maintenance through the application role under a non-superuser function owner. They check the partitioned parent, restricted function and child permissions, DEFAULT row movement, exact calendar cutoff, expired partition removal, repeated delivery, and the advisory lock from another connection. Unit tests cover job refusal and result validation, tenant error classification, and ClickHouse response leases.

This decision does not provide separate system database credentials (#2150), a `withSystemDb` shrinking baseline (#1394), or production schema drift evidence. Those remain separate requirements in #2972. It does not rewrite shipped ClickHouse migrations or change billing delivery.
