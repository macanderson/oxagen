# Spec — Universal Connector Framework: MCP servers, CLIs & direct databases as customer-definable data sources

**Date:** 2026-06-24 (rev. 2026-06-24 — added the SQL substrate and wired credential/network handling to the vault feature)
**Status:** Complete design spec (pre-implementation; supersedes the 2026-06-24 feasibility memo)
**Author:** Claude (with Mac Anderson)
**Related:**
- `docs/superpowers/specs/2026-06-24-mcp-as-connected-source-feasibility.md` (origin feasibility memo)
- `docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md` — **dependency.** Connector credentials (incl. DB connection strings), the sandbox the worker runs in, and **private-network reachability** (VPC / firewall) are all provided by the vault + environments + sandbox-templates feature. §8 and §6.3 below consume it.

---

## 1. Summary

Let a customer **build their own connector** in the product — no code, no per-server manifest authoring — by:

1. **Picking an MCP server already installed in their workspace** (auth, transport, and the tool catalog are already handled by the install), **or** pointing at a **CLI** the system runs in a sandbox.
2. **Designing the data's schema** in the shipped schema registry (labels, typed properties, relationships, and — critically — the **natural key**).
3. **Writing a custom prompt** that instructs an LLM worker how to drive the source's search/fetch tools and shape results into `NormalizedRecord`s.

The system then runs that connector **on a schedule** (and on demand), feeding results through the **existing ingestion pipeline** into the knowledge graph — **idempotently**, so repeated runs update nodes instead of duplicating them.

This unifies three execution substrates behind one abstraction:

- **MCP tools** — verbose but universal; auth + consent + tool snapshots already built.
- **CLI commands** — what agents use *faster, cheaper, with far fewer tokens*; run in the existing sandbox.
- **Deterministic manifest bindings** — for first-party connectors that warrant hand-tuning.

The headline architectural decisions:

- **An installed MCP server is the substrate, not the connector.** A customer connector *references* an installed server (by `orgListingId`) plus a schema plus a prompt. We do **not** productize a manifest per server.
- **MCP and CLI are two implementations of one `SourceTool` interface.** The LLM worker doesn't care which is underneath.
- **Idempotency is enforced at the sink via a schema-declared natural key** (`node_labels.naturalKeyProps`), not in the worker. A non-deterministic LLM worker is still safe as long as it emits a stable natural key.
- **Background workers authenticate via a workspace-level pre-grant** (wildcard consent + the existing `mcp.credentials`), because the interactive per-user consent gate doesn't fit a headless schedule.

---

## 2. Goals / Non-goals

### Goals
- Customer-defined connectors backed by (a) an installed MCP server or (b) a CLI, with no code deploy.
- Both a **generic sandboxed shell** path (recommended, Claude-Code-style, less secure) **and** a **fit-for-purpose CLI adapter** path (templated commands, more secure) for CLI sources.
- Customer-designed schema + custom prompt drive an LLM worker that emits `NormalizedRecord`s.
- Scheduled + on-demand + live-fetch ingestion, all idempotent.
- Reuse — not fork — the ingestion pipeline, schema registry, MCP install/auth/consent, and sandbox.

### Non-goals (this spec)
- Inbound webhooks from MCP/CLI sources (they are poll/agent-driven; freshness bounded by interval + live-fetch).
- Replacing first-party code connectors (GitHub stays Tier 1).
- A visual schema designer beyond what the schema registry already offers (we wire to existing `schema.*` contracts).
- Cross-source entity resolution beyond the existing embedding-similarity dedup.

---

## 3. The unifying model: connector tiers × execution substrates

A **connector** = *a definition* (the "what/how") + *a connection instance* (auth, cursor, health). First-party connectors are code; customer connectors are **data** resolved by the same registry.

| Tier | Definition lives as | Backing substrate | Execution model | Use for |
|---|---|---|---|---|
| **1 — Native** | TypeScript `ConnectorDefinition` | Webhook / REST (+ optional CLI/MCP) | Deterministic | Highest-value sources (GitHub) |
| **2 — Customer MCP** | Row in `ingestion.connector_definitions` | Installed MCP server (`orgListingId`) | Agentic (→ promotable to deterministic) | Any installed MCP server |
| **3 — Customer CLI** | Row in `ingestion.connector_definitions` | CLI in sandbox (generic shell or templated adapter) | Agentic (→ promotable) | Sources with a good CLI (`gh`, `sf`, `jira`, `linear`) |
| **4 — Customer SQL / DB** | Row in `ingestion.connector_definitions` | Direct DB connection (Postgres / ClickHouse / …) run **in the sandbox** | **Deterministic** (query+map; LLM only assists *authoring*) | Internal/proprietary data in a relational/columnar DB, incl. **inside a VPC or behind a firewall** |

**Execution substrates** are abstracted by a single `SourceTool` interface (§6). A connector definition lists, per record type, which `SourceTool` to call. The worker (§7) is identical regardless of substrate.

> **Why SQL is the best-fitting substrate for idempotency:** a result set is typed and has a stable primary key, so the PK column *is* the natural key (§5.3) and `WHERE updated_at > :cursor` *is* the native watermark (§7.1) — exactly what MCP search tools struggle with. SQL needs no LLM in the fetch loop (cheapest, deterministic). Its cost is **reachability + security** (a DB connection string is more dangerous than an API token, and the DB often lives in a private network) — both answered by the vault + sandbox-template network model (§8.5).

> **Why CLI matters (the user's insight):** MCP tool schemas and JSON results are verbose and balloon the LLM context window; CLIs return compact text and agents already know CLI idioms. For agentic workers this is a direct token-cost and latency win. So when a source has a capable CLI, prefer Tier 3; fall back to Tier 2 (MCP) otherwise.

---

## 4. What already exists (reuse, do not rebuild)

| Capability | Status | Anchor |
|---|---|---|
| Ingestion pipeline (normalize→map→dedup→embed→infer→graph) | ✅ | `packages/ingestion/src/pipeline.ts`, `inngest-functions/.../ingestion.pipeline.ts` |
| **Idempotent sink** `MERGE (n {naturalKey, orgId})` ON CREATE/ON MATCH | ✅ | `packages/ingestion/src/mutations/upsert-entity.ts:112-149` |
| Two-pass dedup (exact naturalKey → embedding similarity, ALIAS_OF) | ✅ | `packages/ingestion/src/dedup/resolve.ts` (`ALIAS_THRESHOLD=0.70`, `CONFIRM_THRESHOLD=0.92`) |
| Sync cursor (`source_connections.cursor` JSONB) | ✅ schema; ⚠️ **polling stubbed** | `packages/database/src/schema/ingestion.ts:23`; `custom-sql/index.ts` `poll()` throws |
| Schema registry (versioned, opt-in, typed, **`naturalKeyProps`**) | ✅ shipped (PR #150) | `packages/database/src/schema/schema-registry.ts` |
| Schema adoption (`schema.toggle`, born-disabled, `schema_activations`) | ✅ | `packages/oxagen/src/contracts/schema.toggle.ts` |
| Conformance enforcement (strict/lenient/off) at upsert | ✅ | `packages/ingestion/src/mutations/upsert-entity.ts` + `validate/` |
| MCP install → `mcp.mcp_servers` + `mcp.credentials` (KMS AES-256-GCM, OAuth DCR/secret/none) | ✅ | `plugin.org.install`, `packages/plugins/src/{credentials,oauth}` |
| MCP tool snapshots (JSON Schema captured at register) | ✅ | `mcp.tool_snapshots`, `packages/agent/src/runtime/mcp-snapshots.ts` |
| MCP consent (per workspace/user/server/tool, **wildcard `*` pre-grant, never-expiry**) | ✅ | `mcp.consents`, `packages/agent/src/runtime/consent.ts` |
| Runtime MCP tool resolution + auth injection | ✅ | `packages/agent/src/runtime/plugin-types/mcp.ts`, `dispatch/mcp-client.ts` |
| Sandbox code execution (`node`/`python`/`shell`, Vercel/Modal/Docker, timeout/mem/network) | ✅ | `agent.code.execute`, `packages/sandbox/src/*` |
| Tool materialization (capability + MCP → AI SDK tool, IAM/consent/approval/telemetry) | ✅ | `packages/agent/src/runtime/materialize-tools.ts` |
| `generateObject` (instrumented, schema-validated) | ✅ | `packages/ai/src/generate-object.ts` |
| Agent triggers (`triggerType='schedule'`, cron) | ✅ schema; ❌ **no cron executor** | `agent_triggers`, `agent-schema.ts:128-159` |
| **Vault + Environments + Sandbox Templates** (workspace secrets, per-env values, sandbox provisioning, **VPC/firewall network modes**) | 🟡 **separate spec** (dependency) | `2026-06-24-credential-vault-environments-sandboxes-spec.md` |
| Envelope encryption + KMS (reused by the vault) | ✅ | `@oxagen/crypto` (`encrypt`/`decrypt` + `KmsAdapter`), `resolveCredentialKms()` |

**Net-new builds** are listed in §12. Everything above is wired, schema-ready, or specified in the dependency spec.

---

## 5. Data model changes

### 5.1 New table: `ingestion.connector_definitions` (data-driven connector specs)

```
ingestion.connector_definitions
  id                uuid pk
  public_id         text unique            -- 'cdef_...'
  org_id            uuid not null
  workspace_id      uuid not null
  name              text not null          -- slug, unique per (org,workspace)
  display_name      text not null
  description       text
  backing_kind      text not null          -- 'mcp_server' | 'cli' | 'sql'
  -- MCP backing:
  mcp_org_listing_id uuid                  -- FK plugin.installed_plugins.id (when backing_kind='mcp_server')
  -- CLI backing:
  cli_descriptor    jsonb                  -- { binary, installHint, mode:'shell'|'adapter', commands:[...] } (when backing_kind='cli')
  -- SQL backing (direct DB):
  sql_descriptor    jsonb                  -- { dialect:'postgres'|'clickhouse'|..., dsnSecretKey, readOnly:true, queries:[...] } (when backing_kind='sql')
  execution_model   text not null default 'agentic'  -- 'agentic' | 'deterministic' (SQL connectors default 'deterministic')
  custom_prompt     text                   -- LLM worker instructions (agentic)
  schema_name       text not null          -- FK schema_registry.schemas.name (the customer-designed schema)
  record_bindings   jsonb not null         -- see §5.2
  worker_model      text                   -- optional model override (modelIdOf)
  environment_id    uuid                   -- optional pin; else resolved from the connector's agent/run environment (§8.5)
  schedule          text                   -- cron expression; null = manual/on-demand only
  enabled           boolean not null default false
  status            text not null default 'draft'  -- 'draft'|'active'|'paused'|'error'
  last_run_at       timestamptz
  created_at, updated_at, created_by_user_id, updated_by_user_id
  unique (org_id, workspace_id, name)
```

RLS-scoped like every `ingestion.*` table (`withTenantDb`). A customer connector definition is **referenced by a `source_connections` row** (`connectorId = public_id`), so a definition can have ≥1 connection instances (auth/cursor live on the connection, as today).

### 5.2 `record_bindings` JSONB shape (per record type → how to fetch + map)

```jsonc
{
  "issue": {
    "schemaLabel": "SupportTicket",          // node label in the customer schema
    "listTool":   "list_issues",             // SourceTool name (MCP tool OR CLI command id)
    "detailTool": "get_issue",               // optional, for live-fetch / enrichment
    "paramTemplate": { "updatedSince": "{{cursor.updatedSince}}", "first": 100 },
    "pagination":  { "style": "cursor", "nextPath": "pageInfo.endCursor", "hasNextPath": "pageInfo.hasNextPage" },
    "incremental": { "field": "updatedAt", "cursorKey": "updatedSince" },  // null => full re-scan
    "externalIdField": "id",                 // source field that is the stable identity (REQUIRED)
    "fieldMappings": { "title": "title", "status": "state.name", "assignee": "assignee.email" }
  }
}
```

In **deterministic** mode the worker applies these bindings literally (no LLM in the fetch loop). In **agentic** mode they are *hints* in the prompt; the LLM may deviate but **must** still emit `externalIdField` as the natural key.

### 5.3 Generalize the natural key (the idempotency change)

Today `naturalKey = `${connectorType}:${connectionId}:${externalId}`` is hardcoded (`packages/ingestion/src/pipeline.ts:152`, `inngest-functions/.../ingestion.pipeline.ts:98`) and `externalId` comes from `NormalizedRecord.externalId`.

**Change:** when the entity type's adopted schema declares `node_labels.naturalKeyProps`, compute the record's `externalId` from those properties (stable, customer-controlled) instead of relying on the connector to invent one. Formula stays `{connectorType}:{connectionId}:{externalId}` so tenant + connection scoping is preserved; only the `externalId` derivation generalizes.

```
externalId = naturalKeyProps.length
           ? stableJoin(naturalKeyProps.map(p => record.properties[p]))   // e.g. sha1("acme.salesforce|Account|001xx")
           : record.externalId                                            // legacy fallback
```

This makes a customer's connector idempotent **by construction**: they pick which field(s) are the identity, and the existing `MERGE {naturalKey, orgId}` guarantees re-runs update, never duplicate.

### 5.4 Add a content hash (skip no-op re-embeds)

Add `content_hash` to the entity MERGE: `ON MATCH`, if the incoming hash equals the stored hash, **skip re-embedding and inference** (the expensive stages). This bounds cost on schedules where most records are unchanged each run. Hash = stable hash of the mapped, schema-validated property bag.

> Currently `upsert-entity.ts` overwrites properties unconditionally and has no content hash. This is the one pipeline edit needed for cost-safe frequent polling.

### 5.5 Reuse for the rest

- **Auth:** `mcp.credentials` (MCP OAuth/secret) for MCP-backed; **the Vault** (`environments.secret_keys`/`secret_values`) for CLI tokens and **DB connection strings** (§8.2, §8.5) — no new credential store.
- **Consent / pre-grant:** `mcp.consents` wildcard row (§8.3) — no new table.
- **Schema:** `schema_registry.*` — the customer designs here; `schema_name` binds it. No new schema store.
- **Sandbox + private networking:** Environments + Sandbox Templates (the dependency spec) — the worker runs in a provisioned sandbox whose **network mode** reaches the source (incl. VPC/firewall). No new sandbox or networking code here.
- **Cursor / health / counts:** `source_connections.{cursor,lastSyncAt,entityCount,status}` — already there; wire the (currently stubbed) cursor write path.

---

## 6. The `SourceTool` abstraction (MCP ⊕ CLI ⊕ SQL, one interface)

```ts
interface SourceTool {
  name: string;                          // 'list_issues' | 'accounts_changed'
  describe(): ToolDescriptor;            // JSON-Schema'd params (MCP snapshot | CLI adapter spec | SQL query params)
  invoke(params: unknown, ctx: SourceToolCtx): Promise<SourceToolResult>;  // returns rows (parsed JSON / NDJSON / SQL rows)
}
```

Three implementations:

### 6.1 `McpSourceTool` — calls an installed MCP server
- Resolves the server by `mcp_org_listing_id` and reuses the **exact** runtime path that `contributeMcpTools` uses: `DbOAuthClientProvider` (OAuth) or `getWorkspaceSecret` (secret) → `connectMcp` → `callTool`.
- Tool catalog + param schemas come from `mcp.tool_snapshots` (no live probe needed to *build* the connector).

### 6.2 `CliSourceTool` — runs a command in the sandbox
Two modes, set in `cli_descriptor.mode`:

- **`shell` (generic, recommended, less secure):** the worker is given a single `cli.run(command)` tool that executes in the sandbox via the existing `agent.code.execute` path (`language: "shell"`). This is the Claude-Code model — maximal flexibility (`gh issue list --json … | jq …`). Mitigated by sandbox isolation (§8.4).
- **`adapter` (fit-for-purpose, more secure):** `cli_descriptor.commands[]` declares templated commands with typed params, e.g.
  ```jsonc
  { "id": "list_issues",
    "template": "gh issue list --repo {{repo}} --state all --json number,title,updatedAt --search \"updated:>{{cursor.updatedSince}}\" --limit {{limit}}",
    "params": { "repo": "string", "limit": "integer(1..200)" },
    "parse": "json" }
  ```
  Params are validated + shell-escaped; the LLM supplies only typed values, never raw shell. This presents the *same tool surface* as an MCP tool, so the worker code is identical.

**Result parsing:** both modes return `{ rows: unknown[], raw?: string }`. Adapter declares `parse: 'json'|'ndjson'|'jsonpath'`; shell mode expects the worker to emit JSON (the prompt instructs `--json`/`jq`).

### 6.3 `SqlSourceTool` — runs a parameterized query against a direct DB connection
The third substrate: a customer points at their database (Postgres, ClickHouse, …) and gives a query per record type. **Deterministic by default** — no LLM in the fetch loop (a SQL result set is already typed and keyed); the LLM only *assists authoring* the query + column→property/FK mapping once.

```jsonc
// sql_descriptor
{ "dialect": "postgres",
  "dsnSecretKey": "ANALYTICS_DB_URL",     // vault key holding the connection string (§8.5) — never inline
  "readOnly": true,                        // enforced: read-only txn + SELECT-only parse
  "queries": {
    "account": {
      "sql": "SELECT id, name, owner_email, updated_at FROM crm.accounts WHERE updated_at > :cursor ORDER BY updated_at LIMIT :limit",
      "params": { "limit": "integer(1..5000)" },
      "pagination": { "style": "keyset", "cursorColumn": "updated_at" },
      "incremental": { "field": "updated_at", "cursorKey": "cursor" },
      "externalIdColumns": ["id"],         // PK → natural key (§5.3)
      "columnMappings": { "name": "name", "owner_email": "ownerEmail" },
      "edges": [ { "fromColumn": "owner_id", "type": "OWNED_BY", "toLabel": "User" } ]  // FK → relationship
    }
  }
}
```

- **Execution location:** the query runs **inside the provisioned sandbox** (a DB client process), *not* the app/api process — so the sandbox's **network mode** (§8.5) governs reachability and the customer's DB is never dialed from Oxagen's app tier. The connection string is injected as a trusted vault env var (`$ANALYTICS_DB_URL`); the worker/LLM never sees its value.
- **Safety enforced by the tool, not the customer:** SELECT-only (parse-reject DDL/DML), wrapped in a **read-only transaction** (`SET TRANSACTION READ ONLY` / `default_transaction_read_only`), statement timeout, row cap, keyset pagination. Values are bound parameters (`:cursor`, `:limit`) — never string-interpolated.
- **Rows → graph:** PK columns → `externalId`/natural key; `columnMappings` → typed properties; `edges[]` declares FK→relationship so the graph isn't just disconnected nodes. The same pipeline (dedup/embed/infer/MERGE) consumes the emitted records — identical to MCP/CLI.
- **ClickHouse gets different defaults:** CH is append-only/high-volume and often lacks a stable per-row PK, so naive row materialization explodes the graph. CH connectors default to **aggregate/rollup queries** (`GROUP BY … ` producing keyed summary rows) or **live-fetch** rather than row-by-row; the builder warns and steers accordingly. **Postgres ships first** (clean PK + `updated_at` story); ClickHouse second with aggregate defaults.
- **`cdc` upgrade (Phase 4):** for high-value DB sources, logical replication / Debezium-style CDC gives near-real-time + true incremental without polling load — the DB analog of "webhooks beat polling." `sql_descriptor.mode='cdc'` is the future path over scheduled SELECTs.

---

## 7. The agentic ingestion worker (the heart)

A scheduled (or on-demand) Inngest function that turns a connector definition + cursor into idempotent graph writes.

```
connectorIngest(connectionId, trigger):
  def   = load connector_definition
  conn  = load source_connection (auth ref, cursor, status)
  schema= load adopted schema (schema_name) → derive a Zod RecordSchema per record type
          (required: externalId from naturalKeyProps; typed props; conformance rules)
  tools = build SourceTool[] from def.record_bindings  (McpSourceTool | CliSourceTool)
  preflight: assert workspace pre-grant/consent (§8.3) and credential.status='active'

  if def.execution_model == 'deterministic':
     rows = run bindings literally (call listTool, paginate via cursor, map fieldMappings)
  else: # agentic
     system = compose(def.custom_prompt, schemaDescription, cursorWindow,
                      "Emit one record per item. Set externalId = <field>. Use the smallest tool calls.")
     # Agent loop: model may call SourceTools (read-only search/fetch) to gather data,
     # then returns structured output validated by RecordSchema (generateObject / tool-loop).
     rows = runWorkerAgent({ system, tools, model: def.worker_model, schema: RecordSchema })

  for batch in chunk(dedupeByExternalId(rows)):       # in-run dedup
     emit ingestion/entity.received  { connectorType: def.public_id, connectionId,
                                       sourceRecordType, normalized: {externalId, displayName, properties} }
  update source_connection.cursor   = advanceCursor(rows, def.incremental)
  update source_connection.{lastSyncAt, entityCount, status, healthStatus}
```

From `ingestion/entity.received` onward it is the **existing pipeline** — map (identity, worker already mapped), dedup (`resolveEntity` on the generalized naturalKey), content-hash gate (§5.4), embed, infer, graph MERGE. **No second ingestion path.**

### 7.1 Why the LLM worker is safe to repeat (idempotency answer)
1. **Stable natural key is mandatory.** `RecordSchema` makes `externalId` required and derives it from `naturalKeyProps`. Even if the model rephrases `displayName`, `MERGE {naturalKey, orgId}` updates the same node.
2. **Cursor bounds the fetch.** The worker receives `cursor.updatedSince`; it only pulls changed records (when the source supports it). Stored in `source_connections.cursor`.
3. **Content hash skips no-ops** (§5.4): unchanged records don't re-embed/re-infer.
4. **In-run dedup** by `externalId` before emit (a model may surface the same item twice in one run).
5. **Conformance enforcement** rejects/flags off-schema payloads (`strict`/`lenient`).

### 7.2 Execution-model lifecycle (cost optimization)
- Customer connectors start **`agentic`** (the customer wrote a prompt, not bindings).
- On the first successful agentic run, **record the tool-call recipe** (which tools, which params, which output paths) the model converged on, into `record_bindings`.
- Subsequent runs run **`deterministic`** from the recorded recipe (no LLM in the fetch loop) — cheap, fast, reproducible — and re-enter agentic only on schema drift / parse failure / explicit "re-learn". This is "**learn once, replay cheaply**," and it directly answers the token-cost concern.

### 7.3 Scheduling
- **Build the missing cron executor.** One Inngest cron (`{ cron: "* * * * *" }`, pattern = `ingestion.oauth-refresh`) scans `connector_definitions` + `agent_triggers` (`triggerType='schedule', enabled=true`) for due crons and emits `ingestion/connector.run`. Per-org concurrency cap (`{ limit: 5, key: orgId }`), per-connector call budget + backoff (§11.5).

---

## 8. Authentication & authorization

### 8.1 MCP-backed connectors
- Reuse the install + credential model verbatim. The connector references `mcp_org_listing_id`; the worker resolves auth via `DbOAuthClientProvider` (OAuth 2.1 DCR, auto-refresh) or `getWorkspaceSecret` (secret), KMS AES-256-GCM, exactly as the agent runtime does today.
- The LLM worker **never sees the token** — auth is injected at the transport layer by `connectMcp`.

### 8.2 CLI-backed connectors — credentials come from the Vault
- The connector's CLI secret (`GH_TOKEN`, `LINEAR_API_KEY`, an `sf` auth file, …) is a **Vault key** (`environments.secret_keys`), with a default value and optional per-environment overrides (dependency spec §7). No connector-specific credential store.
- At run time the provisioner injects the resolved value as a **trusted vault env var** into the sandbox (e.g. `$GH_TOKEN`) via the trusted channel (dependency spec §11) — it **bypasses the model-facing denylist** because it's a deliberately-configured customer secret, while the denylist still protects Oxagen's own infra vars from prompt-injected `env`. The model writes `gh …`; `gh` reads the env var; **the secret value never enters the prompt or model output**.
- Adapter mode is stronger still: the runtime materializes the full command including credential; the model supplies only typed params.

### 8.3 Background-worker consent (no interactive user)
The per-user interactive consent gate (`mcp.consents`, OXA-816) blocks on an SSE card — wrong for a headless schedule. Bridge:
- **At connector creation**, the creating admin establishes a **workspace pre-grant**: a `mcp.consents` row with `tool_name='*'`, `status='granted'`, `expiresAt=NULL` for the connector's service principal (a synthetic per-connector `userId`, or a workspace-service identity).
- The worker runs under that service identity; `checkConsent` finds the wildcard grant; tools run inline. Revoking the pre-grant (or disabling the server) immediately halts ingestion.
- IAM: connector create/edit/run gated to **Owner/Admin** (matches `agent.mcp.register` strictness). Per "apps/app does not bootstrap IAM," any app-side call site adds explicit `assertBillingManager`/`assertOrgMember`-style gates.

### 8.4 Sandbox security & private networking come from the dependency feature
The sandbox the worker runs in — isolation, resource caps, network mode, and which secrets are injected — is a **Sandbox Template** (dependency spec §8–§12), not bespoke connector code:
- **Ephemeral isolation** — Firecracker microVM (Modal/Vercel) in prod, never `docker`; only the run's resolved vault subset is injected; Oxagen infra vars unreachable (the model-facing denylist `DATABASE_/NEO4J_/CLICKHOUSE_/AWS_/OXAGEN_/…` stays intact for *model-supplied* env, while the *trusted* vault channel injects the connector's own secrets).
- **Network reachability** — the template's **network mode** (`public` / `static_egress` / `aws_privatelink` / `gcp_psc` / `reverse_tunnel` / `ssh_bastion`) is how a CLI or SQL source reaches a private/firewalled system (§8.5). The microVM has no route to Oxagen's internal network/datastores regardless of mode.
- **Resource caps & audit** — timeout (≤300 s) / memory / output-size caps surface `oomKilled`/`timedOut` as connection `status='error'`; every run logs to the connector-run trail + ClickHouse `tool_invocations`.
- Generic-shell (Tier-3) connectors are the riskiest surface and must run on `vercel`/`modal` drivers in prod (never `docker`).

### 8.5 Direct DB connections — reachability is the whole problem
A SQL connector's connection string is a **Vault secret** (`sql_descriptor.dsnSecretKey`), resolved per environment (a `production` env can point at the prod read-replica; `development` at a staging DB — same connector, different value). The query runs **inside the sandbox** (§6.3), so reaching the DB is exactly the sandbox template's **network mode**:
- **Public cloud DB** → `public` (no allowlist) or `static_egress` (allowlist Oxagen's egress IP in the DB's security group / authorized networks).
- **AWS VPC** → `static_egress` (RDS + SG) or `aws_privatelink` (private).
- **GCP VPC** → `static_egress` (Cloud SQL authorized networks) or `gcp_psc` (private).
- **In-house firewall** → **`reverse_tunnel`** via the customer-run Oxagen Network Agent (outbound-only; no inbound firewall change) or `ssh_bastion`.
- **Security:** SSRF/host-allowlist validation on the DSN host (reuse the `agent.mcp.register` private-IP guard so a DSN can't target Oxagen's own datastores or cloud metadata), **read-only credentials on a read-replica** (strongly steered), SELECT-only + read-only transaction + statement timeout enforced by `SqlSourceTool` (§6.3). A dead/blocked DB → `status='error'`, never a silent empty sync.

---

## 9. Customer connector-builder flow (UX + API)

1. **Pick a source.**
   - *MCP:* `agent.mcp.list` → installed servers (+ `toolCount`, `healthStatus`). Customer picks one. If none installed, route to install (`plugin.org.install` / marketplace) first.
   - *CLI:* customer picks a known CLI template (`gh`, `sf`, `jira`, `linear`) or declares a custom binary + auth.
   - *SQL / DB:* customer picks a dialect (`postgres`, `clickhouse`, …), selects the **Vault key** holding the connection string, and a **sandbox template whose network mode reaches the DB** (§8.5). CH steers to aggregate queries.
2. **Authenticate** (if not already): MCP → OAuth/secret via existing `/api/v1/mcp/oauth/*` or `plugin.credential.set_secret`; CLI/SQL → store the token / **connection string** as a **Vault secret** (sensitive, per-environment overrides; dependency spec §7).
3. **Choose tools / queries → record types.** MCP → map `list_*`/`get_*` tools (from `mcp.tool_snapshots`); CLI → map `cli_descriptor.commands`; SQL → write/confirm one **query per record type** (LLM can draft it + the column→property/FK mappings from a sampled `SELECT … LIMIT`). The JSON Schema / column list renders the mapping form.
4. **Design the schema.** Customer defines node labels + typed properties + relationships in the schema registry (`schema.label.upsert`, `schema.property.upsert`, `schema.relationship.upsert`), **marks the natural-key property(ies)** (`naturalKeyProps`), under a new schema `source='custom_connector'`, **born disabled**. (LLM-assisted: `schema.recommend` can seed it from a sample tool call.)
5. **Write the custom prompt.** Free-text instructions for the worker (what to fetch, how to map ambiguous fields, what to skip). Stored in `connector_definitions.custom_prompt`.
6. **Set schedule + preview.** Pick a cron (or manual). **Dry-run** (`connector.preview`) executes the worker once against a small window, shows the produced `NormalizedRecord`s + conformance results, **writes nothing**.
7. **Activate.** Customer adopts the schema (`schema.toggle` → enabled) and enables the connector. The pre-grant (§8.3) is recorded. First scheduled run materializes; `graph.node.search` now covers the data.

### New contracts (capability-parity: contract → API route → MCP tool → docs)
- `connector.define` — create/update a `connector_definitions` row (name, backing, bindings, schema_name, prompt, schedule).
- `connector.list` / `connector.get` / `connector.delete`.
- `connector.preview` — dry-run worker against a small window; returns sample records + conformance; persists nothing.
- `connector.run` — trigger an on-demand sync (async; emits `ingestion/connector.run`).
- `connector.enable` / `connector.pause` — lifecycle (records/removes the pre-grant).
- `graph.node.enrich` — **live-fetch** (the "both" mode): on cache-miss/detail/refresh, call the connector's `detailTool` via the same `SourceTool` path, validate against the pinned schema, optional short-TTL cache row, return enriched properties.

Reuse unchanged: all `schema.*`, `agent.mcp.*`, `plugin.org.install`, `plugin.credential.*`, the `connection.*` family (a customer connector still produces `source_connections` rows), and the whole ingestion pipeline.

---

## 10. Live + materialized ("both" mode)

Both call the **same `SourceTool`s**; they differ only in trigger + persistence:
- **Materialize** — scheduled worker (§7) writes typed nodes/edges + embeddings. Powers NL/graph search, relationships, offline coverage.
- **Live fetch** — `graph.node.enrich` calls `detailTool` on demand for hot/volatile fields and long-tail records never bulk-ingested; optional TTL cache. Behind the same pre-grant/consent + credential resolution.

Per-label `fetchMode ∈ {materialized, live, hybrid}` (stored in the schema label's `metadata`) selects strategy per entity type.

---

## 11. Risks & limits (the honest part)

1. **Enumeration vs. search.** Bulk ingest needs a `list_*`/paginate affordance, not just `search(q)`. Servers/CLIs that only search → degrade to **query-watcher** (saved-query periodic refresh), not a backfill loader. `record_bindings.listTool` being absent is a declared, surfaced limitation — never a silent partial sync.
2. **No incremental signal.** If a tool can't filter by `updatedAt/since`, every run re-reads the bounded set. Content-hash (§5.4) keeps it cheap on the write side; cap the read side with interval + budget. Declared in `incremental` (null ⇒ full re-scan).
3. **Agentic non-determinism & cost.** Mitigated by the deterministic-recipe promotion (§7.2), content-hash, cursor windows, and a per-run token budget. Prefer CLI (cheaper context) over MCP for agentic sources.
4. **Loosely-typed outputs / schema drift.** JSON Schema snapshots enable mapping; conformance telemetry (shipped) catches drift; agentic re-learn handles it. `strict` enforcement protects the graph.
5. **Rate limits.** Each run = N tool/CLI calls. Reuse per-org Inngest concurrency + a per-connector call budget + exponential backoff; dead/limited credential → `status='error'` (never silent empty sync).
6. **CLI security.** §8.4 is mandatory; generic-shell connectors must run on `vercel`/`modal` drivers, never `docker`, in prod.
7. **Credential lifetime.** OAuth auto-refresh exists; on `needs_reauth` the connection goes `error` and surfaces a reconnect action; the schedule pauses rather than looping on 401s.
8. **DB blast radius (SQL substrate).** A connection string is more dangerous than an API token — arbitrary SQL could mutate the source, and the DSN host could be coerced toward an internal target. Mitigated by §8.5: read-only creds + read-replica steering, SELECT-only + read-only-transaction + statement-timeout enforcement in `SqlSourceTool`, DSN host-allowlist (SSRF guard), and per-DB row/time caps. Heavy scheduled queries against a primary DB are an operational risk → recommend replicas + off-peak scheduling.
9. **ClickHouse shape.** Append-only, high-volume, often no stable per-row PK → naive row materialization explodes the graph. Default CH connectors to aggregate/rollup or live-fetch (§6.3); Postgres ships first.
10. **Private-network reachability is real infra.** `reverse_tunnel`/PrivateLink/PSC are net-new (dependency spec); until they ship, SQL/CLI sources are limited to `public`/`static_egress`-reachable DBs. A `reverse_tunnel` whose Network Agent is offline must fail fast, not hang.

---

## 12. Net-new build list (everything else is reuse)

| # | Build | Where |
|---|---|---|
| B1 | `ingestion.connector_definitions` table + migration | `packages/database/migrations/` |
| B2 | `SourceTool` interface + `McpSourceTool` + `CliSourceTool` (shell + adapter) | `packages/ingestion/src/source-tools/` |
| B2b | `SqlSourceTool` (Postgres first, ClickHouse aggregate-default; SELECT-only/read-only-txn/timeout; PK→naturalKey, FK→edge) | `packages/ingestion/src/source-tools/sql/` |
| B0 | **Dependency: Vault + Environments + Sandbox Templates + network modes** (separate spec) — credential storage, per-env DSN/secrets, sandbox provisioning, VPC/firewall reachability | `2026-06-24-credential-vault-environments-sandboxes-spec.md` |
| B3 | Generalize naturalKey from `naturalKeyProps`; add `content_hash` gate | `pipeline.ts`, `mutations/upsert-entity.ts`, `dedup/resolve.ts` |
| B4 | Agentic ingestion worker + deterministic-recipe promotion | `packages/inngest-functions/src/functions/ingestion.connector-run.ts` |
| B5 | **Cron scheduler executor** (scan defs/triggers → emit run) | `packages/inngest-functions/src/functions/ingestion.scheduler.ts` |
| B6 | Cursor write path (un-stub polling checkpoint) | `mutations/upsert-entity.ts` (`upsertSourceConnectionMeta`) + worker |
| B7 | `connector.*` contracts + handlers + API routes + MCP tools | `contracts/connector.*`, `handlers/connector.*`, `apps/{api,mcp}` |
| B8 | `graph.node.enrich` (live-fetch) contract + handler + optional TTL cache | `contracts/graph.node.enrich.ts`, `handlers/`, `ingestion.external_cache` |
| B9 | Background pre-grant wiring (wildcard consent for a connector service identity) | `connector.enable` handler + `consent.ts` |
| B10 | Connector-builder UI (source pick → tool map → schema design → prompt → preview → activate) | `apps/app/src/.../connectors/` |
| B11 | Wire the worker sandbox to the Sandbox-Template provisioner: trusted vault-env injection (CLI tokens, DB DSNs) + network-mode reachability | worker + dependency feature |

---

## 13. Testing

- **Unit:** naturalKey generalization (schema-declared vs legacy), content-hash skip, in-run dedup, param-template escaping (adapter), cursor advance, conformance enforce/reject.
- **Idempotency (the headline test):** run the worker **twice** over the same fixture and a **perturbed** fixture (reordered, rephrased `displayName`, duplicate item) → assert node count stable, `MERGE` updates only, no duplicate `:EntityNode`/`ALIAS_OF`/`INFERRED_FROM`.
- **Integration:** `McpSourceTool` against a stub MCP server (consent pre-grant path); `CliSourceTool` adapter against a fixture binary in the sandbox; `SqlSourceTool` against a fixture Postgres (PK→naturalKey, `updated_at` cursor, FK→edge); secret/DSN never appears in model-visible payloads (assert).
- **SQL safety:** DDL/DML rejected (SELECT-only parse), read-only transaction set, statement timeout fires, DSN host-allowlist rejects private/metadata targets; ClickHouse aggregate-default path.
- **Security:** Oxagen infra vars (`NEO4J_*`/`DATABASE_*`) unreachable from model-supplied env while the trusted vault `DATABASE_URL`/DSN *is* injected; generic-shell connector blocked on `docker` driver in prod config; egress isolation.
- **E2E (`apps/app/e2e/`):** build a Linear-MCP-backed connector end-to-end (pick server → map `list_issues` → design `SupportTicket` schema with natural key → prompt → preview → activate → run → `graph.node.search` returns ingested tickets), screenshots of each success state.
- Coverage ratchets per package policy (cap 90, ≥2.5% headroom). Dispatch **test-completeness-judge** before opening the PR.

---

## 14. Phasing

- **Phase 0 — Idempotency core + one MCP source (proof).** B1, B3, B4 (agentic only), B5, B6; Linear-MCP-backed connector; manual schema create + `schema.toggle`. Proves the whole loop with the idempotency tests as the gate.
- **Phase 1 — Builder + schema bridge.** B7, B10; customer designs schema + prompt + maps tools; `source='custom_connector'` born-disabled adoption; `connector.preview` dry-run.
- **Phase 2 — CLI + SQL substrates.** B2 + B2b + B11 on top of the Vault/Sandbox-Template dependency (B0): Tier-3 CLI (`gh`/`sf`/`jira`) and **Tier-4 SQL (Postgres)** with `public`/`static_egress` reachability; §8.4/§8.5 hardening. ClickHouse (aggregate-default) follows.
- **Phase 3 — Live + cheap + private DB.** B8 (`graph.node.enrich`), deterministic-recipe promotion (§7.2), content-hash tuning, per-connector budgets; `reverse_tunnel`/PrivateLink/PSC reachability (dependency Phase 2–3) for VPC/firewall DBs.
- **Phase 4 — Scale.** `cdc` for high-value DB sources, egress allowlists, LLM-assisted auto-mapping from snapshots (`connection.mappings.suggest`), broader CLI/MCP catalog, connector marketplace sharing.

---

## 15. Open decisions (recommendation in **bold** — flag, don't block)

1. **Default execution model for customer connectors:** **`agentic`, auto-promoted to `deterministic` after first successful run** (§7.2). Alt: deterministic-only (rejected — defeats the custom-prompt premise).
2. **CLI credential store:** **reuse `mcp.credentials` envelope-encryption keyed by a synthetic listing** (avoid a parallel crypto path). Alt: dedicated `ingestion.connector_credentials`.
3. **Background-worker identity for consent:** **a synthetic per-connector service `userId` holding a wildcard pre-grant** (§8.3). Alt: a workspace-wide service principal (coarser revocation).
4. **Generic shell vs adapter as the default CLI mode:** **offer both; default new CLI connectors to `adapter` (safer), with `shell` as an explicit opt-in** for power users. (User called shell "recommended"; this keeps it available while defaulting to the safer surface — confirm preference.)
5. **Where the connector definition lives relative to `source_connections`:** **separate `connector_definitions` (1) → `source_connections` (N)**. Alt (MVP shortcut): fold the definition into the connection row.

---

## 16. Net recommendation

Build the net-new pieces on top of the existing pipeline, schema registry, MCP install/auth/consent, sandbox, and the **Vault + Environments + Sandbox-Templates dependency**. Treat an **installed MCP server, a CLI, or a direct DB as the substrate**, and a **customer connector as data** (schema + prompt + tool/query bindings) — not a per-server productized manifest. Unify all three behind one `SourceTool` interface so the worker is substrate-agnostic and can prefer the cheaper CLI/SQL paths; SQL is deterministic and the cleanest idempotency fit (PK→naturalKey, `updated_at`→cursor). Make **idempotency a property of the schema-declared natural key**, enforced at the existing `MERGE` sink, so even a non-deterministic LLM worker is safe to run on a schedule. Source credentials — API tokens *and* DB connection strings — live in the **Vault** with per-environment values, injected into the worker's sandbox through a trusted channel; **private databases inside a VPC or behind a firewall are reached via the sandbox template's network mode** (`static_egress` / PrivateLink / PSC / reverse-tunnel). This delivers "I can add my own connector to anything my business uses — an installed MCP server, a CLI, or my own database wherever it lives — designing my own schema and guiding the workers with a prompt" — with no million-integration sprawl and no duplicate-node drift.
