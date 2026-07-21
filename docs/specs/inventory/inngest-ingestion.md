# Spec: inngest-ingestion

> **Historical inventory — superseded in part (2026-07-21).** This file was mined
> from a 2026-06-20 implementation snapshot. Central source-file/symbol parsing,
> code embeddings, feature inference, and semantic auto-accept sections describe
> retired launch behavior. Exact code graphs stay local, and semantic candidates
> require explicit governed approval.

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: ingestion.pipeline.ts, ingestion.sync-requested.ts, ingestion.delete.ts, ingestion.github-initial-sync.ts, ingestion.github-parse-file.ts, ingestion.github-infer-features.ts, ingestion.oauth-refresh.ts, ingestion.semantic-edge-infer.ts, plugin.oauth-refresh-watcher.ts, mcp.tool-snapshot-retention.ts
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Ingest entity from raw connector payload into dual-write (Postgres + Neo4j)
<!-- id: ingestionPipeline.handleEntityReceived -->
<!-- entities: EntityNode, EntityMutation, EntityTypeMapping -->
<!-- enforced: ingestion.pipeline.ts -->

The 6-step ingestion pipeline SHALL normalize raw connector payloads, deduplicate entities by naturalKey and embedding similarity, upsert EntityNode and embedding in Neo4j, and fire downstream inference events asynchronously in a single Inngest transaction. When no customer-configured entity type mapping exists for the source record type, the pipeline skips the record silently.

#### Scenario: Entity record with matching type mapping normalizes and deduplicates by exact naturalKey
<!-- test: ingestion.pipeline.test.ts -->
- **WHEN** an `ingestion/entity.received` event arrives with a connectorType, sourceRecordType, and payload that matches a customer-configured entity type mapping
- **THEN** step 1 normalizes the payload via connector.normalizeRecord(), applies property mappings, and creates an EntityMutation with computed naturalKey (`${connectorType}:${connectionId}:${externalId}`); step 2 queries Neo4j for exact :EntityNode match by naturalKey; if found (dedupPassA.found=true), step 3 returns action="updated_principal" with confidence=1.0

#### Scenario: Entity record with no type mapping is skipped
<!-- test: ingestion.pipeline.test.ts -->
- **WHEN** the entity type mapping query returns null (customer has not configured this source record type)
- **THEN** step 1 returns null mutation, the pipeline logs "no mapping, skipping", and returns {skipped: true}

#### Scenario: Entity with no exact naturalKey match runs full dedup (embedding similarity)
<!-- test: ingestion.pipeline.test.ts -->
- **WHEN** dedup pass A finds no exact naturalKey match in Neo4j
- **THEN** step 3 calls resolveEntity() to run embedding similarity match; resolveEntity returns one of: action="created_principal" (new entity), action="updated_principal" (matched via embedding), action="created_alias" (alias created), action="confirmed_alias" (existing alias confirmed), each with a principalNodeId and confidence score

#### Scenario: Upserted entity is embedded and fires inference events
- **WHEN** steps 1–4 complete successfully (mutation created, dedup resolved, node upserted)
- **THEN** step 5 embeds the entity text; step 6 fires two async events: `ingestion/entity.created` (with isNew boolean set by dedup action) for playbook trigger matching, and `ingestion/entity.infer` for semantic edge inference

---

### Requirement: Pipeline enforces customer entity type mapping as gatekeeper
<!-- id: ingestionPipeline.entityTypeMappings -->
<!-- entities: EntityTypeMapping, SourceRecordType -->
<!-- enforced: ingestion.pipeline.ts -->

The pipeline SHALL query the customer's `ingestion.entity_type_mappings` table scoped to connectionId + sourceRecordType and apply property renames from the customer-configured mapping. Records without a mapping are not persisted.

#### Scenario: Property renames are applied from mapping configuration
- **WHEN** an EntityMutation is created and property mappings exist (e.g., {sourceField: "canonicalName"})
- **THEN** properties are renamed in-place: mappedProperties[canonicalName] = mappedProperties[sourceField], and sourceField is deleted if different from canonicalName

---

### Requirement: Entity ingestion pipeline is org-scoped with concurrency capped per org
<!-- id: ingestionPipeline.tenantScoping -->
<!-- entities: EntityNode -->
<!-- enforced: ingestion.pipeline.ts -->

The pipeline SHALL execute with org-level concurrency limits (8 concurrent per orgId) to prevent resource contention. All Neo4j and Postgres operations run within tenant scope via runInTenantScope({orgId, workspaceId}).

#### Scenario: Ingestion pipelines for one org run serially; pipelines for different orgs run in parallel
- **WHEN** multiple `ingestion/entity.received` events arrive for the same orgId
- **THEN** Inngest enforces concurrency.limit=8 keyed on event.data.orgId, serializing execution within org scope while allowing cross-org parallelism

---

### Requirement: Dispatch connector-specific sync handlers on sync.requested
<!-- id: ingestionSyncRequested.dispatchConnectorSync -->
<!-- entities: SourceConnection, EntityMutation -->
<!-- depends_on: Ingest entity from raw connector payload into dual-write (Postgres + Neo4j) -->
<!-- triggers: GitHub initial-sync dispatcher -->
<!-- enforced: ingestion.sync-requested.ts -->

When `ingestion/sync.requested` is fired, the handler SHALL look up the source connection, validate it is not being deleted, dispatch the connector-specific sync event (GitHub → `ingestion/github.initial-sync`; others → log unsupported), and stamp last_sync_at in Postgres.

#### Scenario: GitHub connection dispatch includes owner/repo/defaultBranch from delivery_config
- **WHEN** `ingestion/sync.requested` arrives with a GitHub connector connection that has delivery_config with owner, repo, defaultBranch
- **THEN** step 2 dispatches `ingestion/github.initial-sync` with owner, repo, defaultBranch; step 3 updates last_sync_at on the source_connections row

#### Scenario: Missing owner/repo in delivery_config logs warning and skips dispatch
- **WHEN** delivery_config is missing owner or repo fields
- **THEN** a warning is logged and no event is dispatched; the function returns without error

#### Scenario: Connection with status=deleting or deleted is skipped
- **WHEN** the source_connections row has status='deleting' or 'deleted'
- **THEN** the function returns early with {skipped: true, reason: "connection_deleted"}

#### Scenario: Connection not found returns skipped
- **WHEN** the source_connections lookup returns no rows
- **THEN** the function returns {skipped: true, reason: "connection_not_found"}

---

### Requirement: Full or partial connection deletion with alias promotion
<!-- id: ingestionDeleteConnection.deleteWithAlias -->
<!-- entities: EntityNode, SourceConnection -->
<!-- enforced: ingestion.delete.ts -->

The deletion function SHALL support three modes: "connection_only" (soft-delete Postgres records only), "data_only" (remove Neo4j nodes), "full" (both). When deleting Neo4j nodes, principal nodes from this connection that are aliased by other connections shall be promoted: the highest-confidence alias is copied principal fields (naturalKey, displayName, properties) and existing ALIAS_OF edges are rerouted to the promoted alias before the original principal is deleted.

#### Scenario: Deletion starts by marking connection as 'deleting'
- **WHEN** `ingestion/connection.delete` is triggered
- **THEN** step 1 updates the source_connections status to 'deleting' and updated_at

#### Scenario: Alias promotion rewrites edges before principal deletion
- **WHEN** mode='data_only' or 'full' and a principal node has multiple incoming ALIAS_OF edges from other connections
- **THEN** step 2 pass-1 selects the highest-confidence alias, copies principal identity fields (naturalKey, displayName, properties, syncedAt=now()), reroutes all other incoming ALIAS_OF edges from that principal to the promoted alias, then deletes the original principal; pass-2 deletes non-aliased nodes

#### Scenario: Postgres records are deleted in FK order
- **WHEN** mode='connection_only' or 'full'
- **THEN** step 3 deletes entity_type_mappings, setup_suggestions, webhook_subscriptions, auth_credentials (all FK references), then soft-deletes the source_connections row (status='deleted', deleted_at=now(), deleted_by, updated_at)

#### Scenario: Soft-delete preserves audit history
- **WHEN** connection is deleted
- **THEN** source_connections status='deleted', deleted_at, deleted_by are set; the row remains in Postgres for audit, not physically removed

---

### Requirement: GitHub tree fetch and file tree fan-out
<!-- id: ingestionGithubInitialSync.fetchAndFanOut -->
<!-- entities: SourceFile, SourceConnection -->
<!-- depends_on: Dispatch connector-specific sync handlers on sync.requested -->
<!-- triggers: GitHub parse-file dispatcher -->
<!-- enforced: ingestion.github-initial-sync.ts -->

The GitHub initial-sync function SHALL decrypt the GitHub access token from oauth_accounts, fetch the full repo tree from GitHub API, filter to .ts, .tsx, .py source files (excluding node_modules/, dist/, .git/, __pycache__/), upsert the SourceConnection meta-node in Neo4j, fan out up to 500 files as `ingestion/github.parse-file` events in batches of 50, and mark the connection status='connected'.

#### Scenario: Access token is fetched and decrypted from oauth_accounts
- **WHEN** GitHub initial-sync runs for a connectionId
- **THEN** step 1 queries oauth_accounts for the encrypted access_token_enc, decrypts it via createIngestionCryptoAdapter(), and caches the plaintext token for subsequent GitHub API calls

#### Scenario: GitHub tree API is called with recursive=1 and Bearer token
- **WHEN** access token is decrypted successfully
- **THEN** step 2 calls `https://api.github.com/repos/{owner}/{repo}/git/trees/{defaultBranch}?recursive=1` with Authorization: Bearer ${accessToken} header; on non-200 response, throws error with status code and repo path

#### Scenario: Files are filtered by extension and size, max 500 dispatched
- **WHEN** GitHub API returns tree data with type, path, size
- **THEN** step 2 filters to blob type, size>0, path not starting with excluded prefixes, extension in [.ts, .tsx, .py]; returns list capped at MAX_FILES=500

#### Scenario: SourceConnection meta-node is upserted with sync metadata
- **WHEN** filtered files are obtained
- **THEN** step 3 upserts SourceConnection node in Neo4j with cursor=null, lastSyncAt=now(), entityCountDelta=fileCount, healthStatus='healthy'

#### Scenario: Parse-file events are batched at 50 per sendEvent call
- **WHEN** filteredFiles.length > 50
- **THEN** step 4 creates batches and calls step.sendEvent() once per batch, each with up to 50 `ingestion/github.parse-file` events

#### Scenario: Connection status transitioned to 'connected'
- **WHEN** all steps complete
- **THEN** step 5 updates source_connections status='connected', last_sync_at=now()

---

### Requirement: GitHub file parsing, symbol extraction, and feature inference dispatch
<!-- id: ingestionGithubParseFile.parseAndEmbed -->
<!-- entities: SourceFile, SourceSymbol, Feature -->
<!-- depends_on: GitHub tree fetch and file tree fan-out -->
<!-- triggers: GitHub infer-features dispatcher, entity embedding -->
<!-- enforced: ingestion.github-parse-file.ts -->

The parse-file function SHALL decrypt the access token, fetch raw file blob from GitHub, parse source file via tree-sitter, upsert SourceFile + SourceSymbol nodes in Neo4j in symbol batches, embed file text, and fire `ingestion/github.infer-features` asynchronously if language is known and symbols > 0.

#### Scenario: Large files (>500 KB) are skipped with log
- **WHEN** Content-Length header or actual response text exceeds 500 KB
- **THEN** step 2 logs "file too large, skipping" and returns {skipped: true, reason: "file_too_large"}

#### Scenario: SourceFile node is MERGE'd with naturalKey and metadata
- **WHEN** file content is successfully fetched and parsed
- **THEN** step 4 MERGEs SourceFile node with naturalKey=`github:${connectionId}:${owner}/${repo}:${path}` and orgId; ON CREATE sets publicId, path, language, repo, owner, connectionId, workspaceId, sha, createdAt; ON MATCH updates sha, language, syncedAt

#### Scenario: SourceSymbol nodes are upserted in batches of 20
- **WHEN** parseResult.symbols.length > 0
- **THEN** step 5 creates symbol batches, and for each batch runs a step with all symbols in a single Neo4j session; each MERGE SourceSymbol with naturalKey=`github:${connectionId}:${owner}/${repo}:${path}:${kind}:${name}` and orgId; creates :CONTAINS edge to parent SourceFile; after all symbols, MERGEs SourceFile → SourceConnection :SOURCED_FROM edge

#### Scenario: File embedding is stored on SourceFile node
- **WHEN** symbols are upserted
- **THEN** step 6 embeds file text (path + language + symbol names) via embedText(); step 7 stores embedding vector on SourceFile node with embeddingUpdatedAt=now()

#### Scenario: Feature inference event is fired only for known languages and non-empty symbol lists
- **WHEN** parseResult.language != "unknown" AND symbols.length > 0
- **THEN** step 7 fires `ingestion/github.infer-features` with fileNaturalKey, symbols, orgId, workspaceId, connectionId

---

### Requirement: LLM infers product features from source symbols
<!-- id: ingestionGithubInferFeatures.inferAndUpsert -->
<!-- entities: Feature, SourceFile -->
<!-- depends_on: GitHub file parsing, symbol extraction, and feature inference dispatch -->
<!-- enforced: ingestion.github-infer-features.ts -->

The feature-inference function SHALL call an LLM with file natural key, language, and symbol list to extract product-level features with confidence scores. Features with confidence >= 0.6 (CONFIDENCE_THRESHOLD) are upserted as Feature nodes in Neo4j, and :IMPLEMENTS edges are created to the SourceFile and related SourceSymbols.

#### Scenario: LLM infers features with name, description, relatedSymbolNames, confidence
- **WHEN** feature inference step runs
- **THEN** step 1 calls generateObjectFor() with featureSchema and system prompt instructing the LLM to extract high-confidence (>= 0.6) product features; returns array of up to 5 features

#### Scenario: Features below confidence threshold are discarded
- **WHEN** LLM returns features with confidence < 0.6
- **THEN** only acceptedFeatures (confidence >= 0.6) are processed; low-confidence features are logged but not written to Neo4j

#### Scenario: Feature nodes are upserted with slugified naturalKey
- **WHEN** acceptedFeatures.length > 0
- **THEN** step 2 for each feature: creates slugifiedName via .toLowerCase().replace(/\s+/g, "-"); MERGEs Feature node with naturalKey=`feature:${workspaceId}:${slugifiedName}` and orgId; sets publicId, name, description, workspaceId, connectionId, confidence on CREATE; updates description, confidence, updatedAt on MATCH

#### Scenario: Feature-to-SourceFile and Feature-to-SourceSymbol edges are created
- **WHEN** Feature node is upserted
- **THEN** step 2 creates :IMPLEMENTS edge from Feature to SourceFile, and for each relatedSymbolName (case-sensitive match), creates :IMPLEMENTS edge from Feature to SourceSymbol

---

### Requirement: Proactive OAuth token refresh with failure tracking
<!-- id: ingestionOauthRefresh.refreshExpiring -->
<!-- entities: OAuthAccount -->
<!-- enforced: ingestion.oauth-refresh.ts -->

A cron job running hourly SHALL find all oauth_accounts with tokens expiring within 24 hours and a non-null refresh_token_enc, decrypt the refresh token, call the provider's token endpoint, re-encrypt the new access and refresh tokens (if provided by provider), and update oauth_accounts. Decryption or HTTP failures increment refresh_failure_count and log warnings but do not throw; the job continues to the next token.

#### Scenario: Expiring accounts are queried with LIMIT 200
- **WHEN** the cron triggers
- **THEN** step 1 queries oauth_accounts WHERE expires_at < NOW() + INTERVAL '24 hours' AND refresh_token_enc IS NOT NULL ORDER BY expires_at ASC LIMIT 200; returns array of up to 200 ExpiringAccount records

#### Scenario: GitHub token refresh uses OAuth client credentials from env
- **WHEN** account.provider='github' AND decrypted refresh token is available
- **THEN** step 2 calls POST `https://github.com/login/oauth/access_token` with grant_type='refresh_token', refresh_token, client_id, client_secret; parses JSON response

#### Scenario: Successful token refresh updates account with new encrypted tokens
- **WHEN** GitHub token endpoint returns {access_token, refresh_token?, expires_in}
- **THEN** step 2 re-encrypts both access and refresh tokens via encrypt() with cryptoAdapter; updates oauth_accounts: access_token_enc, refresh_token_enc (if provided), expires_at, last_refreshed_at=now(), refresh_failure_count=0

#### Scenario: Decryption error increments failure count and logs warning
- **WHEN** decrypt() throws during refresh_token decryption
- **THEN** step 2 catches error, increments refresh_failure_count, logs warning, and returns early (does not throw; cron continues)

#### Scenario: GitHub token endpoint error increments failure count and logs warning
- **WHEN** response.error is set OR access_token is missing
- **THEN** step 2 increments refresh_failure_count, logs warning with error and description, returns early (does not throw)

#### Scenario: Unsupported provider is logged and skipped
- **WHEN** account.provider is not 'github'
- **THEN** step 2 logs info "provider refresh not yet implemented — skipping" and returns early

---

### Requirement: LLM infers semantic relationships and creates inferred edges
<!-- id: ingestionSemanticEdgeInfer.inferAndMaterialize -->
<!-- entities: EntityNode, InferredEdge, KnowledgeNode -->
<!-- depends_on: Ingest entity from raw connector payload into dual-write (Postgres + Neo4j) -->
<!-- enforced: ingestion.semantic-edge-infer.ts -->

The semantic-edge-infer function SHALL call an LLM to extract cross-entity relationships from an entity's property snapshot, write InferredEdge nodes with approvalStatus='pending' or 'approved', and immediately materialize as :SEMANTIC_EDGE relationships any edges with confidence >= 0.85 (auto-accept threshold).

#### Scenario: LLM infers edges with targetType, targetName, relationshipType, confidence
- **WHEN** `ingestion/entity.infer` event fires for an EntityNode with propertiesSnapshot
- **THEN** step 1 calls generateObjectFor() with edgeInferenceSchema and DEFAULT_SYSTEM_PROMPT; returns array of up to 20 edges with targetType, targetName, relationshipType, confidence (0.0–1.0)

#### Scenario: Inferred edges are written with nodeId-based merge key
- **WHEN** LLM returns edges
- **THEN** step 2 for each edge: MERGEs InferredEdge node with keys {orgId, sourceNodeId, targetType, targetName, relationshipType}; ON CREATE sets id, workspaceId, connectionId, confidence, approvalStatus, approvedBy, approvedAt, llmModel, semanticPrompt, inferredAt; ON MATCH updates confidence, approvalStatus (preserves if already approved), llmModel, semanticPrompt, inferredAt

#### Scenario: High-confidence edges (>= 0.85) are auto-approved and materialized immediately
- **WHEN** edge.confidence >= 0.85 (AUTO_ACCEPT_THRESHOLD)
- **THEN** InferredEdge is written with approvalStatus='approved', approvedBy='system:auto-accept', approvedAt=now(); step 2 immediately MERGEs KnowledgeNode placeholder (type, name, orgId, workspaceId) and creates :SEMANTIC_EDGE relationship from EntityNode to KnowledgeNode with type, confidence, approvedBy, approvedAt, inferredEdgeId

#### Scenario: Low-confidence edges (<0.85) are written as pending for human review
- **WHEN** edge.confidence < 0.85
- **THEN** InferredEdge is written with approvalStatus='pending', approvedBy=null, approvedAt=null; no :SEMANTIC_EDGE relationship is created

#### Scenario: Logging reports pending and auto-accepted edge counts
- **WHEN** inference completes
- **THEN** logger outputs counts: totalEdges, autoAccepted, pending

---

### Requirement: MCP plugin OAuth token refresh with reauth marking
<!-- id: pluginOauthRefreshWatcher.refreshMcpCredentials -->
<!-- entities: McpCredential, PluginInstalledPlugin -->
<!-- enforced: plugin.oauth-refresh-watcher.ts -->

A cron job running every 30 minutes SHALL find all mcpCredentials with auth_kind='oauth', status='active', and expiresAt < now() + 10 minutes, join pluginInstalledPlugins for endpointUrl, attempt refresh via DbOAuthClientProvider.auth() with the MCP SDK, and on success update tokens or on failure mark the credential needs_reauth.

#### Scenario: Expiring MCP credentials are loaded with endpoint URL
- **WHEN** the cron triggers
- **THEN** step 1 queries mcpCredentials WHERE authKind='oauth' AND status='active' AND expiresAt < now() + interval '10 minutes'; joins pluginInstalledPlugins to get endpointUrl for each; returns list of expiring credentials

#### Scenario: MCP auth refresh is attempted via DbOAuthClientProvider
- **WHEN** an expiring credential has a valid endpointUrl
- **THEN** step 2 constructs DbOAuthClientProvider with orgId, workspaceId, orgListingId, redirectUrl, state=`refresh:${orgListingId}`, clientName='Oxagen'; calls mcpAuth() which detects existing refresh_token and exchanges it for new access_token, calling saveTokens() on success

#### Scenario: Refresh success increments refreshed counter
- **WHEN** mcpAuth() returns without error
- **THEN** credential tokens are updated, refreshed counter is incremented, and the cron logs the success

#### Scenario: Refresh failure marks credential needs_reauth
- **WHEN** mcpAuth() throws an error
- **THEN** step 2 catches error, calls markCredentialNeedsReauth(), logs warning with credId and orgListingId, increments markedReauth counter (does not throw; cron continues)

---

### Requirement: MCP tool snapshot retention by deleted server age
<!-- id: mcpToolSnapshotRetention.purgeExpired -->
<!-- entities: McpToolSnapshot, McpServer -->
<!-- enforced: mcp.tool-snapshot-retention.ts -->

A cron job running monthly (2nd of month at 04:00 UTC) SHALL purge mcp.tool_snapshots whose owning mcp_server was soft-deleted 365 or more days ago. Deleted servers' snapshots are retained for replay durability; this job cleans up expired retention windows. Active (non-deleted) servers' snapshots are never purged.

#### Scenario: Purge targets snapshots by server deleted_at age, not snapshot capture_at
- **WHEN** the cron triggers on the 2nd of each month at 04:00 UTC
- **THEN** step 1 computes cutoff = now() - 365 days; deletes tool_snapshots WHERE mcp_server.deleted_at IS NOT NULL AND mcp_server.deleted_at <= cutoff; returns count of purged snapshots

#### Scenario: Active and paused servers are not affected
- **WHEN** mcp_server.deleted_at IS NULL (server is ENABLED or DISABLED, not yet deleted)
- **THEN** snapshots for that server are never purged, regardless of their captured_at age

#### Scenario: Purge instrumentation logs duration and counts
- **WHEN** purge completes
- **THEN** logger outputs purgedSnapshots count, cutoffISO timestamp, and durationMs for observability on Inngest dashboard

---

### Invariant: Entity naturalKey is immutable per connector, connection, externalId triple
<!-- entities: EntityNode -->
<!-- enforced: ingestion.pipeline.ts -->

A naturalKey SHALL be computed once per EntityNode as `${connectorType}:${connectionId}:${externalId}` and used as the idempotent merge key in Neo4j. The naturalKey is never mutated after EntityNode creation, ensuring stable deduplication across replayed ingestion events.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Dedup Pass A exact match takes precedence over embedding similarity
<!-- entities: EntityNode -->
<!-- enforced: ingestion.pipeline.ts -->

If dedup Pass A finds an exact naturalKey match in Neo4j, action="updated_principal" with confidence=1.0 is returned immediately. Pass B (embedding similarity) is only run if Pass A finds no match.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Source file embeddings are stored on SourceFile nodes before inference
<!-- entities: SourceFile -->
<!-- enforced: ingestion.github-parse-file.ts -->

A SourceFile node SHALL have its embedding vector stored (via step.run("store-file-embedding")) before any downstream inference step is triggered. The embeddingUpdatedAt timestamp is set to the current datetime.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: OAuth refresh token envelope is decrypted before provider API call
<!-- entities: OAuthAccount -->
<!-- enforced: ingestion.oauth-refresh.ts -->

Before calling any provider token endpoint, the refresh_token_enc envelope (JSONB {keyId, ciphertext}) is decrypted via decrypt() with the ingestion crypto adapter. The plaintext refresh token is used only within the step, never logged or persisted unencrypted.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Soft-delete of connections preserves Postgres audit rows
<!-- entities: SourceConnection -->
<!-- enforced: ingestion.delete.ts -->

When `ingestion/connection.delete` runs with mode='connection_only' or 'full', the source_connections row is soft-deleted: status='deleted', deleted_at=NOW(), deleted_by=requestedBy, updated_at=NOW(). The row is retained in Postgres, never physically removed, so deletion audit history is traceable.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Alias promotion happens before principal node deletion
<!-- entities: EntityNode, KnowledgeEdge -->
<!-- enforced: ingestion.delete.ts -->

When a principal EntityNode (created by a connection being deleted) has incoming :ALIAS_OF edges from other connections, the highest-confidence alias is promoted (naturalKey, displayName, properties copied) and all other ALIAS_OF edges are rerouted to point to the promoted alias BEFORE the original principal is deleted. This ensures unified entity view is preserved across remaining connections.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: GitHub initial-sync marks connection status='connected', not 'active'
<!-- entities: SourceConnection -->
<!-- enforced: ingestion.github-initial-sync.ts -->

The status constraint on source_connections (source_connections_status_check) allows only {pending_setup, connected, paused, error}. 'active' is not a valid status. After a successful sync, the connection status MUST be set to 'connected', not 'active'.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Symbol batches are processed sequentially within a single Neo4j session
<!-- entities: SourceSymbol -->
<!-- enforced: ingestion.github-parse-file.ts -->

Symbol upserts are split into batches of 20 (SYMBOL_BATCH_SIZE) to keep Neo4j session time bounded. Each batch runs in a separate step.run() to allow Inngest checkpointing between batches. All symbols in a single batch are upserted within one session, and the :CONTAINS and :SOURCED_FROM edges are created before the session closes.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Feature inference fires only for known languages and non-empty symbol lists
<!-- entities: Feature -->
<!-- enforced: ingestion.github-parse-file.ts -->

The `ingestion/github.infer-features` event is dispatched only if parseResult.language != 'unknown' AND parseResult.symbols.length > 0. Otherwise, no feature inference is triggered for that file.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Semantic edge auto-accept threshold is 0.85
<!-- entities: InferredEdge -->
<!-- enforced: ingestion.semantic-edge-infer.ts -->

Edges inferred by the LLM with confidence >= 0.85 are automatically approved and materialized as :SEMANTIC_EDGE relationships. Edges with confidence < 0.85 are written as InferredEdge nodes with approvalStatus='pending' and require manual approval before materialization.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Feature confidence threshold for persistence is 0.6
<!-- entities: Feature -->
<!-- enforced: ingestion.github-infer-features.ts -->

Only features inferred by the LLM with confidence >= CONFIDENCE_THRESHOLD (0.6) are upserted as Feature nodes in Neo4j. Lower-confidence features are logged but discarded.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: MCP credential refresh failure increments counter; cron continues
<!-- entities: McpCredential -->
<!-- enforced: plugin.oauth-refresh-watcher.ts -->

If refresh fails for a single MCP credential, the failure is logged, the credential is marked needs_reauth, and the cron job continues to the next credential. No single credential failure halts or throws from the overall cron job.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: MCP tool snapshot retention window is 365 days after server soft-delete
<!-- entities: McpToolSnapshot -->
<!-- enforced: mcp.tool-snapshot-retention.ts -->

Snapshots are retained for 365 days (RETENTION_MS = 365 * 24 * 60 * 60 * 1000 ms) after their owning server's deleted_at timestamp. Purge cutoff is computed as now() - RETENTION_MS. Only snapshots whose server was deleted at or before the cutoff are eligible for removal.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: ingestion.github-infer-features and ingestion.semantic-edge-infer use the same LLM model infrastructure (generateObjectFor) but the feature-inference system prompt is hardcoded in the function; the semantic-edge inference allows an ontologyPrompt override from the connector schema. Cross-connector feature inference customization path is unclear. -->

<!-- uncertainty: ingestion.github-parse-file calls embedText from @oxagen/ai but the telemetry.surface='ingestion' and executionStepId are hardcoded; no fallback or custom embedding strategy per connector type is evident. -->

<!-- uncertainty: The alias promotion logic in ingestion.delete.ts selects the highest-confidence alias to promote via ORDER BY r.confidence DESC LIMIT 1, but if multiple aliases have the same confidence, tiebreaker behavior is undefined (Neo4j's result ordering is undefined in that case). -->
