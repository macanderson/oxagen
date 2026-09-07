# ADR-042: Organisation-scoped data planes — every store switches at the tenant

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** ADR-031 (platform storage ontology), `docs/specs/tenancy-rls/`,
  ADR-043, `oxagen-tenancy` skill

## Context

Enterprise and regulated customers (HIPAA, data-residency, air-gapped
networks) will not let their agents' traces, ontology, or memory leave a
network they control. Today every store is a process-wide singleton bound
to one connection string: `DATABASE_URL`, `NEO4J_URI`, `CLICKHOUSE_URL`. The
tenant boundary is enforced *inside* one Postgres (RLS GUCs), one Neo4j
(scoped sessions), one ClickHouse (`org_id` guard) — good isolation, wrong
topology for a customer whose firewall is the boundary.

Oxagen calls tenants *organisations*. The binding therefore belongs on the
organisation, never on the workspace and never on the request.

## Decision

1. **A data plane is an organisation-level binding of the three stores.**
   `org.data_planes` holds, per organisation and per store kind
   (`postgres` | `neo4j` | `clickhouse`), an encrypted connection
   configuration (KMS-enveloped with the same `@oxagen/crypto` envelope the
   credential vault uses), a `mode` (`shared` — the platform default plane;
   `dedicated` — a customer-controlled endpoint), and health/rotation
   metadata. Absence of a row means the shared plane.
2. **The tenant scope resolves the plane, not the caller.** The three
   clients (`@oxagen/database`, `@oxagen/ontology`, `@oxagen/telemetry`)
   gain a `resolveDataPlane(orgId, kind)` seam consulted by
   `withTenantDb`, `scopedSession`, and `chInsert`/`chSelect`. Callers
   never pass a connection; they run inside `runInTenantScope` exactly as
   today. Dedicated planes are pooled per organisation and evicted on
   rotation. `withSystemDb` and platform-level tables (billing, IAM, auth,
   org, plugin catalog) always live on the shared plane — a dedicated plane
   carries only tenant *data*: traces, evidence, graph, memory, context
   records, conversations, ingestion state.
3. **Migrations run per plane.** The Atlas migration set is applied to
   every dedicated Postgres plane by the same `db:migrate` pipeline; the
   ClickHouse and Neo4j schema runners iterate planes the same way. A
   plane whose schema version lags the platform is marked `degraded` and
   its organisation's scoped writes fail closed with a typed error.
4. **The binding is governed like everything else.** `get_data_plane` /
   `set_data_plane` are capabilities (org Owner/Admin, `sensitivity: high`,
   `requiresApproval: true`), audited as security events; the raw DSN is
   never returned by any read capability.

## Consequences

- The first slice ships the table, the encrypted binding, the resolver
  seam with the shared plane as the only mode that is exercised end to end,
  and the two capabilities. Dedicated-plane pooling and per-plane migration
  runners follow as their own bodies of work, in this order, because the
  resolver is the seam every later piece plugs into.
- Cross-organisation Postgres queries become impossible by construction on
  dedicated planes, which is the desired property; anything that still
  wants one (platform analytics) must read the shared plane's mirrors.
- The `oxagen-tenancy` skill and `eslint.tenancy-seams.mjs` are extended so
  the resolver is the only place a connection string is ever read.

## Alternatives considered

- **Per-workspace planes.** Rejected: the customer's firewall is an
  organisation property; workspaces are a product-level partition inside
  it. Workspace-level binding would multiply pools and complicate
  organisation-wide audit.
- **Self-hosting the whole platform per customer instead.** Compatible but
  not sufficient: a hosted control plane with a customer-controlled data
  plane is what most enterprise buyers ask for first.
