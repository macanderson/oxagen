# @oxagen/inngest-functions

The durable background jobs, written against the provider-neutral contracts in
`@oxagen/functions` and run on Inngest. This package owns the Inngest client,
the list of registered functions, and the adapter that turns a neutral
definition into an Inngest function.

## Boundary

- **Owns:**
  - The Inngest client and its event catalogue (`src/inngest.ts`).
  - The `functions` array that `apps/api` serves (`src/functions.ts`). A job
    missing from that array never runs.
  - Every job under `src/functions/`: billing sweeps and usage delivery, cost
    rollups and price-book sync, connector ingestion and OAuth refresh,
    privacy export and erasure, mandate expiry, approval resume, run
    enrichment and summaries, evidence export and frame compaction, retention
    sweeps, and schema reconciliation.
  - The `createEventClient` and `createFunction` adapters over
    `@oxagen/functions` (`src/adapter.ts`, `src/create-function.ts`).
  - The Inngest signing-key environment check (`src/env-check.ts`).
- **Does not own:**
  - The durable-function contract itself: [`@oxagen/functions`](../functions/README.md).
  - The HTTP route Inngest calls: `apps/api/src/routes/inngest.ts`.
  - Capability handlers that send the events these jobs trigger on:
    [`@oxagen/handlers`](../handlers/README.md).
  - The connector pipeline the ingestion jobs drive:
    [`@oxagen/ingestion`](../ingestion/README.md).
  - The run ledger and evidence store the run jobs read and write:
    [`@oxagen/run-ledger`](../run-ledger/README.md).
- **Depends on:**
  - `@oxagen/functions`: the `DurableFunction`, `StepContext`, and
    `EventClient` contracts this package implements.
  - `@oxagen/config`: `requireEnv` for the Inngest keys.
  - `@oxagen/database` and `@oxagen/tenancy`: Postgres access and tenant scope
    for every job that touches tenant rows.
  - `@oxagen/billing`: dunning, usage delivery, grant close, and cost rollups.
  - `@oxagen/ingestion`: connectors, sync, dedup, embedding, and filters.
  - `@oxagen/ontology`: scoped Neo4j sessions for ingestion, deletion, and
    schema reconciliation.
  - `@oxagen/telemetry`: ClickHouse reads and writes.
  - `@oxagen/crypto`: connector credential encryption and decryption.
  - `@oxagen/storage`: privacy export archives.
  - `@oxagen/run-ledger`: the run store and the evidence store.
  - `@oxagen/tacho`: digests, export-bundle shapes, and the attester key.
  - `@oxagen/agent` and `@oxagen/ai`: the governed turn and model calls behind
    run enrichment and summaries.
  - `@oxagen/oxagen`: the run-enrichment setting and context-record labels.
  - `@oxagen/plugins`: MCP catalog sync and plugin OAuth refresh.
  - `@oxagen/rules`: the mandate ledger for approval expiry.
- **Used by:** `apps/api`, `apps/app_deprecated`, and `@oxagen/handlers`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `inngest` and `functions` | export | `packages/inngest-functions/src/index.ts` | `apps/api/src/routes/inngest.ts`, mounted at `/api/inngest` in `apps/api/src/app.ts` |
| `createEventClient` | adapter | `packages/inngest-functions/src/adapter.ts` | `apps/api/src/event-client.ts`, `packages/handlers/src/event-client.ts` |
| `createFunction` | adapter | `packages/inngest-functions/src/create-function.ts` | Every job under `src/functions/` |
| `inngestEnvironmentComplaint` | export | `packages/inngest-functions/src/env-check.ts` | `apps/api/src/bootstrap.ts`, which logs the complaint at boot |
| `/api/inngest` | boundary | `apps/api/src/routes/inngest.ts` | Inngest cloud, which discovers and invokes functions over HTTP |

## Entry points

- `.` (`src/index.ts`): the `inngest` client, the `functions` array, the
  logger, and the adapter re-exports.
- `./client` (`src/inngest.ts`): the Inngest client alone.
- `./adapter` (`src/adapter.ts`): `createEventClient`, `createFunction`, and
  `NonRetriableError`, for code that sends events without loading every job.
- `./events` (`src/events.ts`): event names that more than one sender needs.
- `./env-check` (`src/env-check.ts`): the signing-key environment check.

## Rules

- Add a new job to the `functions` array in `src/functions.ts`, or Inngest
  never registers it.
- Every event a job triggers on needs a sender somewhere in `apps/`,
  `packages/`, or `tools/`. `pnpm check:inngest-senders` fails a trigger that
  nothing sends, and CI runs it in the `checks` job.
- A production deploy must not run on a `signkey-test-` signing key.
  `src/env-check.ts` reads the key's prefix at boot, and
  `pnpm inngest:verify` (`tools/scripts/inngest-verify.ts`) also proves the
  event key and the signing key reach the same Inngest environment.
- Import `./adapter`, `./client`, or `./events` from code that only sends an
  event. The package barrel loads every job and its dependencies.
- A job that reads or writes tenant rows runs inside `runInTenantScope`. The
  Neo4j `scopedSession()` throws without one.
- Decrypt a stored connector credential with the adapter its row's `keyId`
  names, never with the write-path adapter (see
  [`@oxagen/crypto`](../crypto/README.md)).

## Tests

```bash
pnpm --filter @oxagen/inngest-functions test:unit src/functions/mandate.expiry.test.ts
```

Tests sit beside their source under `src/` and in
`src/functions/__tests__/`.
