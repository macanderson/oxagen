# #2972 tenant and telemetry follow-up

## Scope and base

Branch `fix/backlog-tenant-telemetry` starts from freshly fetched main `ec637f8e4`, then includes recovery PR #3543 at `2174aa7f7`. The recovery removes the unreviewed nullable-workspace migration. This branch does not restore it or include migrations from other open PRs. Atlas regenerated the checksum for this branch's partition migration.

This change references #2972. It does not close the umbrella issue.

## Changes ready for CI

- #1288 and #2197: shared and dedicated ClickHouse clients guard query, insert, command, exec, and ping at construction. Response bodies and streams settle breaker leases. Close remains available during an outage. Dedicated organization/configuration breakers are isolated.
- #2513: malformed tenant entry uses `invalid_tenant_scope` and a kernel error event. Missing scope retains `no_tenant_scope` and a denial event.
- #2514: normalized async local storage uses an internal required-field scope type.
- #2515: capability attribution requires a bounded identifier string. UUID checks reject coercible objects.
- #2516: each scope stores a frozen attribution projection and returns it without allocating another object or exposing tenant IDs.
- #2840: ADR-125 restores the partitioned audit parent while preserving the existing heap as DEFAULT. The daily job calls bounded, no-argument maintenance under a trusted database owner. UTC calendar retention, transaction locks, dependency refusal, and restricted child access are explicit.

## Verification

Only local test file: `pnpm --filter @oxagen/telemetry exec vitest run src/clickhouse-breaker-client.test.ts`. Result: 8 passed on 2026-09-19. No other local test file, suite, build, lint, or typecheck was run manually.

CI-only changes cover tenant scope validation, real kernel security-event classification, daily job refusal/result validation, partition metadata and role grants, DEFAULT movement, seven-year calendar cutoff, expired named partitions, repeated maintenance, and the advisory lock from another connection. The PostgreSQL fixture rolls back its rows and DDL.

Independent peer review approved the tenant/kernel/breaker changes and bounded partition design. Configured format, typecheck, lint, and Atlas hooks check each commit. The PostgreSQL fixture runs maintenance under a non-superuser owner to cover row privileges as well as DDL. Production application is not authorized by this source review.

## Remaining umbrella requirements

- #2150: separate system credentials and an unforgeable database role boundary remain open. The current custom GUC bypass is not made unforgeable by this PR.
- #1394: the `withSystemDb` justification checker and shrinking baseline remain open. The new cron call explains its trusted cross-tenant purpose.
- #1346: the full NULL-versus-empty bypass reader audit and authorization-foundation regression remain open.
- #2196, #2146, #2151, and #2143: evaluation read bound, Neo4j workspace manifest key, mandatory application-role fixture, and schemaFilter guard are outside this bounded change.
- #2668: engram attribution remains outside this task.
- #2191, #2201, and #2820: billing/AI durable telemetry delivery is owned by the billing pass. A breaker alone does not make telemetry durable.
- #2822: nullable-workspace RLS writes are owned by the separate RLS change and its recovery workflow.
- #2192 and #2687: tenant select admission and cross-process ClickHouse migration coordination were delivered in PR #3533.
- #1947 and #2202: keep shipped ClickHouse migration history intact. The prior audit records load-bearing DROP statements and the duplicate-ordinal grandfathering guard.
- #2156 and #2158: source fixes already exist, but production drift/application evidence remains with the parent audit.

Do not convert these statements into completed issue checkboxes until their own evidence and CI pass.
