# /goal — Oxagen v2 Multi-Source Knowledge Graph Platform

**Date:** 2026-06-10  
**Status:** Superseded for launch; retained as historical design evidence.

> **Superseded for launch (2026-07-21).** This design is retained as historical
> context, not as the current launch contract. Generic graph mutation/raw Cypher,
> central source-file/symbol/chunk ingestion, and confidence-based auto-accept are
> retired. Exact code graphs stay local; Oxagen keeps governed source facts and
> stable provider metadata. Canonical protected/default-ref topology and a typed
> evidence ledger are follow-ups. The legacy semantic-edge infer/review family is
> retired; a future candidate model requires a new governed specification.

---

## Vision

Oxagen is a **generic, configuration-driven, multi-source knowledge graph platform** where:

- Customers connect disparate data sources (code repos, Google Drive, Slack, Linear, Salesforce, CRM, databases, etc.) into a **workspace-scoped, partitioned Neo4j graph**
- **LLM-driven semantic inference** extracts entities, relationships, and features *within* and *across* sources
- **Custom ontology prompts per connector** let customers define what to extract and how to relate it to their domain (not just SaaS/code)
- **Semantic edges** link inferred concepts across sources (e.g., a Google Drive spec document related to a GitHub feature by shared intent)
- **Plugin architecture** allows partners to build their own connectors via YAML schema + custom inference prompts
- **Full surface parity:** Any source configuration reachable identically via UI, API, MCP, CLI

**Not a SaaS-specific tool.** Oxagen works for enterprises, agencies, researchers, nonprofits—any organization connecting multiple data sources to get rich AI context. The customer defines the ontology, not the tool.

---

## Core Design Principles

1. **Configuration-driven, not prescriptive.** The system does not assume "features," "components," "PRs," or "documents." Each connector is configured by the customer to extract what THEY need via a custom `ontologyPrompt`.

2. **Generic entity types and relationships.** Rather than hard-coding `Function`, `Feature`, `IMPLEMENTS`, customers define their own via the schema. The platform is agnostic about what entities and edges exist.

3. **Per-connector inference toggle.** Feature inference is enabled/disabled and configured per connector/plugin instance, not workspace-wide. Different sources may have different inference strategies.

4. **Bring back YAML-driven dynamic UI from v1.** V1 (oxagen-platform) had a YAML manifest that drove connector setup UI generatively — zero frontend code per connector. V2 lost this. Restore it with richer field types (secret inputs, URLs with validation, etc.).

5. **No prescriptive cross-source relationships.** Cross-source inference is emergent from the graph + prompt, not wired in the schema. The customer's `semanticEdgePrompt` guides what relationships to infer across sources.

6. **Workspace-scoped, partitioned graphs.** Every node and edge is scoped to (orgId, workspaceId). Customers see their own isolated knowledge graph.

---

## Architecture Overview

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: DATA INGESTION (repo.*, integration.*)                 │
│  ├─ repo.create/configure/sync — code repository connectors      │
│  ├─ integration.install/configure/sync — plugin instances        │
│  ├─ connection.* — OAuth-credential-based connections (legacy)   │
│  └─ Plugin schema fetched at install; YAML drives dynamic UI     │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: INGESTION PIPELINE (existing, + filter enforcement)    │
│  Stages: receive → normalize → map → dedup → embed → infer      │
│  ├─ Reads deliveryConfig (filters, record types, sync cadence)   │
│  ├─ Enforces path/label filters at normalize stage               │
│  ├─ Schedules per-connector inference per perRecordType config   │
│  └─ Emits entities + inferred edges to Neo4j (workspace-scoped)  │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: SEMANTIC INFERENCE (semantic.edge.*)                   │
│  ├─ semantic.edge.infer — LLM-driven cross-source linking       │
│  ├─ Reads ontologyPrompt + semanticEdgePrompt from config       │
│  ├─ Infers edges between any nodes with confidence scoring      │
│  └─ User approves edges above threshold; reviews below           │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: GRAPH ACCESS (graph.*, agent.memory.*, AI agents)      │
│  ├─ Agents query Neo4j for rich context via MCP                 │
│  ├─ graph.node.search, graph.cypher for ad-hoc queries          │
│  └─ workspace.model.settings for custom system prompts           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Contract Family (20 New + Enhanced Contracts)

### Domain: `repo.*` (Repository/Code Ingestion)

Specialization on `connection.*` for code repositories. A repo connection is always backed by a `connection` row with `connectorId ∈ {github, gitlab, bitbucket, azure-devops}`.

| Contract | Mode | Purpose |
|---|---|---|
| `repo.configure` | sync | Set repo-specific config: filters, inference toggles, sync cadence, field mappings |
| `repo.sync` | async | Trigger incremental or full re-index |
| `repo.pause` / `repo.resume` | sync | Pause/resume sync loop |
| `repo.metrics` | sync | Sync stats (entities by type, last sync, error log) |

**Surfaces:** API, MCP, CLI, Agent  
**Scope:** Workspace-scoped  
**Notes:** `repo.create/list/get/delete` delegate to `connection.*` with validated `connectorId`

---

### Domain: `integration.*` (Plugin Instance Management)

Manages installed plugin instances at workspace scope. A plugin is a configured, running data source connector with a schema.

| Contract | Mode | Purpose |
|---|---|---|
| `integration.install` | async | Install a plugin from catalog or custom URL |
| `integration.configure` | sync | Patch plugin config, credentials, sync cadence, inference toggles |
| `integration.list` | sync | Browse installed plugins + status |
| `integration.get` | sync | Single plugin details |
| `integration.sync` | async | Trigger plugin sync |
| `integration.metrics` | sync | Sync stats |
| `integration.delete` | async | Remove plugin + optionally purge graph data |

**Surfaces:** API, MCP, CLI, Agent  
**Scope:** Workspace-scoped  
**Relationship:** Replaces manual connection setup with schema-driven install flow

---

### Domain: `plugin.schema.*` and `plugin.version.*` (Genuine Gaps)

Bridge between the plugin registry and dynamic form rendering.

| Contract | Mode | Purpose |
|---|---|---|
| `plugin.schema.get` | sync | Fetch typed config schema for dynamic form rendering |
| `plugin.schema.validate` | sync | Validate config against schema before install/configure |
| `plugin.version.list` | sync | Version history, changelog, breaking-change flags |

**Surfaces:** API, MCP, Agent  
**Scope:** Org-level  
**Output:** Field-level typed schema (not opaque JSON) for form rendering

---

### Retired domain: Cross-source semantic-edge inference

This historical design proposed LLM-driven relationship extraction across workspace nodes. The entire infer/review capability family is retired for launch and must not be reimplemented from this document.

**Launch disposition:** no API, MCP, agent, CLI, or app surface. A replacement must define attributable candidate records, explicit approval authority, audit events, invalidation, and revocation before relationships are materialized.

---

### Domain: `graph.*` (Enhancements)

Existing `graph.node.upsert/get/search/delete`, `graph.edge.upsert/delete`, `graph.cypher` remain unchanged. Two new contracts:

| Contract | Mode | Purpose |
|---|---|---|
| `graph.node.list` | sync | Paginated browse (enables graph explorer UI) |
| `graph.stats` | sync | Workspace graph statistics (node count, entity types, inferred edge count) |

---

## YAML Schema System (Plugin Configuration Format)

### Design: YAML Format, Field-Level Typed, Version-Independent

The YAML schema is the **single authoritative description** of a connector's configuration surface. It is:
- Serializable and fetchable over HTTP (language-agnostic)
- Version-tagged (SemVer for connector, independent schema format version)
- Self-describing enough that a form renderer needs zero per-connector code
- Able to express: auth schemes, config fields, record types, filters, inference toggles, sync cadence, field mappings

**Built-in connectors:** co-located `schema.yaml` in the repo + TypeScript `connectionConfigSchema: z.ZodTypeAny`. A `pnpm check:connector-schemas` gate verifies alignment.

**Partner plugins:** YAML fetched at install time via `schemaUrl`, cached in `connector_schemas` table, re-fetched on version change.

### Schema Structure (Top-Level)

```yaml
apiVersion: oxagen.ai/v1alpha1          # Format version (never changes)
kind: ConnectorPlugin                    # Always "ConnectorPlugin"

metadata:
  id: github                             # Must match connector ID
  displayName: GitHub
  description: ...
  icon: github
  category: developer-tools
  version: "1.3.0"                       # SemVer (independent of schema version)
  schemaVersion: "1"                     # The apiVersion schema format
  publisher:
    name: Oxagen
    verified: true                       # false for partner plugins

auth:                                    # Auth scheme options
  schemes:
    - id: oauth2
      kind: oauth2_authorization_code
      scopes: [repo, read:org]
    - id: pat
      kind: api_key
      fields:
        - key: apiKey
          label: Personal Access Token
          widget: secret                 # Masked input, never logged

config:                                  # Non-auth config (org, repos, filters, etc.)
  fields:
    - key: organizations
      label: Organizations
      widget: tag-input
      description: ...
      validation:
        required: true
        minItems: 1
        itemPattern: "^[a-zA-Z0-9][a-zA-Z0-9\\-]{0,38}$"

recordTypes:                             # What the connector exposes
  selectionMode: multi
  defaultAll: false
  items:
    - id: pull_request
      displayName: Pull Requests
      description: ...
      defaultEnabled: true

filters:                                 # Path/label/entity filters
  pathFilters:
    enabled: true
    defaultIgnore: ["node_modules/**", ".git/**"]
    appliesTo: [source]
  labelFilters:
    enabled: true
    appliesTo: [issue, pull_request]

inference:                               # Inference config (per-connector toggle + custom prompt)
  enabled: true
  defaultEnabled: true
  toggleLabel: Enable AI relationship inference
  perRecordType:
    pull_request: true
    issue: true
    commit: false
  confidenceThreshold:
    defaultValue: 0.75
    min: 0.50
    max: 0.99
  ontologyPrompt: |                      # CUSTOMER-PROVIDED CUSTOM PROMPT
    Infer semantic features from GitHub entities.
    Create edges: PullRequest -[implements]-> Feature, Issue -[depends_on]-> Service.
    Extract architectural domains: auth, billing, api, ui.

sync:                                    # Sync model
  delivery: webhook                      # webhook | polling | manual
  pollingSupported: true
  polling:
    defaultIntervalSeconds: 300
    minIntervalSeconds: 60

defaultFieldMappings:                    # Starting field→property map suggestions
  pull_request:
    title: title
    body: description
    author: author
    state: status
```

### Widget Types

| Widget | Component | Value Type | Use Case |
|---|---|---|---|
| `text`, `email`, `url` | Input | string | Free-form text, email, URL |
| `secret` | Input (password) | string | API key, token (masked, never logged) |
| `number` | Input (type=number) | number | Numeric config (depth, threshold) |
| `textarea` | Textarea | string | Multi-line text, prompts |
| `select` | Select | string | Single choice from options |
| `multi-select` | Combobox | string[] | Multiple choices |
| `tag-input` | Combobox (free) | string[] | Comma-separated or Enter-separated tags |
| `checkbox` | Switch | boolean | Toggle |
| `slider` | Slider | number | Range with marks |
| `key-value` | KeyValueEditor | Record | Custom object pairs |
| `secret-file` | FileUpload | string (base64) | Service account JSON, certs |

### Validation

Each field carries optional `validation` rules:
```yaml
validation:
  required: boolean
  min: number
  max: number
  minItems: number
  maxItems: number
  pattern: string                      # Regex for text
  itemPattern: string                  # Regex per tag-input item
  oneOf: string[]                      # Enum allowlist
```

Client-side validation on blur + server-side Zod validation on submit.

### Custom Ontology & Inference Prompts

Each connector's `inference.ontologyPrompt` is **customer-provided** (set during setup or in `integration.configure`). Examples:

**GitHub connector (for a SaaS company):**
```
Infer product features from PR titles, issue bodies, and code comments.
Create edges: Feature -[implemented_by]-> PullRequest, Feature -[tracked_by]-> Issue.
Extract architectural domains (api, web, mobile, infra).
```

**Google Drive connector (for same company):**
```
Extract specification documents and design proposals.
Link to features by semantic similarity (same feature name, tech term matches, author overlaps).
Create edges: GoogleDoc -[specifies]-> Feature, GoogleDoc -[relates_to]-> LinkedIssue.
```

**Salesforce connector (for same company):**
```
Extract customer needs, account hierarchies, opportunity stage.
Link to GitHub features that address customer needs.
Create edges: Opportunity -[addresses]-> Feature, Contact -[author_of]-> GithubIssue.
```

Each customer defines their own ontology via these prompts. **The platform is agnostic.**

---

## Implementation Roadmap

### Phase 1: Contract Layer (Weeks 1–2)

**Deliverables:**
- Define 20 contracts in `packages/oxagen/src/contracts/` (repo.*, integration.*, plugin.schema.*, semantic.edge.*, graph.node.list, graph.stats)
- Implement API routes in `apps/api/src/routes/v1/` (create endpoints for all contracts)
- Implement MCP tools in `apps/mcp/src/tools/` (expose all contracts via MCP)
- Implement CLI commands in `apps/cli/src/commands/` (repo, integration, semantic, graph commands)

**API parity checks:** `pnpm check:manifest` should list all three surfaces (api, mcp, cli) for all contracts except internal ones.

### Phase 2: YAML Schema System (Weeks 3–4)

**Deliverables:**
- Add `ConnectorPluginSchema` Zod object in `packages/ingestion/src/connectors/schema.ts`
- Create `schema.yaml` files for all 15 built-in connectors (GitHub, Google Drive, Slack, Linear, Salesforce, etc.)
- Add `connector_schemas` table to Postgres schema
- Implement `plugin.schema.get`, `plugin.schema.validate` contract handlers
- Add `schemaUrl` fetch + cache logic to the install pathway

**Build gate:** `pnpm check:connector-schemas` verifies Zod ↔ YAML alignment for each built-in.

### Phase 3: Dynamic Form Renderer (Weeks 5–6)

**Deliverables:**
- Update `apps/app/src/components/connectors/` with schema-driven form components:
  - `connector-schema-provider.tsx` — context wrapping schema + form state
  - `connector-config-form.tsx` — top-level form (renders all panels)
  - `field-renderer.tsx` — per-field rendering decision tree (dependency logic, validation)
  - `auth-scheme-picker.tsx`, `record-type-selector.tsx`, `filters-panel.tsx`, `inference-panel.tsx`, `sync-cadence-panel.tsx`
  - `key-value-editor.tsx`, `secret-file-upload.tsx` — new primitives
- Replace `github-connection-wizard.tsx` (777-line hand-coded component) with a generic connection setup flow driven by the schema
- Full surface parity: UI, API, MCP, CLI all accept same config shape

### Phase 4: Filter Enforcement & Sync Orchestration (Weeks 7–8)

**Deliverables:**
- Extend `ingestion.pipeline.ts` to read and enforce `deliveryConfig` filters:
  - Stage 1 (receive): Record type filter
  - Stage 2 (normalize): Path filter, label filter
  - Stage 5 (embed): Inference gate (per-recordType)
- Extend `ingestion.github-parse-file.ts` to read `ontologyPrompt` from connection config and pass to LLM
- Extend `ingestion.github-infer-features.ts` (and add cross-source inference worker) to read `semanticEdgePrompt` and infer edges per-source

### Phase 5: Semantic Edge Inference (retired)

**Launch disposition:** do not implement these deliverables. Relationship inference and its review UI require a replacement governed-candidate specification.

### Phase 6: Partner Plugin Support (Weeks 11–12)

**Deliverables:**
- Implement partner plugin install flow: custom URL → fetch YAML → validate → cache → install
- Add version update notification to org admins when a newer version is available in the catalog
- Document how partners author connector YAML + custom ontology prompts
- Build example partner connector (to prove the pattern)

---

## End-to-End Example: GitHub Code + Google Drive Specs

### Scenario

A SaaS company has:
- GitHub monorepo with features tracked as issues and implemented via PRs
- Google Drive with design specs and technical proposals
- They want to link features to their docs, and have the AI suggest connections

### Setup (UI)

**Step 1: Install GitHub connector**
1. Admin goes to `/workspace/sources` → "Add Data Source" → selects "GitHub"
2. UI fetches schema from `GET /api/v1/plugin-schema/github`
3. Auth picker shows: "Connect with GitHub (OAuth)" and "Personal Access Token"
4. Admin chooses OAuth → redirected to GitHub
5. Config form shows: Organizations (required), Repositories (optional), Initial sync depth, Record types checklist
6. Admin selects: org=`acme-corp`, record types=`[pull_request, issue, release, source]`
7. Filters panel: Path filters shows default ignore list (node_modules, dist, .git, etc.)
8. Inference panel: Toggle ON, Confidence threshold=0.75
9. **Custom prompt field:**
   ```
   Extract product features from GitHub entities.
   Features are inferred from:
   - Issue titles containing "Feature:" prefix or "feature request" label
   - PR titles matching the same issues
   - Code comments mentioning feature names
   
   Create edges:
   - Feature -[implemented_by]-> PullRequest (when PR is merged)
   - Feature -[tracked_by]-> Issue
   - Feature -[archived]-> Release (when feature is in release notes)
   - Service -[depends_on]-> Service (when PR imports another service)
   
   Extract architectural domains from the codebase: api, web, mobile, infra.
   Tag entities with their domain.
   ```
10. Sync cadence: Webhook (push events) + fallback polling (5 min)
11. Click "Start Initial Sync"

**Step 2: Install Google Drive connector**
1. Admin clicks "Add Data Source" → selects "Google Drive"
2. UI fetches schema: similar flow, auth via Google OAuth
3. Config form: Shared drives only? (no), Root folder IDs (optional), File types=`[Google Docs, Spreadsheets, PDFs]`, Exclude trashed? (yes)
4. Filters: Name patterns to ignore (e.g. `~$*` for Office temp files)
5. Inference panel: Toggle ON (enabled by default for Drive), Confidence=0.80 (higher threshold due to prose)
6. **Custom prompt:**
   ```
   Extract specifications, design decisions, and requirements from Drive documents.
   Look for:
   - Documents mentioning feature names or service names from our codebase
   - Acceptance criteria, design rationale, API contracts
   - Author mentions or team ownership
   
   Create edges:
   - GoogleDoc -[specifies]-> Feature (when doc describes the feature)
   - GoogleDoc -[references]-> PullRequest (when doc mentions a PR number or GitHub URL)
   - GoogleDoc -[authored_by]-> GithubUser (when doc author matches GitHub handle)
   - Service -[depends_on]-> ExternalAPI (when doc describes integration)
   
   Cross-source links:
   - If a doc mentions a feature by name, link to the Feature node inferred from code
   - If a doc mentions a GitHub issue #123, reference that Issue node
   ```
7. Sync cadence: Polling (every 15 minutes)
8. Click "Start Initial Sync"

### Ingestion

**GitHub Sync:**
1. Webhook fires on PR push → `POST /v1/ingest/github/push`
2. Pipeline stages:
   - **Stage 1 (receive):** Record type filter: only `pull_request`, `issue`, `release`, `source`
   - **Stage 2 (normalize):** Path filter: skip files matching `node_modules/**`, `dist/**`, etc.
   - **Stage 3 (map):** Map to workspace ontology (field mappings: PR title → title, body → description, etc.)
   - **Stage 4 (dedup):** Check for existing PRs; create or update
   - **Stage 5 (embed):** Embed PR text + linked issues into vector
   - **Stage 6 (infer):** Read custom `ontologyPrompt`, call LLM → infer Features, Services, edges
     - **Example:** PR title "Implement OAuth login for web team" + merged status + destination branch=`main`
       - LLM creates: `Feature { name: "OAuth login", domain: "web" }`
       - LLM creates: `Feature -[implemented_by]-> PullRequest`
       - LLM creates: `PullRequest -[depends_on]-> Service { name: "auth-service" }`

**Google Drive Sync:**
1. Polling job fires every 15 minutes → check Drive for modified docs since last sync
2. Pipeline stages:
   - **Stage 1 (receive):** Record type filter: only `file` (Google Docs, Sheets, PDFs)
   - **Stage 2 (normalize):** Name filter: skip files matching `~$*` (Office temp files)
   - **Stage 3 (map):** Map doc metadata (name → title, created_time → createdAt, etc.)
   - **Stage 4 (dedup):** Check for existing docs; update if modified
   - **Stage 5 (embed):** Extract & embed full doc text (text-extraction from Docs/Sheets/PDFs)
   - **Stage 6 (infer):** Read custom `ontologyPrompt`, call LLM → infer entities + edges
     - **Example:** Doc titled "OAuth Login Feature Spec" + body containing "Feature: OAuth login", "Implemented in PR #4521", "Owned by web team"
       - LLM searches existing workspace graph for Feature matching "OAuth login" inferred from code
       - **Inference flags this as a candidate cross-source edge:** `GoogleDoc -[specifies]-> Feature`
       - Score: 0.92 confidence (high match on feature name + PR number)
       - **Rejected historical behavior:** the draft would have written the edge when confidence exceeded 0.80. Launch does not materialize model-generated relationships.

### Cross-Source Inference (Bonus Round)

Admin manually triggers: `semantic.edge.infer` with parameters:
- `sourceIds: [github_conn_id, gdrive_conn_id]` (consider both sources)
- `maxEdgesPerNode: 10` (limit explosion)
- `dryRun: false` (commit edges)
- **Custom `semanticEdgePrompt`:**
  ```
  Find relationships between GitHub features/services and Google Drive specifications.
  Link a Feature to a GoogleDoc if:
  - The doc title contains the feature name
  - The doc body mentions the feature or related PRs
  - The author of the doc is an author of related PRs or issues
  
  Link a Service to a GoogleDoc if:
  - The doc describes the service's API, integration, or architecture
  
  Output edge types:
  - Feature -[specified_by]-> GoogleDoc (doc is the spec for the feature)
  - Feature -[related_to]-> GoogleDoc (doc discusses the feature but isn't the primary spec)
  - Service -[documented_in]-> GoogleDoc (doc describes the service)
  ```

**Execution:**
1. Inngest job reads all Feature nodes + all GoogleDoc nodes in workspace
2. For each Feature, looks for GoogleDocs mentioning it by name
3. For each match, calls LLM with:
   - Feature node properties (name, domain, inferred properties)
   - GoogleDoc node properties (title, content excerpt, author)
   - Shared context (who authored the PR, who wrote the doc, any overlapping terms)
4. LLM outputs: `{ edgeType: "specified_by", confidence: 0.89 }`
5. **Rejected historical behavior:** the draft used confidence to choose auto-commit versus review. Launch exposes neither path.

### Graph Outcome

**Nodes:**
- Feature { name: "OAuth login", domain: "web", sourceId: "github_conn_123", createdAt: ... }
- PullRequest { title: "Implement OAuth login for web team", ... }
- GoogleDoc { name: "OAuth Login Feature Spec", sourceId: "gdrive_conn_456", ... }
- Service { name: "auth-service", ... }

**Edges:**
- Feature -[IMPLEMENTED_BY]-> PullRequest (inferred by GitHub inference)
- Feature -[SPECIFIED_BY]-> GoogleDoc (historical proposed relationship; not a launch materialization path)
- Service -[DEPENDS_ON]-> Service { name: "database" } (inferred from code)
- PullRequest -[AUTHORED_BY]-> GithubUser (extracted)

**AI Agent Query:**
```
Agent asks Neo4j:
  "What is the OAuth login feature, and what documents specify it?"
  
Response (via MCP graph.cypher or agent.memory.recall):
  Feature "OAuth login" (domain: web)
    ├─ Implemented by: PR #4521 "Implement OAuth login for web team"
    ├─ Specified by: Google Doc "OAuth Login Feature Spec"
    └─ Depends on: auth-service
```

Agent now has rich context: code implementation + design intent + architecture, all in one query.

---

## Success Criteria

### Functional
- [ ] 20 contracts fully implemented across API, MCP, CLI, Agent (no surface gaps)
- [ ] All 15 built-in connectors ship co-located `schema.yaml` + pass alignment check
- [ ] Dynamic form renderer works for all built-in connectors (no hand-coded per-connector wizards)
- [ ] `repo.configure` and `integration.configure` allow custom `ontologyPrompt` and `semanticEdgePrompt` per-connector
- [ ] Semantic edge inference reads custom prompts and infers edges with confidence scores
- [ ] Cross-source edges appear in Neo4j workspace graph with proper labels + source tracking

### Performance
- [ ] Schema fetch + validation < 2s for typical partner plugins
- [ ] Form render on schema load < 500ms (client-side)
- [ ] Inference job over 1000-node graph completes in < 60s

### Parity with v1
- [ ] YAML-driven dynamic UI (restore v1 pattern, improve with richer field types)
- [ ] Per-connector cost forecasting (via `ConnectorManifest.volumeEstimate`)
- [ ] Permission manifest (via schema `auth.schemes[].permissions` declaration)
- [ ] Trust tier at install time (org allow-list + denylist via existing `plugin.org_listings`)

### Documentation
- [ ] Partner connector authoring guide (how to write a YAML schema + prompts)
- [ ] Example partner connector (prove the pattern works)
- [ ] API reference for all 20 contracts
- [ ] CLI usage guide (oxagen repo, oxagen integration, oxagen semantic commands)

---

## Implementation Notes

### Critical Files to Modify

**Connector layer:**
- `packages/ingestion/src/connectors/types.ts` — add `schemaPath: string`, `deliveryConfigSchema: z.ZodTypeAny`, `ontologyPrompt?: string`
- `packages/ingestion/src/connectors/github/index.ts` — add co-located `schema.yaml`
- `packages/ingestion/src/connectors/{all}/index.ts` — add YAML schemas for all 15

**Database:**
- `packages/database/src/schema/ingestion.ts` — add `connector_schemas` table + migration

**API routes:**
- `apps/api/src/routes/v1/repo/*.ts` — implement repo.* handlers
- `apps/api/src/routes/v1/integration/*.ts` — implement integration.* handlers
- `apps/api/src/routes/v1/plugin/schema.ts` — implement plugin.schema.* handlers
- `apps/api/src/routes/v1/semantic-edge/*.ts` — implement semantic.edge.* handlers
- `apps/api/src/routes/v1/graph/*.ts` — add graph.node.list, graph.stats handlers

**MCP tools:**
- `apps/mcp/src/tools/repo.ts`, `integration.ts`, `semantic_edge.ts`, `graph.ts`

**CLI:**
- `apps/cli/src/commands/repo/`, `integration/`, `semantic/`, `graph/`

**Frontend:**
- `apps/app/src/components/connectors/` — generic schema-driven form components
- `apps/app/src/pages/[org]/[workspace]/sources/` — sources admin panel

**Ingestion pipeline:**
- `packages/ingestion/src/pipeline.ts` — add filter enforcement (record types, path, label)
- `packages/inngest-functions/src/functions/ingestion.github-parse-file.ts` — read `ontologyPrompt` from config
- `packages/inngest-functions/src/functions/ingestion.semantic-edge-infer.ts` — new, cross-source inference

### Testing Strategy

- **Unit:** Zod ↔ YAML schema alignment checks (`pnpm check:connector-schemas`)
- **Integration:** End-to-end setup flow (install → sync → graph population)
- **E2E:** Full GitHub + Google Drive scenario with cross-source inference approval flow

### Deployment Strategy

- Phased rollout: contract layer → schema system → form renderer → semantic inference
- Feature flags: `enable_semantic_edges_inference`, `enable_custom_ontology_prompts` (can be toggled per-workspace)
- No breaking changes to existing `connection.*` contracts or ingestion pipeline

---

## Appendix: Lessons from v1

**What worked in oxagen-platform:**
- YAML-first manifest drove zero-friction connector onboarding
- Field type system (number, string, string[], list, boolean) was sufficient for most connectors
- Cost forecasting via self-declared `ConnectorVolume` (rows/month, tokens/row)
- Trust tier enforcement at install time (first_party vs third_party)

**What didn't work (or was incomplete):**
- Limited field types (no secret, url, oauth_button, date, json, multi-select)
- Manifest pushed, not pulled (no registry discovery, no catalog)
- No org-level allow-list/denylist
- No multi-tenancy at connector level
- TypeScript-only schema (no portability)

**v2 improvements:**
- Richer field types (secret, url, key-value, file, code)
- Registry-based discovery (MCP spec) + catalog syncing
- Org allow-list + denylist + enable-per-workspace model
- YAML fetchable at runtime; supports partner plugins
- Version management + update notifications

---

## Historical next steps (retired)

1. **Kick off Phase 1** (Week 1): Contract definitions + API routes
2. **Parallel Phase 2** (Week 3): YAML schema system + migration scripts
3. **Parallel Phase 3** (Week 5): Dynamic form renderer + test coverage
4. **Phase 4** (Week 7): Pipeline filter enforcement + prompt injection
5. **Phase 5** (retired): relationship inference and approval UI require a replacement governed-candidate specification
6. **Phase 6** (Week 11): Partner plugin docs + example
7. **Ship** (Week 13): Roll out with feature flags, monitor adoption

---

**End of /goal**
