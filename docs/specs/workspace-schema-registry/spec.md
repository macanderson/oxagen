# Workspace Schema Registry — Design Specification

> **Launch-boundary addendum (2026-07-21):** the registry and governed connector
> validation remain. References below to generic graph node/relationship mutation,
> `graph.ingest`, alias shims, or automatic semantic materialization are historical
> implementation detail and must not be restored. Connector ingestion and explicit
> semantic-candidate approval are the shared graph write paths.

## 1. Scope

The Workspace Schema Registry is an AI-assisted schema builder that lets a
workspace define the **node labels** and **relationship types** — with typed,
described, constrained properties — that govern its knowledge graph. It is the
authoritative, queryable contract that tells the ingestion AI *what to collect*
for every node/relationship it creates and *how to validate it* at the property
level. The registry is also the workspace's **single source of truth** for its
label + relationship-type vocabulary (see §1.3 and §7.1): it is authoritative,
not a passive observation of what ingestion happened to see.

This epic delivers:

1. **Authoring surface.** A workspace-settings schema builder where users define
   node labels, relationship types, and their properties (`required?`, data
   type, optional human/AI-authored `description`). Descriptions also exist at
   the label and relationship-type level.
2. **AI onboarding recommender.** On first load, the builder reads the existing
   workspace graph (`graph.stats`, sampled `ontology.query`, and ClickHouse
   observed-label telemetry — see §1.3/§7.1) and proposes a recommended starter
   schema via `@oxagen/ai`. The recommender also reads the workspace's currently
   **enabled schemas** (§1.4) and proposes additions/edits within or alongside
   them, never ignoring what is already configured.
3. **AI chat builder.** An iterative chat surface where the agent asks intent
   questions ("What kind of business are you?", "Do you track customers? source
   code? CRM data? vendors & contracts?") and mutates the draft schema via tool
   calls.
4. **Ingestion grounding + validation.** The pinned schema is fed into the
   ingestion pipeline so extraction prompts are seeded with the label /
   relationship-type / property descriptions and required fields, and so a
   property-level validator runs at write time per a workspace **enforcement
   mode** (`strict` / `lenient` / `off`). Grounding and validation use the
   **active vocabulary** — the union of labels + relationship types across the
   workspace's *enabled* schemas of the pinned version (§1.4).
5. **Versioning, pinning, export.** Immutable version snapshots, a workspace
   version **pin** pointer, version **diff**, and a **download-as-zip** export.
6. **Schemas — composition + enable/disable.** A workspace's registry is composed
   of one or more named **schemas** (label + relationship-type groups). Each
   schema can be independently **enabled or disabled** for the workspace,
   non-destructively (§1.4).
7. **Reconciliation (v2).** On pin change, prompt the user to dispatch async
   workers that re-derive/backfill node & relationship properties on the existing
   Neo4j graph to conform to the newly pinned schema.

Out of scope (v1): GitOps / source-control bidirectional sync (phased to v3);
schema marketplace / sharing across workspaces; automatic schema-drift
detection without a user trigger.

### 1.1 Relationship to existing surfaces (extend, do not duplicate)

- `ingestion.entity_types` (`packages/database/src/schema/ingestion.ts`) today
  records *observed* types per workspace (`commonPropertyKeys`, `expectedEdges`,
  `rowCount`). **This table is being sunset as an authoritative type list**
  (§1.3): the registry becomes the source of truth, and *observation* moves to
  ClickHouse runtime telemetry (`graph_observed_labels`) per the four-store law.
  Existing rows are imported once into the registry as a recommended starter
  schema, then the table is deprecated (§7.1, §10).
- `graph.node.upsert` / `graph.relationship.upsert` / `graph.ingest`
  (`packages/oxagen/src/contracts/`) remain the only graph mutation primitives.
  (`graph.relationship.upsert` is the **v1 rename** of the shipped
  `graph.edge.upsert`; see §1.2 — the old name stays as a one-release deprecation
  alias.) The registry validates their payloads; it does not replace them. **Node
  labels are already free strings** (`graph.node.upsert.ts` → `label:
  z.string().min(1).max(100)`), so nothing prescribes node labels — the registry
  is the validation source when a version is pinned. **Relationship types are
  being un-prescribed in v1** (see §3.2): the fixed `GRAPH_EDGE_TYPES` enum in
  `graph.relationship.upsert.ts` is removed so customers define their own
  relationship types in the registry. The registry's relationship types become
  the workspace-scoped allow-list that ingestion and the ontology query layer
  validate against.
- The schema builder is a sibling surface to the graph explorer at
  `apps/app/src/components/knowledge/graph-explorer/` and the `/explore` page.
  The graph explorer's WebGL **graph canvas / edge** rendering is a visualization
  concern and keeps the word "edge" for drawn connections; the underlying *data*
  is always a **relationship** (§1.2).

### 1.2 Canonical vocabulary (Neo4j-exact, no drift)

This spec and its implementation use **only** the following Neo4j property-graph
terms for graph data. Do not invent or drift to generic graph-theory words for
the data model. ("Entity" / "entity type" / "edge type" are banned for the data
model.)

**Authority (Neo4j official docs).** These terms are exact, not house style. Per
Neo4j *Getting Started — Graph database concepts*
(<https://neo4j.com/docs/getting-started/appendix/graphdb-concepts/>): "A node
represents an entity… nodes are classified by **labels**. A label marks a node as
a member of a named and indexed subset," and "A relationship… [is] classified by
**type**." See also *Getting Started — Data modeling*
(<https://neo4j.com/docs/getting-started/data-modeling/>). We therefore use
**Node Label** / **label** and **Relationship Type** as the canonical terms.

| Canonical term | Meaning | Replaces |
|---|---|---|
| **Node** | A graph vertex. | "entity", "object", "record" (for graph data) |
| **Label** / **Node Label** | A node's type tag; a node may carry several. "Node label" is the qualified form (Neo4j's exact phrasing). | "entity type", "node type" |
| **Relationship** | A directed connection between two nodes (Neo4j's exact word). | "edge" *in prose for the data* (see note) |
| **Relationship Type** | The type/name of a relationship (Neo4j's exact phrasing). | "edge type" |
| **Property** | A key/value on a node or relationship. | "field", "attribute" |
| **Start node / end node** | A relationship's endpoints, Cypher `(start)-[r]->(end)`. | "from"/"to" |

Notes and consequences:

- **"Edge" is retained only for the visualization layer.** The graph explorer's
  WebGL canvas renders "edges"; that is a rendering concept. Whenever we describe
  the *data*, it is a **relationship** / **relationship type**.
- **Endpoint columns/fields are `start_label` / `end_label`.** The registry's
  relationship-type endpoints are named `start_label` (start node label) and
  `end_label` (end node label), matching Cypher `(start)-[r]->(end)`. Contract
  inputs use `startLabel` / `endLabel`.
- **Legacy `*.edge.*` contracts are renamed in v1 (in scope), with a one-release
  deprecation alias.** The user wants "edge type" → "relationship type"
  *everywhere*, including the shipped contracts — so the rename is **v1 scope**,
  not a deferred follow-up:
  - `graph.edge.upsert` → **`graph.relationship.upsert`**
  - `semantic.edge.*` → **`semantic.relationship.*`** (all four
    `semantic.edge.*` capabilities — combined route `semantic-edge.ts` is renamed
    `semantic-relationship.ts`, mounted under both names during the alias window)
  - `graph.ingest`'s edge-type fields → **relationship-type fields**
  To avoid hard-breaking existing callers, each old contract name ships a
  **one-release deprecation alias** that routes to the new contract and emits a
  deprecation note (logged + surfaced in the API/MCP response metadata). The
  aliases are removed one release later (see §14). The pattern constant for the
  Cypher guard is already `RELATIONSHIP_TYPE_PATTERN` (§3.2) and is unchanged.

#### 1.2.1 Core model: the label *is* the node's type (not `:EntityNode {entityType}`)

Today the Neo4j graph uses a single generic **`:EntityNode`** label with an
**`entityType` string property** as a discriminator (see
`packages/ingestion/src/mutations/upsert-entity.ts`: every MERGE is
`(n:EntityNode { … })` with `n.entityType = $entityType`; the relationship
templates `INFERRED_FROM` / `REFERENCES` / `SIMILAR_TO` / `PART_OF` all
`MATCH (…:EntityNode …)`). `graph.node.upsert` already accepts a free-string
`label`.

**The canonical model makes the label itself the node's type** — a customer node
is `:Customer`, a contract node is `:Contract` — **not** `:EntityNode {entityType:
"Customer"}`. The registry and every **new** surface use first-class labels from
day one. See §3.3 for the phased migration of the *physical* Neo4j data and the
ingestion/ontology/explorer code off `:EntityNode {entityType}`.

### 1.3 The registry is authoritative; observation is ClickHouse telemetry

The registry — the authored, versioned, enabled set of labels + relationship
types — is the **single source of truth** for the workspace's graph vocabulary.
Two roles that `ingestion.entity_types` previously conflated are separated:

- **Authored vocabulary (durable, Postgres):** the registry tables (§4). This is
  what ingestion grounds on and validates against, and what the recommender edits.
- **Observed vocabulary (runtime telemetry, ClickHouse):** counts of labels and
  relationship types actually *seen* during ingestion are append-only runtime
  events, which the four-store law places in **ClickHouse**, never durable
  Postgres. A `graph_observed_labels` signal (§4.9), emitted by ingestion, feeds
  the recommender. `ingestion.entity_types` is **sunset** as an authoritative
  list; its observation role moves to ClickHouse (§7.1, §10).

No thin Postgres "entity" cache is retained: live counts come from `graph.stats`
(Neo4j) and `graph_observed_labels` (ClickHouse), so there is no four-store
boundary violation and no "entity"-named Postgres table to keep.

### 1.4 Schemas: composition + non-destructive enable/disable

A workspace's registry is composed of one or more **schemas**. A *schema* here is
a **named group of labels + relationship types** (we reuse the user's word
"schema"; we do **not** invent "module"/"pack"). A schema originates from one of
three sources:

- **`connector`** — contributed by an installed connector / knowledge source via
  its `connector-schema-loader` schema (`packages/ingestion/src/connector-schema-loader.ts`).
- **`user`** — user-authored in the builder.
- **`recommended`** — the AI-recommended starter schema (`schema.recommend`),
  including the one-time import of legacy `entity_types` rows (§7.1, §10).

**Each schema can be independently enabled or disabled for the workspace.**

- **Active vocabulary** = the union of labels + relationship types across the
  workspace's **enabled** schemas of the **pinned** version. Ingestion grounding,
  property validation, the §3.2 relationship-type allow-list, and the recommender
  all operate on the active vocabulary. `getPinnedSchema` (§4.8/§8) resolves to
  the **enabled** subset.
- **Born disabled/draft.** A newly created schema — whether AI-scaffolded from a
  prompt (§2.0, §7.2), recommended (§7.1), or hand-authored — lands in the
  **draft** with `enabled = false` (disabled / unpublished / inactive). It has
  **zero** effect on ingestion grounding or validation until the user activates
  it (next bullet). This is what the north-star "pre-filled properties in a
  disabled/unpublished/inactive state" means.
- **Activation is the go-live trigger — it auto-publishes + auto-pins.** Toggling
  a schema **active** (`schema.toggle enabled=true`) does three things in one
  step: (1) it **publishes** the current draft as a new immutable version *if the
  draft has unpublished edits* (`schema.version.create` semantics), (2) sets the
  schema's `enabled = true` in `schema_activations`, and (3) **pins** the
  resulting published version (`schema.version.pin` semantics) so the schema is
  immediately "ready for use." Deactivating likewise re-pins a published version
  that reflects the new active set. **The user never performs a separate publish
  or pin step** — that is the north-star "inactivating and activating schemas
  would automatically set the schema version pinned and publish the schema ready
  for use." The explicit `schema.version.create` / `schema.version.pin` contracts
  remain for advanced/manual control and are what `schema.toggle` calls
  internally.
- **Non-destructive rule (hard).** Disabling a schema only removes its labels /
  relationship types from the *active vocabulary* (and re-pins accordingly). It
  **never** deletes or orphans existing nodes/relationships in Neo4j — that data
  stays fully queryable. The only destructive path is the separate, explicitly
  Admin-gated reconcile `--prune` (§9); enable/disable never prunes.
- **Definitions immutable; enabled-state is live config (immutability preserved).**
  Schema *definitions* (labels, relationship types, properties) belong to an
  immutable version snapshot — **activation never edits a frozen version**; it
  *freezes the draft into a new version and moves the pin*. *Enabled state* is
  **current workspace config** stored in a separate small current-config table
  keyed by stable schema **identity** (workspace + schema name), not by version
  row, so a schema disabled in version N stays disabled when N+1 publishes (§4.3).
  Net: toggling never mutates a frozen snapshot, but it **does** auto-publish a
  new one and re-pin — the behavior the north-star requires.

## 2. Goals & Acceptance Criteria

### 2.0 North-star user goal (authoritative intent, verbatim)

This is the user's own statement of the flagship flow. Every acceptance
criterion in §2.1 traces back to it; where this prose and the rest of the spec
disagree, **this intent wins** and the spec is reconciled to it (this section
is what drove the §1.4 / §16.8 activation-model refactor below).

> A workspace owner or admin can open settings > knowledge > schema, and enter a
> prompt to an AI assistant in the **AI assistant drawer** to create schemas
> supporting the storing of an ontology of a business in a workspace schema. I
> should be able to enter "Create the schemas necessary to capture the ontology
> of an Enterprise B2B SaaS company including: subscription plans, payments,
> customers, support issues, product bugs, product features, competitors, leads,
> vendors, partners, and employees." And then I should see — after the agent
> processes my request — the schemas supporting this ontology **with pre-filled
> properties in a disabled / unpublished / inactive state**. I should then be
> able to **navigate into any given entity type and change that specific entity
> type's configuration**. Alternatively, I should be able to make edits to my
> schemas by **entering a new prompt that won't wipe out the work of the original
> prompt** and instead modifies what exists already. Additionally, **inactivating
> and activating schemas would automatically set the schema version pinned and
> publish the schema ready for use**. Once I have configured the schema for a
> label / entity type I should also see options to have **worker agents
> dispatched to prune / improve / polish / coerce** the data that exists in the
> graph today into the shape of the newly published / activated schema.

**Vocabulary mapping (do not drift, §1.2).** The user's colloquial "entity type"
is the canonical **node label** in this spec; "schema" is the user's word and is
kept (§1.4). Functionally they are the same things — the implementation uses the
canonical Neo4j terms throughout, and only user-facing help text may echo "entity
type" as a friendly synonym for "node label."

### 2.1 Acceptance criteria

**Two co-equal authoring modes (first-class, neither a fallback).** The schema
builder ships BOTH a complete **traditional form-based UI** — define every node
label, relationship type, and property by hand (criterion 4) — AND an
**agent-assisted setup/config experience** — the AI assistant drawer + recommender
(criteria 1, 3, 5). Neither is secondary: a user can build and maintain the entire
registry **purely by hand**, **purely by prompting the agent**, or by **freely
mixing the two**. Both modes edit the **same shared draft** (§16.3) through the
**same `schema.*` mutation contracts**, so form edits and agent edits interoperate
seamlessly — e.g. scaffold with a prompt, then hand-tune a property in the form;
or hand-build two labels, then ask the agent to fill in the relationships between
them.

The epic is complete when **all** of the following hold:

1. **AI-drawer prompt → multi-schema scaffold, landing disabled/draft.** A
   workspace Owner/Admin opens **Settings → Knowledge → Schema**, opens the **AI
   assistant drawer**, and enters a single natural-language prompt (e.g. the
   B2B-SaaS ontology prompt in §2.0). The agent scaffolds **one or more named
   schemas** with **pre-filled** node labels, relationship types, and typed
   properties — and they all land in a **disabled / unpublished / draft** state
   (no graph impact until activated). The agent's proposed mutations apply via
   `schema.label.upsert` / `schema.relationship.upsert` / `schema.property.upsert`.
2. **Drill into any label and edit it.** From the scaffolded result the user can
   navigate into any individual node label (the user's "entity type") or
   relationship type and change that specific definition — rename, description,
   add/remove/retype properties, `required` flags, start/end-label constraints —
   in the builder (§6).
3. **Additive re-prompting (never wipes).** Entering a **new** prompt in the AI
   assistant drawer **modifies the existing draft additively** — it adds/edits
   labels, relationship types, and properties but **never discards prior work**
   from earlier prompts or manual edits. Verified by a test: prompt B after
   prompt A leaves prompt A's labels intact unless B explicitly changes them.
4. **Full traditional form authoring (co-equal path).** Without ever invoking the
   AI, a user can build and maintain the **entire** registry through the form UI:
   create node labels with N typed properties (each `required`, `dataType`,
   optional `description`), create relationship types with typed properties and
   `startLabel`/`endLabel` constraints, edit or delete any label / relationship /
   property, organize them into schemas, and save to the **draft** — all via the
   same `schema.*` contracts the agent uses. The form builder is a **complete
   authoring surface on its own**, not a fallback to the agent; everything the AI
   drawer can produce is also directly editable by hand.
5. **Graph-derived recommendation.** On first load with an existing graph, the
   builder also offers an AI-recommended starter schema derived from
   `graph.stats` + the `graph_observed_labels` ClickHouse telemetry + sampled
   `ontology.query` (NOT from `entity_types`), which the user can accept, edit, or
   discard.
6. **Activation auto-publishes + auto-pins (ready for use) — no separate
   publish/pin chore.** Toggling a schema **active** automatically (a) publishes
   the current draft as a new immutable version *if it has unpublished edits* and
   (b) **pins** the resulting version to the workspace, so the schema is
   immediately "ready for use" for grounding + validation. Toggling a schema
   **inactive** likewise re-pins a published version reflecting the new active set
   (non-destructive — never deletes graph data). The user performs **no separate**
   `version.create` / `version.pin` step in the common flow; the explicit
   `schema.version.create` / `schema.version.pin` contracts remain for advanced
   manual control, and the user can still **list** and **diff** versions (§1.4,
   §16.8).
7. The user can **export the pinned (or any) version as a ZIP** archive
   (`schema.export`) via the access-controlled assets route.
8. The pinned schema's **active vocabulary** (enabled schemas only) is resolved
   at ingestion time and **seeds the extraction / inference prompt** with label,
   relationship-type, and property descriptions plus required fields, at the seam
   pinned in §8.
9. **Property-level validation** runs in `upsertEntityNode` per the workspace
   enforcement mode against the active vocabulary: `strict` rejects
   non-conforming writes, `lenient` writes-but-scores and emits a telemetry
   event, `off` skips. A **conformance score** (0.0–1.0) is recorded for every
   ingested node/relationship.
10. Every authored mutation flows through `invoke()` and emits metering +
    lineage; every contract has full capability parity (contract → API → MCP →
    docs), verified by `pnpm check:manifest`.
11. **Reconcile offered on activation.** Because activation auto-pins (criterion
    6), once a schema is configured and activated the user is prompted — never
    automatically — to dispatch **worker agents that prune / improve / polish /
    coerce** existing graph data into the newly published/activated schema's
    shape. On confirm, `schema.reconcile.dispatch` queues an Inngest fanout that
    re-derives (improve/polish/coerce) best-effort properties and, opt-in,
    prunes off-schema properties, reporting progress on an `agent_executions` row
    (§4.7, §9 — v2).
12. RLS, org+workspace tenant scoping, and explicit IAM gates at every `apps/app`
    call site are in place; unit coverage meets the package thresholds and the
    **v1 visual gate** (§13: Storybook stories + light/dark screenshots + LLM
    judge) passes for every new component.
13. `GRAPH_EDGE_TYPES` is removed; `graph.relationship.upsert`, `graph.ingest`,
    `ontology.neighbors`, and `ontology.query` accept workspace-defined
    relationship types validated by the lexical guard + pinned registry (active
    vocabulary), with **no Cypher-injection regression** (a test feeds a
    malicious relationship-type string and asserts rejection).
14. `schema.setup` walks a user through recommend → intent chat → apply →
    **activate (auto-publish + auto-pin)** headlessly — and lets the user
    **enable/disable schemas** (`schema.toggle`) as part of the walkthrough;
    and `schema.reconcile.dispatch` with `prune` removes off-schema properties
    with an audit trail (v2).
15. A workspace's registry is composed of named **schemas**, each independently
    **enabled/disabled** via `schema.list` / `schema.toggle` (UI toggles in §6). Disabling a schema is
    **non-destructive** — it never deletes Neo4j nodes/relationships, only
    narrows the active vocabulary — verified by a test asserting existing
    instances remain queryable after a disable.
16. All graph-data prose, table/column names, and contract identifiers use the
    canonical Neo4j vocabulary (§1.2): node, label, relationship, relationship
    type, property, start/end node. No "entity"/"entity type"/"edge type" naming
    in any surface; the legacy `graph.edge.upsert` / `semantic.edge.*` contracts
    are renamed in v1 with one-release deprecation aliases (§1.2, §14).

## 3. Architectural Decisions

| Concern | Choice | Rationale |
|---|---|---|
| System of record | **PostgreSQL** (`schema` registry tables in a new `schema_registry` Postgres schema). | User requires the schema be queryable/pullable from Postgres; it is transactional metadata (configs/durable state), which the four-store model places in Postgres — never in Neo4j. |
| Live graph | **Neo4j** holds instances (first-class node labels, relationships). | Graph data only. The registry *describes and validates* those instances; it does not store them. |
| Observation signal | **ClickHouse** append-only `graph_observed_labels`. | Counts of labels / relationship types seen during ingestion are runtime telemetry, not durable state — sunsets the authoritative role of `ingestion.entity_types`. |
| Runtime conformance telemetry | **ClickHouse** append-only `schema_conformance_events`. | Per-write conformance scores + validation outcomes are high-volume runtime events — telemetry, not durable state. |
| ZIP export blob | **Vercel Blob via `@oxagen/storage`**, reference row in Postgres. | Binary asset; reuses `archive.create` plumbing and the `/api/v1/assets/<publicId>` access-controlled route. |
| Versioning | Immutable `schema_versions` snapshot rows + a single workspace **pin pointer** (`registries.pinned_version_id`). | Mirrors the established `versionMixin` pattern (agent/tool/playbook/prompt versions). Pin resolution is a single FK read. |
| Schema composition | Registry composed of named **schemas** (`schemas` table); definitions versioned/immutable, **enabled state** in a separate current-config `schema_activations` table. | Lets schemas be enabled/disabled as live config without re-versioning a frozen snapshot (§1.4, §4.3). |
| Reconcile run ledger | **Reuse the existing `agent_executions` ledger** (`agent_schema.agent_executions`, id `aex`), `origin_type='schema.reconcile.dispatch'`. | Reconcile already calls `@oxagen/ai` / `agent.subagent.dispatch`, which write `agent_executions`. A bespoke `reconcile_jobs` table would duplicate the general async-run ledger (status, tokens, cost, latency, lineage). (§4.7) |
| Enforcement posture | Per-workspace **enforcement mode** `strict` / `lenient` / `off`, default `lenient`. | AI ingestion is probabilistic; hard-rejecting probabilistic extraction would silently drop data. `lenient` writes + scores + alerts; `strict` is opt-in. |
| AI calls | All three touchpoints via **`@oxagen/ai`** (`generateObjectFor`, etc.). | Metering/observability law — never import from `ai` directly. |
| Chat transport | Existing chat SSE (`use-tool-stream.ts`) + generative UI via `agent.ui.render` structured output. | Single chat transport law; **no `ai/rsc`**. |
| Async reconciliation | **Inngest** fanout, optionally via `agent.subagent.dispatch`; lineage + metering through `invoke()`. | Established async fanout primitive; emits lineage and metering. |

### 3.1 Why a new Postgres schema, and why `ingestion.entity_types` is sunset

`entity_types` is a *passive observation cache* (mutated by ingestion, never
versioned) — and, worse, it durably stored what is really runtime observation,
which the four-store law assigns to ClickHouse. The registry is *authored,
versioned, pinned, enabled, validated* state with its own lifecycle. Co-mingling
would conflate the observed and the authored and break the immutable-version
pattern. Therefore:

- The **registry is the authoritative vocabulary** (Postgres, durable config).
- **Observation moves to ClickHouse** (`graph_observed_labels`, §4.9), where the
  recommender reads it.
- `ingestion.entity_types` is **sunset** as an authoritative list: existing rows
  are imported once into the registry as a `recommended` starter schema, then the
  table is deprecated (§7.1, §10). No "entity"-named Postgres replacement is
  introduced — that would re-import the banned vocabulary and the boundary
  violation.

### 3.2 Un-prescribing relationship types (remove `GRAPH_EDGE_TYPES`) — v1

**Decision (signed off):** customers must never be constrained to a built-in set
of relationship types or node labels. Node labels are already free strings;
relationship types are not. In v1 we **remove the `GRAPH_EDGE_TYPES` fixed enum**
from `graph.relationship.upsert.ts` (the renamed `graph.edge.upsert.ts`, §1.2)
and validate relationship types against the workspace registry's **active
vocabulary** (enabled schemas of the pinned version) instead.

**Security constraint this creates — do not regress.** `GRAPH_EDGE_TYPES` is not
only a product allow-list; it is the **Cypher-injection guard** for the ontology
query layer. Three handlers interpolate the relationship type directly into
Cypher and today reject anything not in the static enum:
`packages/handlers/src/ontology.neighbors.ts`,
`packages/handlers/src/ontology.query.ts`, and the `z.enum(GRAPH_EDGE_TYPES)` in
`packages/handlers/src/graph.ingest.ts`. Removing the static enum **must** keep
the interpolation safe. The replacement is a two-layer guard, applied everywhere
a relationship type reaches Cypher:

1. **Lexical guard (always on):** the relationship-type string must match a
   strict identifier pattern — `^[A-Z][A-Z0-9_]{0,62}$` (uppercase snake, Neo4j
   relationship-type convention). Anything else is rejected before it touches a
   query. This alone closes the injection vector regardless of the registry.
2. **Registry allow-list (when a version is pinned):** the type must also be a
   relationship type in the pinned version's **active vocabulary** (enabled
   schemas only, resolved via `getPinnedSchema`). When no version is pinned, the
   lexical guard stands alone (today's "anything goes" behavior, but
   injection-safe).

Concretely:

- `graph.relationship.upsert.ts` (renamed from `graph.edge.upsert.ts`): replace
  `edgeType: z.enum(GRAPH_EDGE_TYPES)` with `relationshipType:
  z.string().regex(RELATIONSHIP_TYPE_PATTERN)`; export `RELATIONSHIP_TYPE_PATTERN`
  from a shared module so handlers and the registry validator share one source.
- `graph.ingest.ts`: same swap for its inner `z.enum(GRAPH_EDGE_TYPES)`
  (relationship-type field).
- `ontology.neighbors.ts` / `ontology.query.ts`: replace the
  `GRAPH_EDGE_TYPES.includes(t)` check with `RELATIONSHIP_TYPE_PATTERN.test(t)`
  plus, when a registry is pinned, membership in the pinned **active**
  relationship-type set; when the relationship-type filter is omitted, the
  "all types" default becomes the pinned active vocabulary's relationship types
  (or unconstrained traversal when none pinned), not the old static list.
- Delete `GRAPH_EDGE_TYPES` and `GraphEdgeType`; update the handful of importers
  found by `grep -rn 'GRAPH_EDGE_TYPES'`. This is part of v1 scope, not a follow-up.

### 3.3 Migration off `:EntityNode {entityType}` to first-class labels — phased

The canonical model (§1.2.1) makes the label the node's type. The **registry and
all new surfaces use real labels from day one**, but the *physical* Neo4j data
and the code that reads/writes it are migrated in phases — the relabel is
sizable and gets its own milestone.

**Naming discipline.** This graph-data re-derivation process is always called
**reconcile / reconciliation**, never "migration." The word "migration" is
already owned by Atlas/Drizzle **database** migrations
(`packages/database/migrations/`, `pnpm db:migrate`, `db:lint-migrations`); reusing
it for graph-data re-derivation would collide. The phased relabel below is the one
place "migration" applies in the database sense (it ships partly as Atlas/job
work); the *graph* operation it performs is still "reconcile."

**Blast radius (grounded in real files):**

- **Ingestion writes** — `packages/ingestion/src/mutations/upsert-entity.ts`:
  `upsertEntityNode` MERGEs `(n:EntityNode { … })` and sets `n.entityType`; the
  relationship templates (`INFERRED_FROM`, `REFERENCES`, `SIMILAR_TO`, `PART_OF`)
  `MATCH (…:EntityNode …)`. `packages/ingestion/src/types.ts`,
  `infer/index.ts`, `dedup/resolve.ts`, `embed/index.ts`, and the GitHub
  connector (`connectors/github/index.ts`) all reference `EntityNode` /
  `entityType`.
- **Ontology / graph query handlers** — `ontology.neighbors.ts`,
  `ontology.query.ts`, `graph.ingest.ts` (and any `:EntityNode` MATCH in the
  graph-stats path) read the discriminator.
- **Graph-explorer surface** — `apps/app/src/components/knowledge/graph-explorer/`
  reads `entityType` to color/group nodes.
- **Existing Neo4j data** — every persisted node currently carries `:EntityNode`
  + `entityType`.

**Phased plan:**

1. **Vocabulary + registry (v1, this epic).** Establish §1.2 terms and the
   registry. All new authoring, recommendation, validation, and ingestion
   *grounding* speak first-class labels. No physical relabel yet.
2. **Dual-write / back-compat read.** Ingestion writes the **real label** as the
   primary label (`(n:Customer { … })`) and **may retain `:EntityNode` as a
   secondary label** during transition (`(n:Customer:EntityNode { … })`), keeping
   `entityType` populated for back-compat. Readers prefer the real label, falling
   back to `:EntityNode {entityType}` when a node has not yet been relabeled.
3. **Batch relabel.** A one-time job pages over `:EntityNode` nodes and `SET`s the
   first-class label from `entityType` (and relabels relationships off the generic
   templates), removing the `:EntityNode` secondary label as it goes. This is its
   own **milestone** (likely alongside or after v2 reconcile, which shares the
   paging machinery).
4. **Drop `entityType`.** Once dual-write and relabel are complete and verified,
   remove the `entityType` property and the `:EntityNode` secondary label from
   writes and readers.

Be honest: the physical relabel is large and phased; v1 ships the vocabulary,
registry, grounding, and validation, with ingestion beginning dual-write so new
data lands with real labels immediately.

## 4. Data Model (PostgreSQL — new `schema_registry` schema)

New Postgres schema `schema_registry` registered in
`packages/database/src/schema/_schemas.ts`
(`export const schemaRegistrySchema = pgSchema("schema_registry");`). All tables
use `idMixin(...)` (UUIDv7 `id` + prefixed `public_id`), `auditMixin()`,
`softDeleteMixin()`, and `orgScopeMixin()` (org_id + workspace_id) per
`packages/database/src/schema/_mixins.ts`. New tables live in
`packages/database/src/schema/schema-registry.ts`; relations in
`packages/database/src/relations.ts`. Migrations (Atlas) go in
`packages/database/migrations/`.

### 4.1 `schema_registry.registries` (one per workspace)

The pin pointer + per-workspace config. Exactly one non-deleted row per
workspace.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("scr")` |
| `public_id` | citext unique | `scr_…` |
| `org_id`, `workspace_id` | uuid notNull | `orgScopeMixin()` |
| `pinned_version_id` | uuid null | FK → `schema_versions.id`; null until first version pinned |
| `draft_version_id` | uuid null | FK → `schema_versions.id` where `status='draft'`; the working copy edited by the builder |
| `enforcement_mode` | text notNull default `'lenient'` | CHECK in (`strict`,`lenient`,`off`) |
| `conformance_floor` | numeric(3,2) notNull default `0.50` | below this, `lenient` mode raises a `schema.conformance.low` event |
| created/updated/deleted + audit | — | mixins |

Unique index on `(workspace_id) WHERE deleted_at IS NULL`.

### 4.2 `schema_registry.schema_versions` (immutable snapshots)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("scv")` |
| `org_id`, `workspace_id` | uuid | scope |
| `registry_id` | uuid notNull | FK → `registries.id` |
| `version_number` | integer notNull | monotonic per registry |
| `status` | text notNull | CHECK in (`draft`,`published`); only `published` may be pinned |
| `parent_version_id` | uuid null | lineage (forked from) |
| `label` | text null | optional human tag, e.g. "Sales CRM v2" |
| `change_summary` | text null | AI- or user-authored summary for the diff/changelog |
| `published_at` | timestamptz null | set on publish |
| created/audit | — | mixins (no soft delete — published versions are immutable) |

Unique `(registry_id, version_number)`. Draft is a single mutable version row
(status `draft`); publishing freezes it and bumps the draft to a new row.

### 4.3 `schema_registry.schemas` + activation

A **schema** is a named group of labels + relationship types (§1.4). Schema
*definitions* belong to a version snapshot (immutable); *enabled state* lives in a
separate current-config table keyed by stable schema identity, so toggling never
mutates a frozen version.

`schema_registry.schemas` (one row per schema per version snapshot):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("sch")` |
| `org_id`, `workspace_id`, `version_id` | uuid | scope + FK → `schema_versions.id` |
| `name` | text notNull | stable identity within a workspace, e.g. `salesforce_crm`, `starter` |
| `display_name` | text notNull | — |
| `description` | text null | what this schema covers / where its labels come from |
| `source` | text notNull | CHECK in (`user`,`connector`,`recommended`) |
| `connector_id` | text null | set when `source='connector'`; the contributing connector |
| created/audit | — | mixins |

Unique `(version_id, name)`. (`node_labels` and `relationship_types` carry a
`schema_id` FK — §4.4/§4.5 — so every label/relationship type belongs to exactly
one schema.)

`schema_registry.schema_activations` (current workspace config — **not**
versioned):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("sca")` |
| `org_id`, `workspace_id` | uuid | scope |
| `schema_name` | text notNull | stable schema identity (matches `schemas.name`); version-independent |
| `enabled` | boolean notNull default `true` | current enable/disable state |
| `updated_at` | timestamptz notNull | last toggle |
| audit | — | `auditMixin()` |

Unique `(workspace_id, schema_name) WHERE deleted_at IS NULL`. Keying on
`schema_name` (not `version_id`/`schema_id`) is deliberate: it is **current
config that survives re-versioning** — a schema disabled in version N stays
disabled when version N+1 is published, without mutating either frozen snapshot
(§1.4).

**Born-disabled rule (north-star §2.0).** A schema created in the builder —
`source='user'` or `source='recommended'`, including everything the AI assistant
drawer scaffolds — is created together with an **explicit `enabled=false`
activation row**, so it lands disabled/draft and has no graph effect until the
user activates it. The *implicit* "no activation row → **enabled**" default is a
fallback that applies only to `source='connector'` schemas (an installed
connector's labels are on by default) and to once-imported/legacy rows that
predate an activation record. So: connectors default on; user/AI/recommended
schemas are explicitly born off.

### 4.4 `schema_registry.node_labels`

A label belongs to exactly one schema within one version snapshot
(copy-on-publish).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("scl")` |
| `org_id`, `workspace_id`, `version_id` | uuid | scope + FK → `schema_versions.id` |
| `schema_id` | uuid notNull | FK → `schemas.id` — which schema this label belongs to |
| `name` | text notNull | label string, e.g. `Customer`, `Contract` (this **is** the Neo4j node label, §1.2.1) |
| `display_name` | text notNull | — |
| `description` | text null | grounds the ingestion AI: what this label represents / where to find it |
| `natural_key_props` | text[] notNull default `'{}'` | property names forming the dedup natural key (advisory) |
| `metadata` | jsonb notNull default `'{}'` | color/icon/UI hints |
| created/audit | — | mixins |

Unique `(version_id, name)`.

### 4.5 `schema_registry.relationship_types`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("scrt")` |
| `org_id`, `workspace_id`, `version_id` | uuid | scope + FK |
| `schema_id` | uuid notNull | FK → `schemas.id` — which schema this relationship type belongs to |
| `name` | text notNull | relationship type, e.g. `SIGNED_CONTRACT`, `EMPLOYS` (matches `RELATIONSHIP_TYPE_PATTERN`) |
| `display_name` | text notNull | — |
| `description` | text null | grounds the AI on when this relationship applies |
| `start_label` | text null | constraint: **start node** label, Cypher `(start)` (null = any) |
| `end_label` | text null | constraint: **end node** label, Cypher `->(end)` (null = any) |
| `cardinality` | text null | CHECK in (`one_to_one`,`one_to_many`,`many_to_many`) |
| created/audit | — | mixins |

Unique `(version_id, name, start_label, end_label)`.

### 4.6 `schema_registry.properties`

Polymorphic owner: a property belongs to **either** a node label **or** a
relationship type (exactly one FK set).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `idMixin("scp")` |
| `org_id`, `workspace_id`, `version_id` | uuid | scope + FK |
| `node_label_id` | uuid null | FK → `node_labels.id` (XOR with rel) |
| `relationship_type_id` | uuid null | FK → `relationship_types.id` (XOR) |
| `key` | text notNull | property name |
| `data_type` | text notNull | CHECK in (`string`,`number`,`integer`,`boolean`,`date`,`datetime`,`url`,`email`,`enum`,`json`,`array`) |
| `required` | boolean notNull default `false` | — |
| `description` | text null | **the grounding field** — what to collect, where to find it |
| `enum_values` | text[] null | when `data_type='enum'` |
| `item_type` | text null | when `data_type='array'` (element type) |
| `constraints` | jsonb notNull default `'{}'` | `min`/`max`/`minLength`/`maxLength`/`pattern` — mirrors the connector `FieldValidation` shape in `connector-schema-loader.ts` |
| `example` | text null | few-shot grounding example for the extraction prompt |
| created/audit | — | mixins |

CHECK: exactly one of `node_label_id`/`relationship_type_id` is non-null.
Unique `(node_label_id, key)` and `(relationship_type_id, key)`.

### 4.7 Reconcile run ledger — reuse `agent_executions` (v2; **no bespoke table**)

**Decision:** reconcile runs do **not** get a bespoke `schema_registry.reconcile_jobs`
table. They are recorded on the existing general-purpose async-run ledger
`agent_executions` (`agent_schema.agent_executions`, id prefix `aex`, in
`packages/database/src/schema/agent.ts`), written via the existing
`agent.execution.record` contract. Reconcile already calls `@oxagen/ai` and may
fan out via `agent.subagent.dispatch` (which itself writes `agent_executions`
rows), so a parallel table would duplicate the ledger's `status`, token, cost,
latency, and lineage tracking.

A reconcile run is one `agent_executions` row:

| `agent_executions` column | Reconcile usage |
|---|---|
| `origin_type` (text, notNull) | `'schema.reconcile.dispatch'` |
| `origin_id` (uuid, notNull) | the `schema_registry.registries.id` (or target `version_id`) |
| `status` | `planning` → `running` → `completed`/`failed`/`cancelled` (the existing CHECK) |
| `input_payload` (jsonb) | `{ fromVersionId, toVersionId, prune }` |
| `output_payload` (jsonb) | final summary: per-kind totals + `prunedPropertyKeys` audit map |
| `state` (jsonb) | live progress counters (see below) |
| `parent_execution_id` | set when dispatched as an `agent.subagent.dispatch` child (lineage) |
| `input_tokens`/`output_tokens`/`estimated_cost_usd`/`latency_ms` | inherited token/cost/latency metering |
| `started_at`/`completed_at`/`failure_reason`/`synced_to_graph_at` | inherited lifecycle |

Progress counters live in `state` (and are copied to `output_payload` on
completion):

```
state = {
  totalNodes, processedNodes, updatedNodes,
  totalRelationships, processedRelationships, updatedRelationships,
  prune: boolean,
  prunedNodes, prunedRelationships,
  prunedPropertyKeys: { "<Label|RelType>": ["<removed key>", …] }
}
```

`agent_execution_steps` (children of `agent_executions`) record per-batch
progress where finer granularity helps. Per-write prune + conformance detail
stays in the ClickHouse `schema_conformance_events` table (§4.10) — durable
Postgres only carries the run-level ledger row.

### 4.8 Pin resolution (active vocabulary)

`getPinnedSchema(orgId, workspaceId)` → reads `registries.pinned_version_id`,
loads `schemas` for that `version_id`, **filters to the enabled set** via
`schema_activations` (a schema with no activation row defaults to enabled), then
loads `node_labels` + `relationship_types` + `properties` for the **enabled**
schemas only. The result is the **active vocabulary** (§1.4). Cached per
workspace+version+activation-fingerprint (definitions are immutable, but the
enabled set is live config, so the activation fingerprint is part of the cache
key and is invalidated on pin change **or** any `schema.toggle`). This is the
function ingestion calls (§8) and the §3.2 ontology guard consults.

### 4.9 ClickHouse — `graph_observed_labels` (append-only, observation)

Replaces the durable observation role of `ingestion.entity_types` (§1.3, §3.1).
Emitted by ingestion as it writes nodes/relationships; read by `schema.recommend`.

```
graph_observed_labels
  event_id, org_id, workspace_id
  target_kind (node|relationship)
  label_or_type String            -- the node label or relationship type seen
  property_keys Array(String)      -- property keys present on the observed instance
  connection_id, source_record_type
  occurred_at DateTime64
```

The recommender aggregates this (counts per `label_or_type`, common
`property_keys`) instead of reading `entity_types`.

### 4.10 ClickHouse — `schema_conformance_events` (append-only)

Per-write conformance telemetry (NOT in Postgres — runtime events only).

```
schema_conformance_events
  event_id, org_id, workspace_id, version_id
  target_kind (node|relationship), node_id|relationship_key, node_label
  enforcement_mode, outcome (accepted|rejected|written_below_floor|pruned)
  conformance_score Float32, missing_required Array(String)
  type_errors Array(String), connection_id, source_record_type
  occurred_at DateTime64
```

## 5. Capabilities / Contracts

Every contract is declared in `packages/oxagen/src/contracts/` with full parity.
All scoped (`scoped: true`), org+workspace tenant-bound, `defaultEffect: "deny"`,
Owner/Admin (org) + Owner/Member (workspace) allow, except read-only ones also
allow Viewer. `schema.recommend`, `schema.chat`, and the validators carry
`surfaces` including `agent`; mutators carry `agent.requiresApproval` per risk.

| Contract | API route | MCP tool | Mode | Description |
|---|---|---|---|---|
| `schema.registry.get` | `routes/v1/schema.ts` | `tools/schema.ts` | sync | Resolve a workspace's registry: pinned version, draft version, enforcement mode, **per-schema enabled state**, label/relationship/property tree. |
| `schema.registry.config` | `schema.ts` | `schema.ts` | sync | Set `enforcement_mode` + `conformance_floor`. IAM: Admin. |
| `schema.list` | `schema.ts` | `schema.ts` | sync | List the workspace's schemas (name, display, source, connector, **enabled state**). Viewer-allowed. |
| `schema.toggle` | `schema.ts` | `schema.ts` | sync | Enable/disable a schema for the workspace (writes `schema_activations`). **Activation is the go-live trigger: auto-publishes the current draft if it has unpublished edits (`version.create`) and auto-pins the resulting version (`version.pin`)** so the schema is "ready for use" — no separate publish/pin step (§1.4, §16.8). **Non-destructive** — re-pins to reflect the active set but never touches Neo4j data. Returns the resulting pinned version + whether reconcile is recommended. IAM: Admin. |
| `schema.label.upsert` | `schema.ts` | `schema.ts` | sync | Create/update a node label (name, display, description, natural-key props) on a schema within the draft version. |
| `schema.label.delete` | `schema.ts` | `schema.ts` | sync | Remove a label (+ its properties) from the draft. |
| `schema.relationship.upsert` | `schema.ts` | `schema.ts` | sync | Create/update a relationship type (name, start/end label, cardinality, description) on a schema within the draft. |
| `schema.relationship.delete` | `schema.ts` | `schema.ts` | sync | Remove a relationship type from the draft. |
| `schema.property.upsert` | `schema.ts` | `schema.ts` | sync | Create/update a property (key, dataType, required, description, constraints, enum/item/example) on a label or relationship type. |
| `schema.property.delete` | `schema.ts` | `schema.ts` | sync | Remove a property from the draft. |
| `schema.version.create` | `schema.ts` | `schema.ts` | sync | Freeze the current draft into an immutable published version; open a fresh draft. |
| `schema.version.pin` | `schema.ts` | `schema.ts` | sync | Point the workspace at a published version; returns whether a pin *downgrade* (older version) occurred → reconcile prompt. |
| `schema.version.list` | `schema.ts` | `schema.ts` | sync | List versions (number, label, status, published_at, change_summary). Viewer-allowed. |
| `schema.version.diff` | `schema.ts` | `schema.ts` | sync | Structural diff of two versions: added/removed/changed schemas, labels, relationship types, properties. |
| `schema.export` | `schema.ts` | `schema.ts` | sync | Build a ZIP of a version (manifest + one file per label/relationship type, grouped by schema) via the `archive.create` plumbing; returns access-controlled `serveUrl`. |
| `schema.recommend` | `schema.ts` | `schema.ts` | sync | AI onboarding: read existing graph (`graph.stats`, `graph_observed_labels` telemetry, sampled `ontology.query`) **and the workspace's enabled schemas** → propose a starter schema / additions (labels/relationship types/properties). Does NOT mutate; returns a proposal the UI applies. Accepts `sampleLimit` (default 200); the agent may request more samples mid-run, and the value is exposed as a UI inference control and an API/MCP argument. |
| `schema.setup` | `schema.ts` | `schema.ts` | sync | **Interactive, LLM-assisted registry walkthrough** — the headless analogue of the app onboarding. Drives `schema.recommend` → intent-Q&A (`schema.chat`) → apply (`schema.label/relationship/property.upsert`) → **activate** (`schema.toggle`, which auto-publishes the draft + pins it — §1.4). |
| `schema.chat` | `schema.ts` | `schema.ts` | sync | AI iterative builder turn: takes conversation + draft; returns assistant message + proposed mutation tool calls (rendered via `agent.ui.render`). |
| `schema.validate.node` | `schema.ts` | `schema.ts` | sync | Validate a node `{label, properties}` against the pinned (or specified) version's **active vocabulary**; returns `{valid, conformanceScore, errors[]}`. |
| `schema.validate.relationship` | `schema.ts` | `schema.ts` | sync | Validate a relationship `{type, startLabel, endLabel, properties}` against the active vocabulary; same return shape. |
| `schema.reconcile.dispatch` | `schema.ts` | `schema.ts` | async | (v2) Dispatch Inngest workers to backfill/re-derive node & relationship properties to match a version. Records the run on an `agent_executions` row (§4.7). Accepts `prune: boolean` (default `false`) — when set, also **removes** node/relationship properties not present in the target schema (see §9). Exposed as an API/MCP argument and a UI knob in the pin-change dialog. Returns `executionId` (`aex_…`). |
| `schema.reconcile.status` | `schema.ts` | `schema.ts` | sync | (v2) Read a reconcile run's progress by reading back its `agent_executions` row and projecting the counters from `state` (§4.7). |

> `schema.ts` is a **combined route file** (like `connection.ts`,
> `integration.ts`) covering all `schema.*` capabilities, mounted in
> `apps/api/src/app.ts`. Expect `check:manifest` false-positive gaps for the
> combined file — document the coverage in the route file header, as the other
> combined routes do.

> **Vocabulary note:** the new validator contract is
> `schema.validate.relationship` (not `…edge`), consistent with §1.2. The legacy
> `graph.edge.upsert` / `semantic.edge.*` contracts are **renamed in v1** to
> `graph.relationship.upsert` / `semantic.relationship.*` with one-release
> deprecation aliases (§1.2, §14); the new `schema.*` contracts use "relationship"
> from the start.

### 5.1 Shared validation error shape

Reuse the field-error shape already established in `plugin.schema.validate.ts`
and `connector-schema-loader.ts` (`{ field, message, code }` with codes
`required | min | max | minItems | maxItems | pattern | type | oneOf | unknown`).
Validators add `conformanceScore: number` and `outcome` to the output.

### 5.2 Representative contract shapes (high level)

- `schema.label.upsert.input`: `{ schemaName, name, displayName, description?, naturalKeyProps?: string[], properties?: PropertyInput[] }` → `output: { labelId, created }`.
- `schema.relationship.upsert.input`: `{ schemaName, name, displayName, startLabel?, endLabel?, cardinality?, description?, properties?: PropertyInput[] }` → `{ relationshipTypeId, created }`.
- `schema.property.upsert.input`: `{ ownerKind: "node"|"relationship", ownerName, key, dataType, required, description?, enumValues?, itemType?, constraints?, example? }` → `{ propertyId, created }`.
- `schema.list.input`: `{}` → `{ schemas: [{ schemaName, displayName, source, connectorId?, enabled }] }`.
- `schema.toggle.input`: `{ schemaName, enabled: boolean }` → `{ schemaName, enabled, publishedVersionId, pinnedVersionId, isDowngrade, reconcileRecommended }`. Auto-publishes the draft (if dirty) + auto-pins (§1.4, §16.8); never deletes graph data. The `reconcileRecommended` flag drives the §9 reconcile prompt.
- `schema.validate.node.input`: `{ label, properties, versionId? }` → `{ valid, conformanceScore, errors: FieldError[], missingRequired: string[] }`.
- `schema.recommend.input`: `{ sampleLimit?: number = 200 }` → `{ proposal: { schemas: [{ name, labels, relationshipTypes }] }, rationale, sampledCount }`. The proposal is scoped to additions/edits that respect the workspace's enabled schemas. The agent may internally request additional samples up to a hard ceiling when coverage is thin or the user asks for "more thorough" inference.
- `schema.version.pin.input`: `{ versionId }` → `{ pinnedVersionId, previousVersionId, isDowngrade, reconcileRecommended }`.
- `schema.reconcile.dispatch.input`: `{ versionId, prune?: boolean = false }` → `{ executionId }` (the `aex_…` `agent_executions` id, §4.7).
- `schema.reconcile.status.input`: `{ executionId }` → `{ status, totalNodes, processedNodes, updatedNodes, totalRelationships, processedRelationships, updatedRelationships, prunedNodes, prunedRelationships }` (projected from the `agent_executions` row's `state`).

## 6. UI

Surface: **Settings → Knowledge → Schema**, sibling to
`apps/app/src/components/knowledge/graph-explorer/`. New directory
`apps/app/src/components/knowledge/schema-builder/`.

**Two co-equal authoring modes in one surface (§2.1).** The builder presents a
complete **traditional form-based editor** (labels / relationships / properties as
editable forms and grids) *and* an **agent-assisted drawer**, side by side over
the same draft. The form editor is fully usable on its own — a user never has to
touch the agent — and the agent drawer is fully usable on its own. They share the
draft and the same `schema.*` contracts, so a user can switch between or mix them
at any point. The form components (`schema-builder`, `schema-list`, `label-editor`,
`relationship-editor`, `property-table`, `version-history`, `export-button`) and
the agent components (`schema-assistant-drawer`, `onboarding-recommendation`) are
both first-class; the drawer is dockable/collapsible so the form remains a
complete experience with the agent closed.

Components:

- `schema-builder.tsx` — top-level: version selector (pinned/draft), enforcement
  mode toggle, tabs for Schemas / Labels / Relationships, and a toggle to open the
  `schema-assistant-drawer`. Works fully with the drawer closed (forms-only).
- `schema-list.tsx` — the workspace's **schemas list** with an activate/deactivate
  **toggle** per schema (showing source: connector / user / recommended, and
  draft-vs-published state). Toggling calls `schema.toggle`; copy makes clear that
  **activating auto-publishes the draft and pins it ("ready for use") in one
  step** — no separate publish/pin action — and that deactivating is
  **non-destructive** (it narrows the active vocabulary only; existing graph data
  stays queryable). After a successful activate (which pins), it surfaces the §9
  reconcile prompt when `reconcileRecommended`. Admin gated.
- `label-editor.tsx` / `relationship-editor.tsx` — form per label/relationship
  type with description fields (relationship editor uses **start label / end
  label**).
- `property-table.tsx` — editable grid: key, dataType, required, description,
  constraints, example. Reuses `@oxagen/ui` table primitives (per `coss-ui`).
- `onboarding-recommendation.tsx` — first-load panel that calls
  `schema.recommend` and renders an accept/edit/discard proposal (grouped by
  proposed schema). Includes an **inference depth control** (sample size, default
  200) and a "sample more" action so the user can ask the agent to read a larger
  slice of the graph; the value maps 1:1 to the API/MCP `sampleLimit` argument.
- `schema-assistant-drawer.tsx` — the **AI assistant drawer** (the north-star
  §2.0 hero surface): a slide-over drawer with a prompt box where the user types
  a single natural-language ask (e.g. the B2B-SaaS ontology prompt) and the agent
  **scaffolds one or more named schemas** with pre-filled labels, relationship
  types, and properties — landing **disabled/draft**. Wired to the **existing chat
  transport** (`use-tool-stream.ts`); the agent's proposed mutations render as
  inline generative-UI cards via `agent.ui.render` structured output. **No
  `ai/rsc`.** A **new prompt modifies the existing draft additively** (§7.2) — it
  never wipes prior prompts' or manual edits. The drawer is openable from the
  schema-builder header and is the primary entry point for both initial creation
  and iterative edits.
- `version-history.tsx` — version list + diff viewer (`schema.version.diff`).
- `pin-change-dialog.tsx` — surfaces whenever a pin changes, which now includes
  **after a schema is activated** (activation auto-pins, criterion 6) as well as
  an explicit version pin or downgrade. Prompts: "Dispatch worker agents to
  **prune / improve / polish / coerce** the existing graph into the shape of this
  newly published/activated schema?" → calls `schema.reconcile.dispatch`. Includes
  a **"Prune properties not in the schema" knob** (off by default, with a clear
  destructive-action warning) that sets the `prune` flag — the UI equivalent of
  the API/MCP `prune` argument.
- `export-button.tsx` — calls `schema.export`, downloads the ZIP.

Every new component above ships a **Storybook story in the app Storybook**
(`apps/app` `pnpm storybook`, port **6007**) with light + dark variants, per the
§13 visual gate.

All write actions invoke contracts through the app's `invoke()` path.
**`apps/app` does not bootstrap IAM** — every call site adds an explicit
`assertOrgMember` / Admin gate (per CLAUDE.md gotcha); do not rely on the
kernel. `schema.toggle` and `schema.registry.config` call sites assert Admin.

UI imports go through the local re-export layer (`@/components/ui/<name>`),
never `@oxagen/ui/components/*` directly.

## 7. AI Behavior

Three distinct touchpoints, all via `@oxagen/ai` (`generateObjectFor` for
structured output), all metered with `telemetry: { orgId, workspaceId, surface }`.

### 7.1 Onboarding recommender (`schema.recommend`)

Reads, in the workspace scope:
- `graph.stats({ includeByType: true })` → live `nodesByLabel`,
  `relationshipsByType` counts.
- **`graph_observed_labels`** ClickHouse telemetry (§4.9) → observed labels /
  relationship types and their common property keys. **This replaces the old
  `ingestion.entity_types` read** — observation is now runtime telemetry, not
  durable Postgres state (§1.3, §3.1).
- The workspace's **enabled schemas** (`schema.list` / `getPinnedSchema`) → so the
  recommender "considers what is configured" and proposes additions/edits within
  or alongside existing schemas rather than ignoring them.
- A bounded `ontology.query` sample of representative nodes for property evidence.

It does **not** read `ingestion.entity_types`. (One-time migration: existing
`entity_types` rows are imported into the registry as a `recommended`-source
starter schema at rollout — §10 — after which the table is deprecated.)

Prompts `generateObjectFor` with a Zod schema describing
`{ schemas: [{ name, labels: [{ name, description, properties:[{key,dataType,required,description}] }], relationshipTypes: [{ name, startLabel?, endLabel?, description }] }] }`
and a system prompt: *"You are a knowledge-graph schema designer. Given the
observed labels, relationship types, sampled properties, and the workspace's
already-configured schemas, propose a clean, well-described starter schema (or
additions to existing ones)…"*. Returns a **proposal only** — the UI applies it
via `schema.label.upsert` etc. The relationship types it proposes are **fully
workspace-defined** — there is no built-in relationship-type vocabulary to bias
toward (see §3.2).

**Sample size is user-controllable.** `sampleLimit` defaults to 200 nodes but is
surfaced as a UI inference-depth control and an API/MCP argument. When the user asks for more thorough inference (or coverage of
the observed labels is thin), the agent requests additional samples up to a hard
ceiling before proposing — so larger graphs can be characterized more completely
on demand without making the default expensive.

### 7.2 AI assistant drawer — generative scaffold + iterative builder (`schema.chat`)

The drawer (`schema-assistant-drawer.tsx`, §6) drives `schema.chat`, which has
two complementary modes over the same conversation + current draft:

- **Generative scaffold (bulk).** From a single broad intent prompt — e.g.
  *"Create the schemas necessary to capture the ontology of an Enterprise B2B SaaS
  company including subscription plans, payments, customers, support issues,
  product bugs, product features, competitors, leads, vendors, partners, and
  employees"* — the agent scaffolds a **whole multi-schema ontology**: one or more
  named schemas, each with pre-filled node labels, relationship types (with
  start/end-label constraints), and typed properties with descriptions. Everything
  it creates lands in the **draft, disabled/unpublished** (§1.4) until the user
  activates — no graph impact from merely asking.
- **Iterative refinement (Q&A).** The agent also asks intent questions ("What kind
  of business are you?", "Do you track customers / source code / CRM data / vendors
  & contracts?") to fill gaps and refine.

In both modes it emits **proposed mutation tool calls** mapped to
`schema.label.upsert` / `schema.relationship.upsert` / `schema.property.upsert`
(and may propose `schema.toggle` to activate). Mutations surface as inline
approval cards via `agent.ui.render` and apply through the standard tool-stream
path.

**Additive re-prompting (hard rule, north-star §2.0).** Every prompt operates on
the **existing draft**: it adds and edits labels/relationship types/properties but
**never wipes** what earlier prompts or manual edits produced. A second prompt
("also add a `Renewal` label to the subscriptions schema") layers onto the first;
it does not regenerate from scratch or discard prior work. The agent is instructed
to diff against the current draft and propose only the deltas. System prompt is
customizable per workspace via `prompt.settings.read/write` — never hard-coded.

### 7.3 Ingestion-time grounding

At the ingestion seam (§8), the pinned schema's **active vocabulary** (enabled
schemas only) for the inferred label / relationship type is injected into the
extraction / inference prompt: the label description, each property's
`description`, `required` flag, `dataType`, and `example`. This is what tells the
ingesting AI *what to collect and where to find it*. The existing inference call
in `packages/ingestion/src/infer/index.ts` (`inferSemanticEdges`,
`generateObjectFor`) gains a `schemaContext` block built from `getPinnedSchema()`
and rendered into the system/prompt text. (Labels disabled via `schema.toggle`
are absent from `getPinnedSchema()`, so they neither ground nor validate.)

## 8. Ingestion Integration Seam (pinned to real files)

The registry feeds the universal pipeline at three precise points in
`packages/ingestion/`:

1. **Schema load — `pipeline.ts`, `PipelineContext`.** Add
   `getPinnedSchema(orgId, workspaceId): Promise<PinnedSchema | null>` to
   `PipelineContext` (alongside the existing `getMapping` /
   `getDeliveryConfig`). The handler layer implements it via the §4.8 resolver,
   returning the **active vocabulary** (enabled schemas only); it is null when no
   version is pinned (registry inert → today's behavior).

2. **Grounding — `infer/index.ts`, `inferSemanticEdges`.** After loading the
   node, fetch the label's schema from the pinned `PinnedSchema` and prepend a
   `schemaContext` section (label + property descriptions, required fields,
   examples, allowed relationship types with start/end constraints) to the
   `generateObjectFor` system/prompt. This narrows extraction to the schema's
   required properties and constrains inferred relationship types to the active
   vocabulary's relationship types for that label.

3. **Property-level validation — `mutations/upsert-entity.ts`,
   `upsertEntityNode`.** Before the MERGE, run
   `validateNodeAgainstSchema(mutation, pinnedSchema)` (a new pure function in
   `packages/ingestion/src/validate/schema.ts`, structurally mirroring
   `validateConfigAgainstSchema` in `connector-schema-loader.ts`). Behavior by
   `enforcement_mode`:
   - `strict`: missing-required or type error → **do not write**; return a
     `filtered`-style rejection with reason `schema_nonconformant`; emit a
     `schema_conformance_events` row (`outcome=rejected`).
   - `lenient`: write the node, attach `conformanceScore` + `schemaVersionId` as
     node properties, emit a `schema_conformance_events` row; if score <
     `conformance_floor`, also emit `schema.conformance.low`.
   - `off`: skip validation entirely.

   This is also the natural seam to begin the §3.3 **dual-write**: `upsertEntityNode`
   writes the real label as primary (and, transitionally, retains `:EntityNode`
   as a secondary label + `entityType`).

   `runPipeline` (`pipeline.ts`) is the call site that wires steps 1–3: it loads
   `getPinnedSchema` once (like `getDeliveryConfig`), passes it into the embed /
   infer / upsert stages, and the conformance score travels on the returned
   `PipelineResult`.

The same validator backs the `schema.validate.node` / `schema.validate.relationship`
contracts, so the builder UI and the pipeline share one validation
implementation (single source of truth). Ingestion also emits
`graph_observed_labels` (§4.9) as it writes, feeding the recommender.

## 9. Async / Workers (Reconciliation — v2)

`schema.reconcile.dispatch` queues an Inngest function
(`ingestion/schema.reconcile` or via `agent.subagent.dispatch` fanout):

1. Record the run as an `agent_executions` row (§4.7) via `agent.execution.record`:
   `origin_type='schema.reconcile.dispatch'`, `status='planning'→'running'`,
   `input_payload = { fromVersionId, toVersionId, prune }`. **No bespoke
   `reconcile_jobs` table.**
2. Page over nodes in the workspace whose label is in the target version's active
   vocabulary (and relationships for relationship types), in batches. (During the
   §3.3 transition, the pager reads first-class labels and falls back to
   `:EntityNode {entityType}` for not-yet-relabeled nodes; this is the same paging
   machinery the §3.3 batch relabel reuses.)
3. For each batch, run a best-effort property re-derivation: validate against the
   target schema; for missing required properties with a `description`, call
   `@oxagen/ai` to extract the value from the node's existing properties /
   neighborhood; write back via `graph.node.upsert` / `graph.relationship.upsert`.
4. **Prune (opt-in, `prune: true`).** When set, also remove node/relationship
   properties that are **not** defined in the target schema for that
   label/relationship type, recording each removed key on the run's
   `agent_executions` `state.prunedPropertyKeys` (and `output_payload` on
   completion) and a `schema_conformance_events` row (`outcome=pruned`) so the
   deletion is auditable. Default is **additive-only** (no deletion). Pruning is a
   destructive write, so it requires the same Admin gate as dispatch and a
   confirmed opt-in; it never runs implicitly. **Disabling a schema
   (`schema.toggle`) is NOT a prune** — it only narrows the active vocabulary and
   never deletes data (§1.4); `--prune` is the only destructive path.
5. Update the `state` progress counters (`processedNodes` / `updatedNodes` /
   `prunedNodes`, and the relationship equivalents); emit lineage + metering
   through `invoke()`; emit progress events to ClickHouse.
6. On completion, mark the `agent_executions` row `completed` and copy the final
   counters into `output_payload`; UI polls `schema.reconcile.status` (which reads
   the row back).

Verb mapping (north-star §2.0 "prune / improve / polish / coerce"): **improve /
polish / coerce** = the best-effort property re-derivation in step 3 (fill missing
required properties, normalize/coerce values to the schema's `dataType`); **prune**
= the opt-in off-schema property removal in step 4.

Triggering policy: prompted (never automatic) whenever a pin changes. Because
**activation auto-pins** (§1.4, criterion 6), the most common trigger is **a
schema being activated**; it also fires on an explicit new-version pin OR when the
pin moves to a different (older) version (`isDowngrade`). The
`pin-change-dialog.tsx` is the only entry point; the prune knob there (and the API/MCP `prune` argument) sets the `prune` flag.

## 10. Migrations

- New schema `schema_registry` in `_schemas.ts`; tables in
  `packages/database/src/schema/schema-registry.ts`; relations in `relations.ts`.
- Atlas migration in `packages/database/migrations/` creating the Postgres tables
  (§4.1–4.6: `registries`, `schema_versions`, `schemas`, `schema_activations`,
  `node_labels`, `relationship_types`, `properties`) with the indexes/uniques/checks
  listed, plus RLS policies (§11). **No reconcile table** — reconcile runs reuse
  the existing `agent_executions` ledger (§4.7), so there is no new reconcile DDL.
  Migration files **never** go in `apps/`.
- ClickHouse DDL for `graph_observed_labels` (§4.9) and `schema_conformance_events`
  (§4.10) in the ClickHouse migration set.
- **Contract rename + alias (v1).** `graph.edge.upsert` → `graph.relationship.upsert`
  and `semantic.edge.*` → `semantic.relationship.*` (§1.2): add the new contracts
  + API/MCP parity, mount the old names as one-release deprecation aliases that
  route to the new handlers and emit a deprecation note, and remove the
  `GRAPH_EDGE_TYPES` enum (§3.2). Aliases are dropped one release later (§14).
- **`ingestion.entity_types` sunset (phased).** (a) Ship the registry + ClickHouse
  observation; (b) run a one-time import that maps existing `entity_types` rows
  into a `recommended`-source schema in the registry (labels from `name` /
  `displayName` / `description`, property keys from `commonPropertyKeys`,
  relationship hints from `expectedEdges`); (c) repoint the recommender to
  `graph.stats` + `graph_observed_labels` (it no longer reads `entity_types`);
  (d) mark `entity_types` **deprecated** (stop writing to it from ingestion; drop
  it in a later migration once nothing reads it). Do not silently drop the table
  in the same migration that imports it.
- Confirm target DB before running (`localhost:5433` local;
  `unset DATABASE_URL` to avoid shell shadowing). Verify with a `SELECT` after.
- Ingestion node-property additions (`conformanceScore`, `schemaVersionId`) and
  the §3.3 dual-write (real primary label, transitional `:EntityNode` secondary)
  are Neo4j property/label writes — no Postgres migration, applied by
  `upsertEntityNode`. The §3.3 batch relabel is its own later database-migration /
  job milestone (the *graph* operation it performs is still "reconcile", §3.3).

## 11. Security / Tenancy

- **RLS** on every `schema_registry` table (including `schemas` and
  `schema_activations`) via the standard `tenant_isolation` policy (org_id +
  workspace_id), using `withTenantDb` / `scopedSession`. Raw `db()` is banned.
  Reconcile runs reuse `agent_executions`, which already carries RLS.
- **IAM gates:** mutators require workspace Owner/Member; config + pin +
  **schema toggle** + reconcile require Admin (blast radius: pinning and toggling
  schemas re-grounds all future ingestion; reconcile rewrites the graph). Because
  **`apps/app` does not bootstrap IAM**, every app call site adds explicit
  `assertBillingManager`-style gates (`assertOrgMember` / Admin assertion).
  MCP and API go through `invoke()` which enforces IAM.
- **Export** is served only through the access-controlled
  `/api/v1/assets/<publicId>` route (same as `archive.create`); no public blob
  URLs.
- **Tenant isolation in reconcile:** the Inngest worker uses `scopedSession()`
  so no cross-tenant node can be read or written.
- **Cypher-injection safety (§3.2):** the lexical `RELATIONSHIP_TYPE_PATTERN`
  guard is always on at every Cypher seam; the active-vocabulary allow-list
  layers on when a version is pinned. No relationship type reaches Cypher
  unguarded.
- **Prompt-injection posture:** AI-authored descriptions and chat input are
  treated as untrusted; they are stored as plain data and never executed.
  Property `description` text injected into ingestion prompts is clearly fenced
  as data context, not instructions.

## 12. Observability

- Every contract invocation emits metering + duration + surface tagging through
  `invoke()` / `@oxagen/ai` (token analytics to ClickHouse).
- Observed labels/relationship types → `graph_observed_labels` (ClickHouse).
- Per-write conformance → `schema_conformance_events` (ClickHouse).
- Reconcile progress → ClickHouse events + the `agent_executions` row's `state`
  counters (Postgres durable, §4.7).
- Lineage edges for reconcile writes flow through the existing graph-sync path and
  the `agent_executions` `parent_execution_id` chain.

## 13. Testing

- **Unit (per package, narrow):**
  - Contracts: schema/shape tests beside each `schema.*.ts`
    (`packages/oxagen/src/contracts/schema.*.test.ts`), including `schema.list`
    and `schema.toggle`.
  - Validator: `packages/ingestion/src/validate/schema.test.ts` — required,
    type, enum, constraint, conformance-score math (named-constant weights), all
    three enforcement modes.
  - Pin resolution + **active-vocabulary** filtering: `getPinnedSchema` returns
    only enabled schemas' labels/relationship types; a disabled schema's labels
    are absent from grounding and validation.
  - **Non-destructive disable:** disabling a schema (`schema.toggle`) narrows the
    active vocabulary but a test asserts existing Neo4j nodes/relationships for
    that schema's labels remain queryable (no delete).
  - **Activation auto-publishes + auto-pins (north-star §2.0, §1.4):**
    `schema.toggle enabled=true` with a dirty draft publishes a new immutable
    version AND moves the workspace pin to it (asserts a new `schema_versions` row
    + updated `registries.pinned_version_id`), and returns
    `reconcileRecommended=true`; with a clean draft it pins the already-published
    version without creating a duplicate. **No separate `version.create`/`pin`
    call is required** in the flow.
  - **Activation never edits a frozen version:** toggling freezes the *draft* into
    a new version and re-pins; it does not mutate any prior published version row;
    a schema disabled in version N stays disabled after version N+1 is published
    (enabled state read from `schema_activations`, keyed by schema identity).
  - **Born disabled/draft:** a schema created via `schema.label.upsert` /
    `schema.chat` / `schema.recommend` lands with `enabled=false` and does not
    appear in `getPinnedSchema`'s active vocabulary until activated.
  - **Additive re-prompting (north-star §2.0):** applying a second `schema.chat`
    proposal onto a draft that already has labels from a first prompt leaves the
    first prompt's labels/properties intact (asserts no wipe) unless the second
    explicitly changes them.
  - **Cypher-injection regression:** `ontology.neighbors` / `ontology.query` /
    `graph.relationship.upsert` reject relationship types failing
    `RELATIONSHIP_TYPE_PATTERN` (e.g. `` `]->()-[:x` ``) and, when a version is
    pinned, reject types absent from the active vocabulary — replacing the old
    `GRAPH_EDGE_TYPES` membership tests.
  - **Deprecation alias:** `graph.edge.upsert` / `semantic.edge.*` aliases route
    to the renamed contracts and emit the deprecation note (§1.2, §10).
  - Recommender input: seeds from `graph.stats` + `graph_observed_labels` +
    enabled schemas, and does **not** read `ingestion.entity_types`.
  - Reconcile run ledger (v2): `schema.reconcile.dispatch` writes an
    `agent_executions` row with `origin_type='schema.reconcile.dispatch'`;
    `schema.reconcile.status` projects counters from `state`; additive-only vs.
    `prune` removal, audit-trail counters, additive default never deletes.
- **Integration:** `runPipeline` with a pinned schema → assert grounding context
  (active vocabulary only) injected, conformance score on result, `strict`
  rejection path, `lenient` write-below-floor path; a disabled schema's label is
  not grounded/validated.
- **Visual gate (v1 — replaces E2E for v1; see §14):** every NEW component we
  build ships a **Storybook story** and is screenshotted in light + dark mode,
  reviewed by an LLM judge:
  - **App components** (`apps/app`, e.g. the §6 `schema-builder/*`) → stories in
    the **app Storybook** (`apps/app` `pnpm storybook`, port **6007**).
  - **Shared / package components** (`@oxagen/ui` or any `packages/*` we touch) →
    stories in **that package's Storybook** (e.g. `@oxagen/ui` Storybook, port
    **6008**).
  - For each story, capture **screenshots in BOTH light and dark mode** to a
    gitignored screenshots dir that is deleted + recreated each run.
  - An **LLM judge** reviews the screenshots for **color-contrast issues (WCAG
    AA)** and **style/layout bugs** (overflow, clipping, misalignment, theme-token
    misuse). The v1 gate **fails on any flagged high-severity issue.** This
    **complements** (does not replace) the unit + coverage thresholds.
- **E2E (`apps/app/e2e/`) — v2.** The Playwright E2E suite (prompt the AI assistant
  drawer to scaffold a multi-schema ontology landing disabled/draft, drill into a
  label and edit a property, re-prompt and confirm prior work survives, **activate
  a schema and confirm it auto-publishes + pins** ("ready for use"), toggle a
  schema off and confirm its labels drop from the active vocabulary while graph
  data stays queryable, export ZIP; screenshots to
  `apps/app/e2e/screenshots/`, recreated each run, gitignored) lands in **v2**,
  alongside the reconciliation workers. v1 does **not** require Playwright E2E.
- Coverage stays at/above each package's `vitest.config.ts` thresholds; bump
  only up to `floor(current − 2.5)`, capped at 90. **Run only the narrow tests
  for changed files — never the full suite.**

## 14. Phasing

- **v1 — Define / Compose / Version / Validate / Export.** Tables §4.1–4.6
  (`registries`, `schema_versions`, `schemas`, `schema_activations`,
  `node_labels`, `relationship_types`, `properties`); all `schema.*` authoring,
  version, pin, diff, export, recommend, chat, validate, **`schema.list` /
  `schema.toggle`**, and `setup` contracts; the **`GRAPH_EDGE_TYPES` removal +
  Cypher-safety guard (§3.2)**; the **canonical vocabulary (§1.2)** across all
  surfaces, including the **`graph.edge.upsert` → `graph.relationship.upsert` and
  `semantic.edge.* → semantic.relationship.*` renames with one-release deprecation
  aliases**; ingestion grounding + property validation seam against the **active
  vocabulary** (§8); enforcement modes; conformance scoring + ClickHouse
  telemetry (`graph_observed_labels` + `schema_conformance_events`); the
  **`ingestion.entity_types` sunset** import + recommender repoint (§10); the
  start of the §3.3 **dual-write** (ingestion writes real labels); builder UI +
  chat + **schemas list with enable/disable toggles**; configurable recommender
  sampling; the `schema.setup` walkthrough with enable/disable.
  **v1 completion gate = unit tests + coverage thresholds + the §13 Storybook /
  light-dark-screenshot / LLM-judge visual gate.** E2E is explicitly deferred to
  v2.
- **v2 — Reconciliation workers + physical relabel + E2E.** §4.7 (reuse of
  `agent_executions`) + §9: `schema.reconcile.dispatch` / `.status`, Inngest
  fanout, pin-change prompt, progress reporting on the `agent_executions` row,
  best-effort backfill of existing graph, the opt-in **prune** mode (API/MCP argument
  / UI knob) with audit trail; the §3.3 **batch relabel** off
  `:EntityNode {entityType}` to first-class labels (shares the paging machinery),
  followed by dropping `entityType` and the `:EntityNode` secondary label; and the
  **Playwright E2E suite** (§13). Also **remove the one-release deprecation
  aliases** for `graph.edge.upsert` / `semantic.edge.*` once callers have migrated.
- **v3 — GitOps / source-control sync.** Bidirectional sync of the ZIP/manifest
  format with a customer repo (pull schema from VCS, push on publish), PR-based
  schema review. Explicitly **out of scope for v1/v2**; the §15 export manifest
  layout is designed to be VCS-friendly to enable it later.

## 15. Export Manifest Layout (designed for future GitOps)

`schema.export` produces a ZIP via the `archive.create` plumbing, grouped by
schema:

```
schema/
  manifest.json                  # version metadata: versionNumber, label, publishedAt, enforcementMode, schemas[] (name, source, enabled)
  schemas/
    sales_crm/
      labels/
        Customer.json            # one file per node label: description, naturalKeyProps, properties[]
        Contract.json
      relationships/
        SIGNED_CONTRACT.json     # one file per relationship type: startLabel, endLabel, cardinality, description, properties[]
```

One file per label/relationship type, grouped by schema, keeps diffs small and
review-friendly (the v3 GitOps goal). `manifest.json` is the index and records
each schema's `enabled` state. JSON (not YAML) to match the `jsonb` storage and
avoid a parser dependency on the read path.

## 16. Resolved Decisions

All originally-open questions are now decided (signed off):

1. **No prescribed relationship types or node labels.** The fixed
   `GRAPH_EDGE_TYPES` enum is **removed in v1** (§3.2); customers define every
   relationship type in the registry. Node labels were already free strings.
   Validation moves to the registry's **active vocabulary**, with a lexical
   identifier guard (`^[A-Z][A-Z0-9_]{0,62}$`, `RELATIONSHIP_TYPE_PATTERN`)
   preserving Cypher-injection safety in the ontology query layer. This is v1
   scope, not a follow-up.
2. **Conformance score formula — accepted.** `score = 1 − (weighted
   missing-required + type-error penalties) / total-evaluated-properties`, with
   required-property misses weighted higher than optional/type penalties. Exact
   weights are encoded as named constants in `validate/schema.ts` and unit-tested.
3. **Draft model — single shared workspace draft, last-writer-wins.** One mutable
   `draft` version row per workspace; concurrent edits resolve last-writer-wins at
   the property-row level. No per-user drafts.
4. **Recommender sampling — configurable, default 200.** `sampleLimit` defaults to
   200 nodes and is exposed as a UI inference-depth control and an
   API/MCP argument; the agent may request more samples on user request or
   thin coverage, up to a hard ceiling. Surfaced first-class via the
   `schema.setup` LLM-assisted walkthrough, mirroring the app onboarding.
5. **Reconcile pruning — supported, opt-in.** `schema.reconcile.dispatch` takes a
   `prune` flag (default `false`, additive-only). When set it removes off-schema
   properties, audited via the `agent_executions` `state.prunedPropertyKeys` map +
   `outcome=pruned` ClickHouse events, behind an Admin gate and a confirmed
   destructive-action opt-in. Exposed as the API/MCP `prune` argument and the
   pin-change-dialog UI knob. Pruning is the **only** destructive path — disabling
   a schema is not (decision 8).
6. **Canonical Neo4j vocabulary — adopted (§1.2), grounded in Neo4j's official
   docs.** All graph-data prose, columns, and contract identifiers use **node /
   label (node label) / relationship / relationship type / property / start node /
   end node** — the exact terms from Neo4j *Getting Started* (graph database
   concepts + data modeling). "Entity" / "entity type" / "edge type" are banned for
   the data model. The label **is** the node's type (`:Customer`), not
   `:EntityNode {entityType}` (§1.2.1); the physical migration off
   `:EntityNode {entityType}` is phased (§3.3), with v1 establishing the
   vocabulary + dual-write and v2 doing the batch relabel. The legacy
   `graph.edge.upsert` / `semantic.edge.*` contracts are **renamed in v1**
   (`graph.relationship.upsert` / `semantic.relationship.*`) with **one-release
   deprecation aliases** (removed in v2) — the rename is in scope, not deferred.
7. **`ingestion.entity_types` sunset — decided (§1.3, §3.1, §10).** The registry
   is the single authoritative vocabulary. *Observation* moves to ClickHouse
   (`graph_observed_labels`) per the four-store law; the recommender seeds from
   `graph.stats` + that telemetry + sampled `ontology.query` + the workspace's
   enabled schemas, **not** from `entity_types`. Existing rows are imported once
   into the registry as a `recommended` starter schema, then the table is
   deprecated. No "entity"-named Postgres replacement is introduced.
8. **Per-workspace enable/disable of schemas — yes, non-destructive, and
   activation auto-publishes + auto-pins (§1.4, north-star §2.0).** A registry is
   composed of named **schemas** (connector / user / recommended), each
   independently enabled/disabled via `schema.list` + `schema.toggle` (UI
   toggles). New schemas are **born
   disabled/draft** and have no graph effect until activated. **Activating a
   schema is the go-live trigger: it auto-publishes the current draft (if it has
   unpublished edits) and auto-pins the resulting immutable version — the user
   performs no separate publish/pin step** (this is the north-star "inactivating
   and activating schemas would automatically set the schema version pinned and
   publish the schema ready for use"). The **active vocabulary** is the union of
   labels + relationship types across *enabled* schemas of the pinned version,
   used for grounding, validation, the §3.2 allow-list, and recommendation.
   Disabling is **hard-non-destructive** — it re-pins to reflect the narrowed
   active set but never deletes or orphans Neo4j data; destructive cleanup is only
   the gated reconcile `--prune`. Immutability is preserved: schema *definitions*
   live in versioned/immutable snapshots and **activation never edits a frozen
   version** — it freezes the draft into a *new* version and moves the pin;
   *enabled state* is current config in a separate `schema_activations` table
   keyed by stable schema identity, so a schema disabled in version N stays
   disabled when N+1 publishes. The explicit `schema.version.create` /
   `schema.version.pin` contracts remain for advanced manual control and are what
   `schema.toggle` calls internally.
9. **Reconcile run ledger — reuse `agent_executions`, no bespoke table (§4.7).**
   A reconcile run is one `agent_executions` row
   (`origin_type='schema.reconcile.dispatch'`, `origin_id` = registry/version id,
   `input_payload = { fromVersionId, toVersionId, prune }`); progress counters and
   the `prunedPropertyKeys` audit map live in its `state`/`output_payload` jsonb;
   token/cost/latency/lineage are inherited. `schema.reconcile.dispatch` returns
   the `aex_…` `executionId`; `schema.reconcile.status` reads it back. The bespoke
   `reconcile_jobs` table is dropped. Per-write prune + conformance detail stays in
   ClickHouse `schema_conformance_events`.
10. **Reconcile is never called "migration" (§3.3).** The graph-data re-derivation
    process is always **reconcile / reconciliation**; "migration" is reserved for
    Atlas/Drizzle database migrations (`packages/database/migrations/`,
    `pnpm db:migrate`). The verb discipline holds in prose even though no
    reconcile *table* exists to mis-name (decision 9).
11. **E2E deferred to v2; v1 gate is the Storybook visual gate (§13, §14).** v1
    requires unit tests + coverage thresholds + a Storybook story for every new
    component (app Storybook port 6007; package Storybook e.g. `@oxagen/ui` port
    6008), with light + dark screenshots reviewed by an **LLM judge** for WCAG-AA
    contrast and style/layout bugs (high-severity flags fail the gate). The
    Playwright E2E suite lands in v2 with the reconciliation workers.

No open questions remain blocking implementation.
