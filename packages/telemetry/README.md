# @oxagen/telemetry

The ClickHouse client and every append-only telemetry table it writes: token
usage, tool invocations, execution and error events, Tacho events, and cost
frames. It also owns the ClickHouse migrations, OpenTelemetry tracing, the
security-event write helper, and the circuit breakers for Neo4j, Stripe, and
ClickHouse.

## Boundary

- **Owns:**
  - The shared ClickHouse client (`src/clickhouse.ts`), the tenant-stamping
    `chInsert` and `chSelect` (`src/tenant.ts`), and the per-organization
    client cache for dedicated planes (`src/data-plane-client.ts`).
  - Row shapes and insert and query helpers for each telemetry table:
    token usage, tool invocations, execution diagnostics, error events and
    clusters, sandbox logs, steering deliveries, Stella operational events,
    Tacho events, cost frames, eval item results, and router outcomes.
  - The ClickHouse schema (`src/schema.sql`), numbered migrations
    (`src/migrations/`), and the migration runner with its Postgres advisory
    lock (`src/migrate.ts`, `src/migration-lock.ts`).
  - OpenTelemetry tracing with a span attribute allowlist (`src/tracer.ts`).
  - `recordSecurityEvent`, which shapes a security event and hands it to an
    injected inserter (`src/security.ts`).
  - The circuit breaker and its shared instances (`src/circuit-breaker.ts`,
    `src/breaker-clients.ts`).
  - The anonymous CLI usage-event schema (`src/usage-events.ts`).
- **Does not own:**
  - The Postgres `security.security_events` table and its inserter:
    [`@oxagen/database`](../database/README.md) (`makeSecurityEventInserter`).
  - The security event taxonomy: [`@oxagen/compliance`](../compliance/README.md).
  - Model-call metering and prompt hashing: [`@oxagen/ai`](../ai/README.md).
  - Credit checks and delivering usage to Stripe:
    [`@oxagen/billing`](../billing/README.md).
  - Which data plane an organization uses: [`@oxagen/tenancy`](../tenancy/README.md).
- **Depends on:**
  - `@oxagen/config`: `requireEnv` for ClickHouse, Postgres, and breaker
    settings.
  - `@oxagen/tenancy`: the active scope, principal attribution, and
    `resolveDataPlane`.
  - `@oxagen/compliance`: `SECURITY_EVENT_TYPES` and the event types, which
    this package re-exports.
  - `@oxagen/tacho`: the Tacho event envelope columns and body shapes, so the
    ClickHouse table and the wire format stay one definition.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`, `apps/mcp`,
  `apps/cli` (a dev dependency for one cross-check test), `@oxagen/agent`,
  `@oxagen/ai`, `@oxagen/auth`, `@oxagen/billing`, `@oxagen/database`,
  `@oxagen/handlers`, `@oxagen/iam`, `@oxagen/ingestion`,
  `@oxagen/inngest-functions`, `@oxagen/ontology`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `chInsert` / `chSelect` | export | `packages/telemetry/src/tenant.ts` | Tenant-scoped callers in `packages/handlers`, `packages/ingestion`, `packages/database`, and `apps/app` |
| Ban on raw `clickhouse` | boundary | `eslint.tenancy-seams.mjs` | `eslint.config.mjs`, `eslint.next.mjs`, `apps/app/eslint.config.mjs` |
| `AuditInsertFn` | port | `packages/telemetry/src/security.ts` | Implemented by `makeSecurityEventInserter` in `@oxagen/database/security` |
| `recordSecurityEvent` | export | `packages/telemetry/src/security.ts` | Passed to the kernel's `setSecurityEventEmitter` in `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, and `apps/app/instrumentation.ts` |
| `initTracer` | injection | `packages/telemetry/src/tracer.ts` | `apps/api/src/bootstrap.ts`, `apps/mcp/src/middleware.ts`, `apps/app/instrumentation.ts` |
| `neo4jBreaker` / `stripeBreaker` | export | `packages/telemetry/src/breaker-clients.ts` | `packages/ontology/src/tenant.ts`, `packages/billing/src/client.ts` |
| `migrateClickhouse` | export | `packages/telemetry/src/migrate.ts` | `tools/scripts/db-migrate.ts`, run by `pnpm db:migrate` and the `migration-gate` CI job |
| ClickHouse network boundary | boundary | `packages/telemetry/src/clickhouse.ts` | `CLICKHOUSE_URL` and its credentials |

## Entry points

- `.` (`src/index.ts`): the client, `chInsert` and `chSelect`, every table
  helper, the breakers, the tracer, the security helper, and
  `migrateClickhouse`.
- `./client` (`src/client.ts`): the raw client. Lint bans importing
  `clickhouse` from it outside this package.
- `./migrate` (`src/migrate.ts`): the migration runner. `pnpm --filter
  @oxagen/telemetry migrate` runs it directly.
- `./usage-events` (`src/usage-events.ts`): the CLI usage-event schema. It
  imports only `zod`, so a client can take it without the ClickHouse and
  OpenTelemetry dependencies.

## Rules

- ClickHouse is append-only. Mutable state and graph data do not go here.
- Tenant rows go through `chInsert`, which stamps `org_id` and `workspace_id`
  from the active scope and throws `TenantScopeError` without one.
- A degraded or disabled dedicated plane throws rather than writing into the
  platform store (ADR-042).
- Two ClickHouse migrations never share a numeric prefix.
  `tools/scripts/check-ch-migration-ordinals.mjs` fails `pnpm check:contracts`
  when they do.
- Span attributes go through `setSpanAttrs`, which drops any key not on
  `ALLOWED_SPAN_ATTRIBUTES`. The filter checks keys, not values.
- `src/security.ts` makes no database call of its own. Do not wrap the injected
  inserter in `withTenantDb`: a denied call with no tenant still needs its
  audit row.
- This package must not import `@oxagen/database`, which depends on it. The
  migration lock opens its own Postgres connection for that reason.

## Tests

```bash
pnpm --filter @oxagen/telemetry test:unit src/circuit-breaker.test.ts
```

Tests sit beside their source under `src/`. The `*.integration.test.ts` files
need a live ClickHouse and skip when it does not answer.
