# @oxagen/ontology

The Neo4j graph client for tenant data: the tenant-scoped session every graph
query runs through, the Cypher guards behind it, per-organization graph
database provisioning, and the Neo4j schema migration.

## Boundary

- **Owns:**
  - `scopedSession()`, the only sanctioned way to query tenant graph data
    (`src/tenant.ts`).
  - The Cypher guards that session applies: the tenant-anchor check, read-only
    enforcement, graph-scope label and relationship filters, and `LIMIT` and
    hop clamps (`src/graph-scope.ts`).
  - The process-wide Neo4j driver and the pooled-database session
    (`src/client.ts`), plus the driver cache for organizations on a dedicated
    plane (`src/data-plane-driver.ts`).
  - Per-organization graph databases: naming, listing, and the pooled, Cypher,
    and Aura provisioners (`src/org-graph.ts`, `src/provision.ts`).
  - Label and relationship-type sanitizing (`src/labels.ts`), edge validity
    windows (`src/temporal.ts`), and vector search oversampling (`src/ann.ts`).
  - The Neo4j schema (`src/schema.cypher`) and its migration runner
    (`src/migrate.ts`).
- **Does not own:**
  - Which data plane an organization uses: [`@oxagen/tenancy`](../tenancy/README.md)
    (`resolveDataPlane`, ADR-042).
  - Capability contracts for graph reads: [`@oxagen/oxagen`](../oxagen/README.md).
  - The handlers that run graph queries: [`@oxagen/handlers`](../handlers/README.md).
  - Writing connector entities into the graph:
    [`@oxagen/ingestion`](../ingestion/README.md) and
    [`@oxagen/inngest-functions`](../inngest-functions/README.md).
  - Transactional state, which stays in Postgres:
    [`@oxagen/database`](../database/README.md).
- **Depends on:**
  - `@oxagen/tenancy`: `requireScope` for the active tenant and
    `resolveDataPlane` for where that tenant's graph lives.
  - `@oxagen/config`: `requireEnv` for `NEO4J_URI`, `NEO4J_USERNAME`,
    `NEO4J_PASSWORD`, and `NEO4J_DATABASE`.
  - `@oxagen/telemetry`: the Neo4j circuit breaker and the direct-run check
    for the migration script.
- **Used by:** `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/handlers`,
  `@oxagen/ingestion`, `@oxagen/inngest-functions`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `scopedSession()` | export | `packages/ontology/src/tenant.ts` | Graph handlers in `packages/handlers/src/` (for example `graph.search.ts`) and jobs in `packages/inngest-functions/src/functions/` |
| Ban on raw `session` / `driver` | boundary | `eslint.tenancy-seams.mjs` | `eslint.config.mjs`, `eslint.next.mjs`, `apps/app/eslint.config.mjs` |
| `OrgGraphProvisioner` | port | `packages/ontology/src/provision.ts` | Implemented by the pooled, Cypher, and Aura provisioners in the same file |
| `provisionOrgGraph` | export | `packages/ontology/src/provision.ts` | `packages/handlers/src/org.create.ts`, inside the organization-create transaction |
| `migrateEveryGraphDatabase` | export | `packages/ontology/src/migrate.ts` | `tools/scripts/db-migrate.ts`, which `pnpm db:migrate` and the `migration-gate` CI job run |
| Neo4j network boundary | boundary | `packages/ontology/src/client.ts` | `NEO4J_URI` and its credentials |

## Entry points

- `.` (`src/index.ts`): `scopedSession`, the client, labels, types,
  `migrateNeo4j`, the dedicated-driver lifecycle, `GraphScopeError`, ANN
  oversampling, provisioning, and org-graph naming.
- `./tenant` (`src/tenant.ts`): `scopedSession` and `assertAnchorsTenant`.
- `./client` (`src/client.ts`): the driver and raw sessions. Lint bans
  importing `session` and `driver` outside this package.
- `./graph-scope` (`src/graph-scope.ts`): the Cypher scope guards.
- `./labels` (`src/labels.ts`): label and relationship-type sanitizing.
- `./temporal` (`src/temporal.ts`): edge validity Cypher fragments.
- `./ann` (`src/ann.ts`): vector search oversampling limits.
- `./provision` (`src/provision.ts`): organization graph provisioners.
- `./migrate` (`src/migrate.ts`): the schema migration. `pnpm --filter
  @oxagen/ontology migrate` runs it directly.

## Rules

- Tenant graph data is read and written through `scopedSession()`. It throws
  `TenantScopeError` when no tenant scope is active.
- A scoped query must bind `orgId` to the session's own parameter in a
  filtering position. `assertAnchorsTenant` refuses anything else.
- A degraded or disabled dedicated plane throws rather than falling back to the
  platform graph (ADR-042).
- An organization is pooled by default. A provisioned organization gets its
  own `org-<namespace>` database, and a provisioning failure rolls the
  organization back (ADR-098).
- Neo4j holds entities, relationships, lineage, and agent memory. Transactional
  state and counters stay out of it.

## Tests

```bash
pnpm --filter @oxagen/ontology test:unit src/tenant.test.ts
```

Unit tests sit beside their source under `src/`. The cross-tenant probe in
`integration/` needs a live Neo4j and runs with `test:integration` in the CI
`rls-integration` job.
