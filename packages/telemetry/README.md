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

## Execution attribution

`tool_invocations.execution_step_id` names the run a tool call belonged to.
The caller sets it to the same key it hands the metered AI port, so a
`tool_invocations` row joins to its `token_usage` rows on that column. The
rule of record is the comment on `CapabilityContext.executionStepId` in
`packages/oxagen/src/types.ts`.

Every row goes through `insertToolInvocation` (`src/clickhouse.ts`). Two files
call it:

- `buildInvocationPayload` in `packages/agent/src/runtime/materialize-tools.ts`
  builds the row for every capability call and external MCP tool call that
  goes through `materializeTools`.
- `emitGraphDeletionTelemetry` in `packages/handlers/src/graph.telemetry.ts`
  builds the row for a graph delete. Nothing calls it today (#1380).

Both write `ctx.executionStepId ?? null`. A call with no run behind it, from
the API, from MCP, or by a person, writes NULL. Do not fill the column with a
request id, a message id, or a fresh UUID. A made-up key joins to nothing, and
a reader cannot tell it from a real one.

Two tests hold this. `tools/scripts/tool-invocation-execution-identity.tree.test.ts`
finds every file that calls `insertToolInvocation` and fails on a bare
`execution_step_id: null`. `src/tool-invocation-execution-join.integration.test.ts`
runs the join against a live ClickHouse.

## Served tool calls

`served_tool_calls` (migration 0037) holds one row per call a wrapped agent
makes to a published server's tool (ADR-234). The served tools in
`apps/mcp/src/servers/call.ts` write it through `recordServedToolCall`,
beside the governed-action meter. MCP Studio's tool panel reads
`readServedToolFeedback` for one server: calls, schema rejections, error
results, and retries per tool. The run is the tacho session's `tse_` id, or
empty when the request named none. It is not a `tool_invocations` row,
because a served call has no message id and no UUID server key.

## Tests

```bash
pnpm --filter @oxagen/telemetry test:unit src/circuit-breaker.test.ts
```

Tests sit beside their source under `src/`. The `*.integration.test.ts` files
need a live ClickHouse and skip when it does not answer.
