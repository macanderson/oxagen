# MCP as Connected Source (Feasibility)

Archived spec & plan — status: not started (audited 2026-07-03).

> **Status: Not started** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The feasibility memo proposes three bounded builds to enable MCP servers as a connector delivery method: a `mcp_tool` DeliveryMethod, a manifest→schema-registry bridge contract (`schema.import.fromConnector`), and a live-fetch contract (`graph.node.enrich`). None of these have been implemented. The codebase shows no deliverables from the recommended phased approach.

**Known gaps at time of archive**

- DeliveryMethod enum missing `mcp_tool` variant (packages/ingestion/src/connectors/types.ts)
- schema.import.fromConnector contract (would be packages/oxagen/src/contracts/schema.import.*.ts)
- graph.node.enrich contract and handler (would be packages/oxagen/src/contracts/graph.node.enrich.ts + packages/handlers/src/graph.node.enrich.ts)
- MCP tool binding blocks in connector manifests (e.g., Linear schema.yaml)
- Ingestion pipeline MCP poller integration (packages/inngest-functions/src/functions/ingestion.pipeline.ts)
- Database schema for mcp-tool delivery method configuration

**Source documents** (archived verbatim below)

- `docs/superpowers/specs/2026-06-24-mcp-as-connected-source-feasibility.md`

## Document — `2026-06-24-mcp-as-connected-source-feasibility.md`

## Feasibility Memo — Connecting Any External System (Linear / Jira / Salesforce + MCP servers as a data source)

**Date:** 2026-06-24
**Status:** Feasibility memo (no decision recorded yet; pre-ADR)
**Author:** Claude (with Mac Anderson)
**Scope:** How to integrate arbitrary external systems as connected data sources, and whether MCP servers can be a first-class *connector type* whose search/fetch tools drive scheduled ingestion + live retrieval into the knowledge graph.

---

### 1. Verdict

**Feasible, and ~80% of the primitives already exist in production.** The elegant general design is **not** "build a million integrations" and **not** "throw away connectors for MCP." It is:

> **One connector framework, three delivery tiers, with MCP as the long-tail unlock — and the connector manifest as the single source of truth that feeds the production schema registry.**

The three net-new builds are small and well-bounded:

1. **`mcp_tool` delivery method** — a generic, manifest-driven poller that calls a registered MCP server's `list_*`/`search_*`/`get_*` tools and feeds outputs into the *existing* ingestion pipeline.
2. **Manifest → schema-registry bridge** — let a connector manifest ship a *suggested* schema (labels/reltypes/typed properties) that registers into the shipped schema registry as `source='connector'`, **born disabled**, adopted by the customer via the existing `schema.toggle`.
3. **Live fetch / `graph.node.enrich`** — an on-demand path that calls the same MCP `get_*` tool through the existing MCP client + consent gate, validates against the pinned schema, and optionally TTL-caches.

Everything else — auth, consent, tool discovery + JSON-Schema snapshots, the 6-stage ingestion pipeline, dedup, embeddings, inference, the versioned/opt-in schema registry, conformance enforcement — is already built and in production.

---

### 2. The core architectural insight

Two production subsystems sit on either side of this idea and just need a bridge:

| Subsystem | What it is | Built for | Key code |
|---|---|---|---|
| **Ingestion connector framework** | Manifest YAML (`ConnectorPlugin`, `recordTypes`, `defaultFieldMappings`) → `ingestion.source_connections` → 6-stage pipeline (normalize → map → dedup → embed → infer → graph) | Webhook / REST-polling sources | `packages/ingestion/src/connectors/*`, `packages/ingestion/src/pipeline.ts`, `connector-schema-loader.ts` |
| **External-MCP framework** | `agent.mcp.register` → health probe → **tool discovery** → **JSON-Schema tool snapshots** → **consent gate** → agent-runtime tool invocation | Agent *tool use* during a conversation | `packages/agent/src/handlers/agent.mcp.register.ts`, `packages/agent/src/dispatch/mcp-client.ts`, `mcp.tool_snapshots`, `mcp.consents`, `mcp.credentials` |

The connector framework already abstracts **`DeliveryMethod`** (`webhook | rest_polling | graphql_polling | sql_query | … | cdc`). **MCP becomes one more delivery method.** Instead of a webhook handler or a hand-written REST poller, the "poller" for an MCP source is *"call these declared tools with these param templates on this schedule, page the results, and emit `NormalizedRecord`s into the same pipeline GitHub uses."*

That is the whole trick. Once a record enters the pipeline as a `NormalizedRecord`, it flows through **identical** dedup → embed → infer → graph machinery regardless of whether it came from a GitHub webhook or a Linear MCP `list_issues` call.

---

### 3. Why a *delivery method*, not a parallel system

Strong recommendation: build MCP ingestion **inside** the connector framework as a new `DeliveryMethod`, **not** as a separate "MCP data source" subsystem. This is the YAGNI-correct, no-drift answer.

Reusing the framework gives us, for free:
- `ingestion.source_connections` (status, cursor, health, entity count) — the operational record.
- `ingestion.entity_type_mappings` — source-record-type → oxagen-entity-type + property mappings.
- The whole pipeline: normalization filters, dedup via natural key + embedding similarity, embeddings on `:EntityNode`, semantic inference, provenance edges (`SOURCED_FROM`, `ALIAS_OF`, `INFERRED_FROM`).
- The schema registry, conformance enforcement (strict/lenient/off), and conformance telemetry.
- The dynamic config form (`plugin.schema.get`) and validation (`plugin.schema.validate`).

The **only** genuinely new surface is *how records are fetched*. Everything downstream is shared. This matches the standing principles: *solve once / no dead code*, *no drift across surfaces*, *connector dual-write* (Postgres operational record + Neo4j graph index).

---

### 4. The three delivery tiers (answering "million integrations vs. one elegant thing")

It is a **spectrum**, chosen per source by ROI — not an either/or:

| Tier | What | Fidelity | Real-time? | Authoring cost | Use for |
|---|---|---|---|---|---|
| **1 — Native code connector** | Hand-written `ConnectorDefinition` (TypeScript), webhooks for push | Deepest (custom normalize, webhook events, signature verify) | ✅ webhooks | High (code + tests per source) | The handful of highest-value sources where real-time + deep mapping pays for itself (GitHub today) |
| **2 — MCP-backed manifest connector** *(new)* | Zero-code; manifest declares which MCP tools = which record types, param/pagination/cursor strategy, field mappings | Good (bounded by what the MCP server exposes) | ❌ poll-only + live-fetch | **Low (YAML only)** | The long tail: Jira, Salesforce, Notion, anything with an MCP server |
| **3 — Generic REST/GraphQL manifest connector** | Manifest declares HTTP endpoints + pagination instead of MCP tools (the existing `custom-*` connectors point this way) | Good | ❌ poll-only | Low–medium | Sources with an API but no MCP server |

**MCP is the Tier-2 unlock that makes "connect to anything" real.** You write native code only where it earns its keep; everything else is a manifest.

**Jira & Salesforce specifically:** both already have MCP servers (Atlassian's official MCP; Salesforce official/community MCP), so both can be **Tier 2 on day one** — and promoted to Tier 1 later only if depth/real-time demands it. (Linear, too — this very session has `list_issues`, `get_issue`, `list_projects`, … available, which is exactly the shape Tier 2 consumes.)

---

### 5. Schema-registry compatibility (the explicit constraint)

**Requirement (verbatim intent):** *"Suggested schemas ship inside the connector manifest but are compatible with the schema registry — customers choose to adopt the schemas or not, and what they want ingested."*

The shipped schema registry (PR #150, `packages/database/src/schema/schema-registry.ts`) already has **exactly** the right primitives:

- **`schema_registry.schemas`** has `source ∈ {user, connector, recommended}` and `connectorId` — *purpose-built for connector-contributed schemas.*
- **Typed structure:** `node_labels` (with `naturalKeyProps`), `relationship_types` (`startLabel`/`endLabel`/`cardinality`), `properties` (typed `dataType` + `constraints`, XOR-owned by a label or reltype).
- **Versioned + immutable:** `schema_versions` (draft → published, `parentVersionId` lineage); workspace pins one version.
- **Adoption is already a first-class concept:** `schema_registry.schema_activations` keys on a *stable* `schemaName` with an `enabled` boolean; `schema.toggle` flips it (auto-publishes + auto-pins). Toggling does **not** fork the schema — it just flips the bit.
- **Suggestion already exists:** `schema.recommend` proposes schemas transiently from sampled graph data.
- **Enforcement already exists:** pinned-schema validation at `upsert-entity.ts` with `strict | lenient | off` modes + conformance telemetry to ClickHouse.

**The missing bridge (Build #2).** Today the connector manifest YAML and the Postgres schema registry are **two separate systems**. The manifest's `recordTypes` + `defaultFieldMappings` are *not* auto-registered as schemas. To satisfy the requirement, extend the manifest with a **suggested-schema block** (the same label/reltype/typed-property shape the registry uses) and add a contract:

```
schema.import.fromConnector(connectorId)  →  writes the manifest's suggested schema into the
                                              workspace's DRAFT registry version as
                                              source='connector', connectorId=<id>,
                                              BORN DISABLED (override the connector-default-enabled
                                              rule so adoption stays opt-in).
```

This makes the manifest the **single source of truth** feeding three consumers:
1. the connection config form (`plugin.schema.get` — already wired),
2. the **suggested schema** in the registry (new bridge, born-disabled),
3. the ingestion field mappings (`defaultFieldMappings` → `entity_type_mappings` — already wired).

**"What they want ingested"** maps cleanly onto existing mechanics: the customer enables specific schemas (`schema.toggle`) and selects which record types to sync (manifest `recordTypes.defaultEnabled` + the connection's mapping selection). Nothing the customer didn't opt into gets written; with `enforcementMode='strict'` on the pinned version, non-conformant payloads are rejected and recorded as conformance events.

> **Note / minor inconsistency to resolve in design:** connector-sourced schemas currently default `enabled=true`. The opt-in requirement means manifest-imported schemas should be **born disabled** (or imported as `source='recommended'`, which is already born-disabled). Pick one explicitly in the design phase.

---

### 6. Materialize + live (the chosen "both" mode)

Both modes call the **same MCP tools via the same client + consent gate**; they differ only in *trigger* and *persistence*:

- **Materialize (scheduled, persisted).** An Inngest-scheduled job runs the `mcp_tool` poller: for each enabled record type, call the bound `list_*`/`search_*` tool, page through results (manifest-declared pagination), `normalizeRecord()` each item via the manifest field mappings, and emit into `ingestion/entity.received`. From there the existing pipeline materializes typed `:EntityNode`s, embeddings, and inferred edges. This powers NL graph search (`graph.node.search`), offline coverage, and relationship inference.
- **Live fallback (query-time, optional cache).** New `graph.node.enrich` (Build #3): on cache-miss / detail-fetch / explicit "refresh," call the bound `get_*` tool through `mcp-client.ts` (`connectMcp` → `callTool`) behind the existing `agent.mcp.consent` gate, validate the returned properties against the pinned schema, return enriched properties, and optionally write a short-TTL cache row. This gives freshness on demand without webhooks.

**Why both is the right call here:** materialization is what makes the data *searchable, related, and offline*; live fetch is what keeps *hot/volatile fields fresh* and fills *long-tail records you never bulk-ingested*. A per-label `fetchMode ∈ {materialized, live, hybrid}` hint in the schema metadata lets each entity type choose its strategy.

---

### 7. Feasibility scorecard

| Capability | Exists today? | Gap / build |
|---|---|---|
| Generic connector abstraction (`DeliveryMethod`, `ConnectorDefinition`) | ✅ | — |
| Manifest schema + dynamic config form (`plugin.schema.get/validate`) | ✅ | — |
| Versioned, opt-in, typed **schema registry** | ✅ (PR #150, prod) | — |
| External MCP register + tool discovery + **JSON-Schema snapshots** | ✅ | — |
| MCP **consent** + encrypted **credentials/auth** | ✅ | — |
| 6-stage ingestion pipeline (normalize→map→dedup→embed→infer→graph) | ✅ | — |
| Conformance enforcement (strict/lenient/off) + telemetry | ✅ | — |
| **MCP as a delivery method** (manifest-driven poll over tools) | ❌ | **Build #1** — `mcp_tool` DeliveryMethod + generic poller + manifest tool-binding block |
| **Manifest → schema-registry bridge** (suggested, opt-in, born-disabled) | ❌ | **Build #2** — suggested-schema block in manifest + `schema.import.fromConnector` |
| **Live fetch / enrich** at query time | ❌ | **Build #3** — `graph.node.enrich` via mcp-client + consent + optional TTL cache |
| LLM-assisted auto-mapping from tool JSON-Schema + samples | ◑ partial | Reuse `connection.mappings.suggest`; generalize to MCP tool outputs |
| Incremental cursor for tools lacking "changed-since" | ◑ partial | Declare cursor strategy per tool in manifest; full-scan fallback |

---

### 8. The honest feasibility risks (the part that determines real success)

MCP tools were designed for **interactive** agent use, not **bulk** ingestion. The risks below are why this is a *delivery method with declared strategies*, not a magic "point at any MCP server" button.

1. **Enumeration vs. search.** Ingesting "everything" needs a `list_*`/paginate affordance, not just `search(query)`. Well-built servers have it (Linear MCP exposes `list_issues`, `list_projects`, `list_cycles`, …). Thin servers expose only search → fall back to **query-scoped periodic refresh** ("watch these saved queries"), which is great for monitoring but **not** a full historical backfill. *The manifest must declare, per record type, whether an enumeration tool exists.*
2. **No incremental signal.** If a tool can't filter by `updatedAt`/`since`, every sync re-reads the whole bounded set. Fine for small/bounded sources; expensive for large ones. Manifest declares the incremental strategy; cap with Inngest concurrency + interval + per-source budget.
3. **No inbound webhooks → poll-only.** Freshness is bounded by the poll interval. The live-fetch path (Build #3) mitigates for on-demand freshness on hot records.
4. **Loosely-typed outputs / schema drift.** Tool outputs are JSON/text and may drift from the declared JSON-Schema snapshot. The captured snapshot enables auto-mapping, but production needs the conformance telemetry (already shipped) to catch drift, plus LLM-assisted re-mapping.
5. **Rate limits & cost.** Each sync = N tool calls; large fan-outs can hit provider limits or burn tokens (some MCP servers are LLM-backed). Reuse the pipeline's per-org Inngest concurrency caps; add a per-source call budget + backoff.
6. **Pagination contract variance.** cursor vs. offset vs. page-token vs. none. The manifest binding must support multiple pagination shapes (declare `paginationStyle` + the response path to the next cursor).
7. **Identity / idempotency.** Non-deterministic ordering is fine (dedup keys on natural key), but cursor checkpointing must be resilient to partial failures and re-runs.
8. **Auth lifetime.** MCP server tokens (the customer's Linear/Jira token) expire; reuse `mcp.credentials` + the OAuth refresh path. A dead token must surface as `source_connections.status='error'`, not a silent empty sync.

**Bottom line on risk:** for MCP servers that expose proper `list_*` + `updated-since` + pagination, Tier-2 ingestion is robust. For thin search-only servers, set expectations: it's a *query-watcher*, not a *warehouse loader*. The manifest makes this explicit per source rather than failing silently.

---

### 9. Recommended phasing (smallest path to proving feasibility)

- **Phase 0 — Proof (1 source, 1 server).** Add `mcp_tool` DeliveryMethod + a minimal manifest tool-binding for **Linear's MCP** (`list_issues` → `issue` record type, `get_issue` for detail). Scheduled poll → existing pipeline → graph. Manually create/enable the schema via the existing `schema.toggle`. *Proves the bridge end-to-end with real data.*
- **Phase 1 — Schema bridge.** Manifest suggested-schema block + `schema.import.fromConnector` (born-disabled, opt-in). Closes the "compatible with the schema registry" loop.
- **Phase 2 — Live fetch.** `graph.node.enrich` (cache-miss + detail-fetch + refresh), short-TTL cache, behind consent.
- **Phase 3 — Generalize.** LLM-assisted auto-mapping from JSON-Schema snapshot + samples (reuse `connection.mappings.suggest`); multiple pagination/cursor strategies; onboard Jira + Salesforce MCP; document the manifest authoring path (pairs with the `knowledge-source-author` agent).

---

### 10. Key files (for whoever picks this up)

**Connector framework / ingestion**
- `packages/ingestion/src/connectors/types.ts` — `ConnectorDefinition`, `AuthScheme`, `DeliveryMethod` (← add `mcp_tool`)
- `packages/ingestion/src/pipeline.ts` — the 6-stage pipeline (unchanged; MCP records enter here)
- `packages/ingestion/src/connector-schema-loader.ts` — manifest YAML loader
- `packages/ingestion/src/connectors/linear/schema.yaml` — manifest example (← add suggested-schema + mcp-binding blocks)
- `packages/ingestion/src/mutations/upsert-entity.ts` — pinned-schema validation/enforcement
- `packages/inngest-functions/src/functions/ingestion.pipeline.ts` — the materialization job (← schedule the mcp poller alongside)

**External MCP (reused by both materialize + live)**
- `packages/agent/src/dispatch/mcp-client.ts` — `connectMcp` / `listMcpTools` / `callTool`
- `packages/agent/src/handlers/agent.mcp.register.ts` — register + discover + snapshot
- `packages/database/src/schema/mcp.ts` — `mcp_servers`, `tool_snapshots`, `consents`, `credentials`
- `packages/oxagen/src/contracts/agent.mcp.consent.resolve.ts` — first-use consent gate

**Schema registry (the adoption surface)**
- `packages/database/src/schema/schema-registry.ts` — 7 tables (registries, schema_versions, schemas, schema_activations, node_labels, relationship_types, properties)
- `packages/oxagen/src/contracts/schema.toggle.ts` — adoption (enable/disable, auto-publish+pin)
- `packages/oxagen/src/contracts/schema.recommend.ts` — transient suggestions
- `packages/handlers/src/schema.*.ts` — registry handlers

**Live retrieval (today: in-graph only)**
- `packages/handlers/src/graph.node.search.ts` — NL search over pre-materialized `:KnowledgeNode`s (← live fetch is net-new)

---

### 11. Net recommendation

Build the three bounded pieces (mcp_tool delivery method, manifest→registry bridge, live enrich) on top of the existing framework. Treat MCP as **Tier 2** of a three-tier connector spectrum, reserve native code for the few sources that earn it, and make every source's ingestion strategy **explicit in its manifest** so the search-only-vs-enumerable limitation is a declared capability, not a silent failure. This delivers "connect to anything a business uses" without a million bespoke integrations, and it plugs directly into the schema registry you already shipped — customers adopt suggested schemas and choose what to ingest using mechanics that are already live.

