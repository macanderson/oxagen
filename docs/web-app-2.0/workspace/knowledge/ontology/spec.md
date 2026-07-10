---
# Ontology

- **Route:** `/{orgSlug}/{workspaceSlug}/knowledge/ontology`
- **Nav location:** workspace → Knowledge → tab "Ontology"
- **Priority:** P1
- **Disposition vs today:** Move

## Purpose
The schema that governs what the knowledge graph is allowed to mean — labels, properties, relationships, versioned and enforceable. It currently lives under Workspace Settings, filed as a generic admin config page, which buries the single artifact that makes graph grounding trustworthy rather than freeform. Moving it into Knowledge puts the ontology beside the graph, edges, and sources it governs, and leaves a redirect at the old location so existing links and muscle memory don't break.

## Primary user & jobs-to-be-done
- **Primary user:** workspace admin defining what the graph is allowed to contain
- **JTBD:**
  - See which schema labels/properties/relationships are defined and enabled
  - Get AI-assisted schema setup for a new domain (recommend → chat → apply → activate)
  - Version schema changes, diff them, and pin the graph to a version
  - Enforce conformance so ingested data can't silently drift from the schema
  - Reconcile already-ingested graph content against a pinned version

## Functionality
- **Schema list:** labels/properties/relationships with enabled toggles; admin-gated mutation, read-only for non-admins.
- **Editors:** label, property, and relationship upsert/delete forms with validation.
- **AI-assisted setup:** `schema.recommend` proposes a schema from observed graph content (ClickHouse `graph_observed_labels`); `schema.chat` refines it conversationally; apply + activate via `schema.setup` / `schema.toggle`.
- **Version history:** list of versions, diff between any two, pin the active/enforced version.
- **Registry enforcement mode:** strict/advisory toggle plus a conformance-floor threshold below which ingestion is blocked or flagged.
- **Validation:** ad-hoc "validate this node/relationship against the schema" check.
- **Reconcile:** dispatch a job to bring already-ingested graph content in line with the pinned version; status polling.
- **Export:** download the full schema as a ZIP.

## Capabilities invoked
- `schema.list` (`list_schemas`), `schema.setup` (`setup_schema`), `schema.chat` (`run_schema_chat`), `schema.recommend` (`recommend_schema`), `schema.toggle` (`toggle_schema`).
- `schema.registry.get` (`get_schema_registry`), `schema.registry.config` (`get_registry_config`) — enforcement mode + conformance floor.
- `schema.label.upsert` / `.delete`, `schema.property.upsert` / `.delete`, `schema.relationship.upsert` / `.delete` — editors.
- `schema.validate.node` / `schema.validate.relationship` — ad-hoc validation.
- `schema.version.create` / `.diff` / `.list` / `.pin` — version history.
- `schema.reconcile.dispatch` / `.status` — reconcile job.
- `schema.export` (`export_schema`) — ZIP export.

## Data sources
Postgres (schema registry + version history — source of truth), Neo4j (applied labels/relationships enforced against ingestion), ClickHouse (`graph_observed_labels` telemetry feeding `schema.recommend`).

## States
- **Empty:** no schema defined yet — "Get AI-assisted setup" CTA leads with `schema.recommend`.
- **Loading:** schema list and version history stream independently.
- **Error:** validation errors render inline per field; reconcile-job failure surfaces status + retry, not a silent stall.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/knowledge/page.tsx` is COMPLETE for the `SchemaBuilder` component (labels/properties/relationships, admin-gated). Move the route to `knowledge/ontology`, leave `settings/knowledge` as a redirect. All `schema.*` contracts omit `app` from `layers[]` today — declare it to fix the `check:ui-parity` reverse-parity gap.

## Vision alignment
The ontology is the grounding contract itself — versioned, time-aware, enforceable — not a settings afterthought; P1 because every cited answer is only as trustworthy as the schema constraining what got ingested.
