# @oxagen/ingestion

`@oxagen/ingestion` holds the connector definitions and the pure ingestion stages: normalize a source record, filter it, deduplicate it against the graph, write it to Neo4j, and embed it. The durable jobs that run those stages in production live in `@oxagen/inngest-functions`.

## Boundary

- **Owns:** the connector registry and every built-in connector under `src/connectors/` (GitHub, the Google family, Microsoft, Slack, Linear, Salesforce, Stripe, Zendesk, Zoom, custom SQL, and custom webhook); the delivery-config filters (`src/filters.ts`); entity deduplication (`src/dedup/`); the Neo4j entity and embedding writes (`src/mutations/upsert-entity.ts`); entity embedding (`src/embed/`); sync cursors and backoff (`src/sync/`); workspace schema validation (`src/validate/`); and the connector schema loader.
- **Does not own:** the durable ingestion jobs, webhook provisioning, or polling schedules ([`@oxagen/inngest-functions`](../inngest-functions/README.md)); the webhook HTTP routes (`apps/api/src/routes/v1/webhook.ts`, `github-webhook.ts`); the Postgres `source_connections` record ([`@oxagen/database`](../database/README.md)); connector credentials ([`@oxagen/plugins`](../plugins/README.md)); or the Neo4j driver and tenant session ([`@oxagen/ontology`](../ontology/README.md)).
- **Depends on:**
  - `@oxagen/ai`: `embedText`, so every embedding call is metered.
  - `@oxagen/ontology`: `scopedSession` and label sanitising for Neo4j writes.
  - `@oxagen/telemetry`: `chInsert` for ingestion events in ClickHouse.
  - `@oxagen/glob`: path matching for delivery-config path filters.
- **Used by:** `apps/api`, `apps/app_deprecated`, `@oxagen/handlers`, and `@oxagen/inngest-functions`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `registerConnector` / `getConnector` / `listConnectors` | registry | `packages/ingestion/src/connectors/types.ts` | Each connector module registers itself on import. `src/index.ts` and `src/connectors/index.ts` import every built-in |
| `ConnectorDefinition` | port | `packages/ingestion/src/connectors/types.ts` | Implemented by each connector under `packages/ingestion/src/connectors/` |
| Delivery-config filters | export | `packages/ingestion/src/filters.ts` | `packages/inngest-functions/src/functions/ingestion.pipeline.ts` and `runPipeline` both call them, so filtering has one implementation |
| `resolveEntity`, `upsertEntityNode` | export | `packages/ingestion/src/dedup/resolve.ts`, `packages/ingestion/src/mutations/upsert-entity.ts` | `packages/inngest-functions/src/functions/ingestion.pipeline.ts` |
| Neo4j and ClickHouse writes | boundary | `packages/ingestion/src/mutations/upsert-entity.ts` | Writes go through `scopedSession` (`@oxagen/ontology/tenant`) and `chInsert` (`@oxagen/telemetry`), never a raw driver |
| Connector schema loader | export | `packages/ingestion/src/connector-schema-loader.ts` | `tools/scripts/check-connector-schemas.ts` (`pnpm check:connector-schemas`) and `packages/handlers` |

## Entry points

- `.` (`src/index.ts`): types, `runPipeline`, filters, the connector registry, and a side-effect import of every built-in connector.
- `./connectors` (`src/connectors/index.ts`): the connector registry and built-ins.
- `./connector-schema-loader`: loads a connector's `schema.yaml`.
- `./pipeline`, `./filters`, `./types`: the reference pipeline, filters, and shared types.
- `./embed`, `./mutations`, `./dedup`, `./sync`, `./validate`: the individual stages.

## Rules

- `runPipeline` in `src/pipeline.ts` is the reference implementation, not the production path. Nothing outside this package calls it. Production runs the same stages as Inngest steps in `packages/inngest-functions/src/functions/ingestion.pipeline.ts`.
- The two implementations have drifted. `runPipeline` passes the workspace's pinned schema into the write, and the Inngest function does not, so schema enforcement is inert in production. Fix the Inngest path, or collapse the two, before you rely on schema conformance.
- Re-registering a connector id keeps the first registration. The registry sits on `globalThis` so dev hot reload and Next's module graphs do not register a connector twice.
- Connectors write Postgres first and Neo4j asynchronously through Inngest (ADR-012).

## Tests

```bash
pnpm --filter @oxagen/ingestion test:unit src/pipeline.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`, with some in `src/__tests__/` and `src/connectors/__tests__/`.
