# ADR-031: Platform Storage Ontology — a drift-aware, machine-readable self-model of the platform's storage layer

- **Status:** Accepted (Phase 1); Proposed (Phases 2–4)
- **Date:** 2026-07-13
- **Owners:** database / agent-engine
- **Related:** ADR-021 (inference doctrine — deterministic-before-model,
  determinism ladder), ADR-012 (connector dual-write), ADR-022 / ADR-025
  (capability naming), `packages/database/src/tenant-policy.manifest.ts`
  (RLS source of truth)

## Context

Oxagen spans four stores with strict boundaries (Postgres = transactional
state, ClickHouse = append-only events, Neo4j = graph, blob = binary assets)
across ~21 Postgres domains, plus a registry of ~340 capabilities that read and
write them. That structure is knowable — it is fully determined by committed
artifacts: the Drizzle schema objects, the ClickHouse `schema.sql`, the Neo4j
`schema.cypher`, the `@oxagen/storage` asset kinds, the tenant-policy manifest,
and the capability contracts — **but nothing assembles it into one place.**

Two costs follow from that gap:

1. **Agents have no self-model of the platform's own storage.** The graph
   grounds agents in *customer* data (ADR-012, the ontology), but when an agent
   (or a human via the agent) asks "where does billing data live, and which
   capabilities write it?", there is no grounded, citable answer — only whatever
   the model half-remembers from training. That is exactly the failure mode the
   knowledge graph exists to prevent, applied to the platform itself.
2. **Storage drift is invisible until it breaks something.** A new table, a
   renamed column, a capability whose declared domain no longer matches where it
   writes — these drift silently between the four stores and the code that
   assumes their shape. There is no single artifact a CI check can diff against
   to catch it.

Per ADR-021's determinism ladder, this is a **rung-1/rung-2 problem** (a pure
function over committed inputs, then an index lookup) that today gets answered,
badly, at rung 5 (a frontier model guessing). The fix is to compute the
self-model deterministically and make it the grounded source.

## Decision

Introduce the **Platform Storage Ontology (PSO)**: a deterministic,
content-addressed model of the platform's entire storage layer — by domain,
across all four stores, with the capabilities that operate on each table — built
in four phases. Phase 1 (this ADR, Accepted) ships the manifest generator.
Phases 2–4 (Proposed) materialize it as first-class `:Platform*` graph nodes and
wire the three-tier agent consumption path.

### Phase 1 — the storage manifest (Accepted, shipped)

A generator at `packages/database/src/storage-manifest/` introspects every
input **deterministically, with no live database**, and emits a single canonical
JSON artifact, `packages/database/storage-manifest.json`:

- **Postgres** — the Drizzle schema objects, via `getTableConfig()`: table name,
  pg schema (= domain), columns (name / SQL type / nullability / primary key),
  and foreign keys resolved to target table ids. Tenant-scoping and the RLS
  policy class are joined from `tenant-policy.manifest.ts` (the repo's own source
  of truth for which owned table gets which policy) — not re-derived.
- **ClickHouse** — a small, paren-depth-aware `CREATE TABLE` parser over
  `packages/telemetry/src/schema.sql` (the canonical desired-state baseline that
  `migrate.ts` re-applies before the numbered delta migrations): columns, engine,
  `PARTITION BY`, `ORDER BY`, and `TTL`.
- **Neo4j** — a parser over `packages/ontology/src/schema.cypher` extracting node
  labels, their key/indexed properties, and their constraint / index / vector-index
  inventory (the trailing `MATCH … SET` relabel/backfill statements are data
  migrations, not schema, and are ignored).
- **Blob** — an explicit, hand-verified asset-kind → referencing-Postgres-table
  map (the `content.generated_assets` private-media family and the public
  `avatar` family), grounded in the `generated_assets.kind` CHECK constraint and
  the `avatar_url` columns. Documented in `sources/blob.ts`; a test keeps it in
  sync with the CHECK constraint.
- **Capabilities** — the **live registry**: importing `@oxagen/oxagen/contracts`
  self-registers every contract, and `listCapabilities()` returns them. We import
  only the `contracts` + `registry` subpaths (never the package root or
  `/kernel`, which import `@oxagen/database` and would form a require cycle).
  Each capability records its name, domain, and surfaces. `reads`/`writes` are
  **best-effort**, derived only from the contract's `produces`/`consumes` data
  tags via a small explicit tag→table map; where a tag has no known table, the
  arrays stay empty. **The generator never guesses a table from a capability
  name** — full read/write extraction (handler-body scanning) is deferred to a
  later phase.

**Determinism is a hard requirement.** A canonical serializer sorts object keys
at every level (arrays are sorted by the generator where order is not semantic),
and the manifest carries **no timestamps**. The `contentHash` is a sha256 over
the canonical body with the hash field excluded, so identical committed inputs
always produce byte-identical output. `pnpm schema:manifest` writes the file;
`pnpm schema:manifest --check` regenerates in memory and exits non-zero with a
diff summary if the committed file is stale — the CI drift gate. (`biome.json`
excludes the manifest so Biome's JSON array-collapse cannot fight the canonical
serializer.)

Manifest shape (abridged):

```jsonc
{
  "version": 1,
  "contentHash": "<sha256 of the canonical body>",
  "stores":   [{ "kind": "postgres", "purpose": "…", "domains": [], "tableCount": 121 }],
  "domains":  [{ "name": "billing", "stores": ["clickhouse", "postgres"], "tables": [] }],
  "tables":   [{ "id": "postgres:billing.invoices", "store": "postgres",
                 "domain": "billing", "tenantScoped": true, "rls": "org_only",
                 "columns": [{ "name": "id", "type": "uuid", "nullable": false,
                               "primaryKey": true }] }],
  "capabilities": [{ "name": "billing.invoice.get", "domain": "billing",
                     "surfaces": ["api", "mcp"], "reads": [], "writes": [] }]
}
```

This manifest is **independently valuable now**, before any later phase: it is a
drift-aware, machine-readable inventory of the platform's storage that CI diffs
on every PR and that any tool can consume.

### Phase 2 — materialize as `:Platform*` graph nodes (Proposed)

Project the manifest into Neo4j as first-class, **platform-scoped** graph nodes
so the same `ontology.*` query layer that grounds agents in customer data also
grounds them in the platform's own structure:

- **Node labels:** `:PlatformDomain`, `:PlatformStore`, `:PlatformTable`,
  `:PlatformColumn`, `:PlatformCapability`.
- **Edges:** `(:PlatformTable)-[:IN_DOMAIN]->(:PlatformDomain)`,
  `(:PlatformTable)-[:STORED_IN]->(:PlatformStore)`,
  `(:PlatformColumn)-[:COLUMN_OF]->(:PlatformTable)`,
  `(:PlatformColumn)-[:REFERENCES]->(:PlatformTable)` (foreign keys),
  `(:PlatformCapability)-[:READS]->(:PlatformTable)`,
  `(:PlatformCapability)-[:WRITES]->(:PlatformTable)`, and
  `(:PlatformTable)-[:PROJECTS_FROM]->(:PlatformTable)` for cross-store mirrors
  (e.g. the ClickHouse analytics mirror of a Postgres table).
- **Bi-temporal + system-flagged:** every node/edge carries `is_system = true`
  and bi-temporal validity (valid-time / transaction-time) so the platform model
  time-travels exactly like the rest of the graph and is never confused with customer ontology nodes (the `:GraphNode` anchor +
  `is_system` convention already in `schema.cypher`).
- **Reserved `platform` scope:** these nodes live under a reserved platform
  org/workspace scope, not any tenant's, so tenant queries never see them and a
  platform-model write can never leak into customer data.

The projector is idempotent and keyed on `contentHash`: it re-projects only when
the manifest changes, so the graph is a pure downstream materialization of the
Phase-1 artifact.

### Phase 3 — three-tier agent consumption (Proposed)

Expose the model to agents along a strict cost gradient, mirroring the
`CONTEXT_ENGINE_SPEC` per-turn budget discipline and ADR-021's cache stability:

- **Tier 0 — cache-stable domain index (~300 tokens, in the system prompt).**
  A tiny, prefix-stable summary — the domain list with each domain's stores and
  table counts — injected into the immutable system-prompt block. It changes only
  when the manifest's `contentHash` changes, so it does not break the KV cache
  turn to turn. This alone lets an agent answer "which domains exist and where
  they live" with zero tool calls.
- **Tier 1 — `platform.schema.describe` (budgeted domain packs).** A capability
  that returns a token-budgeted pack for a named domain (its tables, columns,
  RLS, and operating capabilities) straight from the manifest — a rung-2 index
  lookup, no model, no graph traversal.
- **Tier 2 — `ontology.query` traversal.** For open-ended structural questions
  ("what writes `billing.invoices`, and what reads what it produces?"), the agent
  traverses the `:Platform*` subgraph through the existing `ontology.query`
  contract — the same grounded, cited path used for customer data.

An agent climbs tiers only as the question demands, so the common case
(Tier 0) costs nothing and the expensive case (Tier 2) is reserved for genuine
graph traversal — the determinism ladder applied to platform self-knowledge.

### Phase 4 — drift enforcement + lineage (Proposed)

Promote `--check` from an advisory drift gate to a lineage-aware one: diff the
new manifest against the committed one and the projected graph, classify changes
(added/removed/renamed table, column, capability edge), and surface them as a
structured changelog for review — turning silent storage drift into an explicit,
diffable event.

## Consequences

- The platform gains a single, deterministic, content-addressed source of truth
  for its storage layer, diffed by CI on every PR (Phase 1, now). Storage drift
  becomes a failing check instead of a latent surprise.
- Agents get a grounded, citable self-model of where data lives and which
  capabilities touch it (Phases 2–3), answered on the same determinism ladder as
  every other Oxagen inference — cheaply at Tier 0, by graph traversal only when
  the question needs it.
- The manifest is a pure function of committed artifacts, so it never needs a
  live database and never drifts from the code: the code IS its input. The cost
  is that each input parser (ClickHouse DDL, Neo4j cypher) must track its source
  file's format; both are small and unit-tested against real fixtures.
- `reads`/`writes` are deliberately sparse in Phase 1 (only where a contract
  declares data tags). This is honest under-reporting rather than confident
  wrong-reporting — later phases fill it in from handler scanning without ever
  having shipped a hallucinated mapping.
- Adding `@oxagen/oxagen` as a dependency of `@oxagen/database` is safe only
  because the generator imports the `contracts` + `registry` subpaths, which do
  not import `@oxagen/database`. A future import of the package root or `/kernel`
  from this package would reintroduce a require cycle; the import site documents
  this constraint.
