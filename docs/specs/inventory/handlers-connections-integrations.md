# Spec: handlers-connections-integrations

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: connection.*.ts, integration.*.ts, repo.*.ts handlers
> Last verified: 2026-06-20 (commit 2f628504)

Behavioral specifications for the Oxagen data connector lifecycle: connection provisioning (create/update/delete), preview and field mapping, integration configuration and synchronization, and repository configuration. The connector model implements a **dual-write pattern**: operational state (connection status, sync metadata, auth credentials) lives in PostgreSQL as the source of truth; Neo4j graph index (entities, relationships, embeddings) is populated asynchronously via Inngest. Connections are tenant-scoped (org + workspace) and soft-delete aware. Delivery methods include polling, webhook, and manual-trigger sync modes.

---

### Requirement: Connection creation provisions auth and pending metadata
<!-- id: connection.create.ts.connectionCreateHandler -->
<!-- entities: SourceConnection, AuthCredential, Connector -->
<!-- enforced: connection.create.ts.connectionCreateHandler() -->

When a user creates a new data source connection, the system SHALL validate the connector exists, encrypt the auth credentials, store both the connection metadata in the `source_connections` table and the encrypted credential envelope in `auth_credentials`, and return the connection with an initial `pending_setup` status. Credentials are encrypted with a key ID tracked in the envelope alongside the base64-encoded ciphertext.

#### Scenario: User creates a valid connection with auth credential
<!-- test: connection.create.test.ts.* -->
- **WHEN** user calls `connection.create` with valid `connectorId`, `displayName`, `authCredential` (typed dict with "type" field), and optional `connectionConfig`
- **THEN** system validates connector exists via `getConnector(connectorId)`, generates a unique `publicId`, inserts row in `source_connections` with status `pending_setup`, stores encrypted credential in `auth_credentials`, and returns connection record with `connectionId`, `publicId`, `status`, `connectorId`, and `displayName`

#### Scenario: Delivery method defaults from connector if not provided
- **WHEN** `connection.create` is called without explicit `deliveryMethod`
- **THEN** system reads default `deliveryMethod` from connector definition and uses it in the inserted record

#### Scenario: Unauthenticated request is rejected
- **WHEN** `connection.create` is called without `ctx.userId`
- **THEN** system throws error "connection.create requires an authenticated user"

---

### Requirement: Connection update applies partial field modifications
<!-- id: connection.update.ts.connectionUpdateHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: connection.update.ts.connectionUpdateHandler() -->
<!-- depends_on: Connection creation provisions auth and pending metadata -->

When a user updates a connection, the system SHALL selectively apply provided fields (`displayName`, `deliveryConfig`) to the matching connection, ignoring unspecified fields (partial update). Credentials are not modified via this capability. The connection must exist and not be soft-deleted; 404 is returned otherwise.

#### Scenario: User updates display name only
- **WHEN** user calls `connection.update` with `connectionId` and `displayName` set
- **THEN** system finds the connection (org/workspace-scoped, not soft-deleted), updates only the `displayName` and `updatedAt` fields, and returns the updated row with current `displayName`, `status`, and `deliveryConfig`

#### Scenario: User updates delivery config only
- **WHEN** user calls `connection.update` with `connectionId` and `deliveryConfig` set
- **THEN** system finds the connection and updates only the `deliveryConfig` and `updatedAt` fields

#### Scenario: No-op update when neither field is provided
- **WHEN** user calls `connection.update` with `connectionId` only (no `displayName` or `deliveryConfig`)
- **THEN** system skips the UPDATE statement and returns the current connection state (no-op, still queries and returns)

#### Scenario: Soft-deleted connection returns 404
- **WHEN** connection has `deletedAt IS NOT NULL`
- **THEN** system returns HTTP 404 "Connection not found"

---

### Requirement: Connection deletion queues async purge job
<!-- id: connection.delete.ts.connectionDeleteHandler -->
<!-- entities: SourceConnection, DeletionJob -->
<!-- enforced: connection.delete.ts.connectionDeleteHandler() -->
<!-- depends_on: Connection creation provisions auth and pending metadata -->
<!-- triggers: Async purge removes entities and Neo4j records (Inngest) -->

When a user deletes a connection, the system SHALL atomically transition the connection to `deleting` status, create a `DeletionJob` record to track async progress, and dispatch an Inngest event for purge-worker pickup. The deletion mode (connection_only | data_only | full) is persisted in the job for the async worker to enforce.

#### Scenario: User initiates connection deletion with full purge
<!-- test: connection.delete.test.ts.* -->
- **WHEN** user calls `connection.delete` with `connectionId` and `mode: "full"`
- **THEN** system verifies connection exists (org/workspace-scoped, not soft-deleted), sets connection status to `deleting`, inserts row in `deletion_jobs` with `status: "running"`, fires Inngest event `ingestion/connection.delete` with connection ID, org/workspace context, mode, and user ID, and returns `deletionJobId`, `mode`, and `status: "running"`

#### Scenario: Only connection_only deletion mode
- **WHEN** user calls with `mode: "connection_only"`
- **THEN** system enqueues the job with `deleteMode: "connection_only"` for async worker to interpret

#### Scenario: Unauthenticated request is rejected
- **WHEN** `connection.delete` is called without `ctx.userId`
- **THEN** system throws error "connection.delete requires an authenticated user"

#### Scenario: Non-existent connection returns 404
- **WHEN** connection with given `connectionId` does not exist or is soft-deleted
- **THEN** system returns HTTP 404 "Connection not found"

---

### Requirement: Connection retrieval returns full connection detail
<!-- id: connection.get.ts.connectionGetHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: connection.get.ts.connectionGetHandler() -->

When a user queries a single connection, the system SHALL return the complete connection record including sync metadata, status, entity count, and error state. Dates are ISO-formatted. Soft-deleted connections are excluded.

#### Scenario: User retrieves active connection
- **WHEN** user calls `connection.get` with `connectionId`
- **THEN** system finds the connection (org/workspace-scoped, not soft-deleted) and returns all fields: `publicId`, `connectorId`, `displayName`, `authScheme`, `deliveryMethod`, `deliveryConfig`, `status`, `entityCount`, `lastSyncAt` (ISO string or null), `errorMessage`, and timestamps

#### Scenario: Non-existent connection returns 404
- **WHEN** connection does not exist or is soft-deleted
- **THEN** system returns HTTP 404 "Connection not found"

---

### Requirement: Connection list returns filtered connections ordered by creation
<!-- id: connection.list.ts.connectionListHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: connection.list.ts.connectionListHandler() -->

When a user lists connections, the system SHALL return all non-deleted connections in the org/workspace, optionally filtered by status or connectorId, ordered ascending by creation time.

#### Scenario: User lists all connections
- **WHEN** user calls `connection.list` with no filters
- **THEN** system returns array of connections (org/workspace-scoped, not soft-deleted), each with `publicId`, `connectorId`, `displayName`, `authScheme`, `deliveryMethod`, `status`, `entityCount`, `lastSyncAt` (ISO or null), and `createdAt` (ISO), ordered by `createdAt ASC`

#### Scenario: User filters by status
- **WHEN** user calls `connection.list` with `status: "connected"`
- **THEN** system adds `WHERE status = 'connected'` and returns only matching connections

#### Scenario: User filters by connector type
- **WHEN** user calls `connection.list` with `connectorId: "github"`
- **THEN** system adds `WHERE connector_id = 'github'` and returns only GitHub connections

#### Scenario: Combined status + connector filter
- **WHEN** user calls with both `status` and `connectorId`
- **THEN** system applies both conditions (AND)

---

### Requirement: Connection pause/resume toggles sync state
<!-- id: connection.pause.ts.connectionPauseHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: connection.pause.ts.connectionPauseHandler() -->

When a user pauses or resumes a connection, the system SHALL toggle its status between `connected` and `paused`. Only connections in one of these two states may be paused or resumed; connections in `pending_setup`, `error`, `deleting`, or `deleted` states are rejected with a 409 Conflict.

#### Scenario: User pauses a connected connection
- **WHEN** user calls `connection.pause` with `paused: true` on a connection in `connected` status
- **THEN** system sets status to `paused` and returns the updated connection

#### Scenario: User resumes a paused connection
- **WHEN** user calls `connection.pause` with `paused: false` on a connection in `paused` status
- **THEN** system sets status to `connected` and returns the updated connection

#### Scenario: Cannot pause a connection in pending_setup
- **WHEN** connection is in `pending_setup` status
- **THEN** system returns HTTP 409 with message "Connection is 'pending_setup' — only connected/paused connections can be paused or resumed"

#### Scenario: Cannot pause a connection in error state
- **WHEN** connection is in `error` status
- **THEN** system returns HTTP 409 Conflict

#### Scenario: Non-existent connection returns 404
- **WHEN** connection does not exist
- **THEN** system returns HTTP 404 "Connection not found"

---

### Requirement: Connection preview fetches sample record types with fields
<!-- id: connection.preview.ts.connectionPreviewHandler -->
<!-- entities: SourceConnection, AuthCredential -->
<!-- enforced: connection.preview.ts.connectionPreviewHandler() -->

When a user previews a connection, the system SHALL decrypt the stored auth credentials, invoke the connector's `previewRecordTypes()` method to retrieve sample data, and return a list of record types with their field schemas and up to 3 sample records per type.

#### Scenario: User previews a newly configured connection
- **WHEN** user calls `connection.preview` with `connectionId`
- **THEN** system retrieves connection + auth credentials (inner join), decrypts the credential envelope, invokes `connector.previewRecordTypes(authCredential, deliveryConfig)`, and returns array of `recordTypes` with `sourceRecordType`, `displayName`, `sampleCount`, `sampleFields` (Object.keys of field schema), and `sampleRecords` (up to 3)

#### Scenario: Connection not found returns 404
- **WHEN** connection does not exist
- **THEN** system returns HTTP 404 "Connection not found"

#### Scenario: Connector preview fails upstream
- **WHEN** `connector.previewRecordTypes()` raises an error
- **THEN** error propagates to caller (no retries in this handler)

---

### Requirement: Fetch entity type mappings for a connection
<!-- id: connection.mappings.get.ts.connectionMappingsGetHandler -->
<!-- entities: SourceConnection, EntityTypeMapping -->
<!-- enforced: connection.mappings.get.ts.connectionMappingsGetHandler() -->
<!-- depends_on: Connection creation provisions auth and pending metadata -->

When a user retrieves mappings for a connection, the system SHALL return all active entity type mappings (source record type → Oxagen entity type + property mappings) ordered by creation time.

#### Scenario: User retrieves mappings for a configured connection
- **WHEN** user calls `connection.mappings.get` with `connectionId`
- **THEN** system finds all rows in `entity_type_mappings` joined to the source connection, returns array with `id` (publicId), `sourceRecordType`, `oxagenEntityType`, `propertyMappings` (JSONB record<string,string>), `isActive`, `createdAt` (ISO), and `updatedAt` (ISO), ordered by `createdAt ASC`

#### Scenario: Connection with no mappings returns empty array
- **WHEN** connection exists but has no mappings
- **THEN** system returns `{ mappings: [] }`

#### Scenario: Connection not found returns 404 implicitly
- **WHEN** connection does not exist
- **THEN** inner join produces no rows; empty array returned

---

### Requirement: Upsert entity type mappings and optionally activate connection
<!-- id: connection.mappings.set.ts.connectionMappingsSetHandler -->
<!-- entities: SourceConnection, EntityTypeMapping -->
<!-- enforced: connection.mappings.set.ts.connectionMappingsSetHandler() -->
<!-- depends_on: Connection creation provisions auth and pending metadata -->
<!-- triggers: GitHub initial-sync event fired for GitHub connections on activation -->

When a user sets mappings for a connection, the system SHALL upsert each (connection, sourceRecordType) pair, optionally transition the connection from `pending_setup` to `connected`, and fire a GitHub initial-sync Inngest event if applicable.

#### Scenario: User saves mappings for multiple record types
- **WHEN** user calls `connection.mappings.set` with array of mappings (each with `sourceRecordType`, `oxagenEntityType`, `propertyMappings`)
- **THEN** for each mapping, system checks if (connectionId, sourceRecordType) exists: if yes, UPDATE with new entity type and property mappings (set `isActive: true`); if no, INSERT new row with generated publicId. Returns `mappingsCreated` and `mappingsUpdated` counts

#### Scenario: User activates a pending_setup connection with mappings
- **WHEN** user calls with `activateConnection: true` and connection is in `pending_setup`
- **THEN** system (after upserting mappings) updates connection status to `connected`, and if `connectorId === "github"`, fires Inngest event `ingestion/github.initial-sync` with owner, repo, and defaultBranch from `deliveryConfig`

#### Scenario: Connection not found returns 404
- **WHEN** connection does not exist
- **THEN** system throws HTTP 404 "Connection not found"

#### Scenario: Activation is skipped for already-connected connection
- **WHEN** `activateConnection: true` but connection status is already `connected`
- **THEN** mappings are upserted; status remains `connected`; no GitHub event fired

---

### Requirement: Suggest entity type mappings via LLM
<!-- id: connection.mappings.suggest.ts.connectionMappingsSuggestHandler -->
<!-- entities: SourceConnection, SetupSuggestion -->
<!-- enforced: connection.mappings.suggest.ts.connectionMappingsSuggestHandler() -->

When a user requests mapping suggestions, the system SHALL invoke an LLM with the connection's preview (record type schemas and samples), optionally considering existing entity types in the workspace, generate suggestions (entity type name, property mappings, confidence, reasoning), and persist pending suggestions in `setup_suggestions` for later acceptance/rejection.

#### Scenario: User requests suggestions for a new connection
- **WHEN** user calls `connection.mappings.suggest` with `connectionId`, array of `recordTypes` (with `sourceRecordType`, `displayName`, `sampleFields`, `sampleRecords`), and optional `existingEntityTypes`
- **THEN** system constructs a prompt describing each record type, invokes `generateObjectFor()` with LLM to return suggestions, parses response (array of {sourceRecordType, suggestedEntityType, suggestedPropertyMappings, confidence, reasoning}), inserts suggestions into `setup_suggestions` with status `pending`, and returns suggestions array + array of suggestion publicIds

#### Scenario: Existing entity types are mentioned in prompt
- **WHEN** `existingEntityTypes` array is non-empty
- **THEN** prompt includes context: "Existing entity types already defined in this workspace: [list]. Prefer reusing these names when they are a good fit."

#### Scenario: Connection not found returns 404
- **WHEN** connection does not exist
- **THEN** system throws HTTP 404 "Connection not found"

---

### Requirement: Integration install queues async setup (stub)
<!-- id: integration.install.ts.integrationInstallHandler -->
<!-- entities: Integration, Plugin -->
<!-- enforced: integration.install.ts.integrationInstallHandler() -->

When a user installs a plugin integration, the system SHALL queue an async install job via Inngest. Currently a stub: TODO fetch plugin schema, validate config, persist integration record, dispatch job.

#### Scenario: User initiates plugin installation
- **WHEN** user calls `integration.install` with `pluginId`, `displayName`
- **THEN** system generates a jobId, logs the request, and returns `{ jobId, status: "queued", pluginId, displayName }`

---

### Requirement: Configure integration filters and sync cadence
<!-- id: integration.configure.ts.integrationConfigureHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: integration.configure.ts.integrationConfigureHandler() -->
<!-- depends_on: Connection creation provisions auth and pending metadata -->

When a user configures an integration (a source connection's sync behavior), the system SHALL merge filter/inference settings into the connection's `deliveryConfig` while preserving connector-specific fields (like GitHub owner/repo). Validation is applied: sync intervals must be positive, filter arrays are type-checked, confidence thresholds are clamped to [0,1], per-record-type toggles are validated as records of booleans. Custom inference prompts are persisted.

#### Scenario: User configures polling sync with record type filters
- **WHEN** user calls `integration.configure` with `integrationId`, `syncCadence: "polling"`, `syncIntervalSeconds: 600`, `config: { recordTypeFilters: ["issue", "pr"] }`
- **THEN** system finds connection, merges config (preserving existing owner/repo/installationId), sets `syncMethod: "polling"`, `syncIntervalSeconds: 600`, `recordTypeFilters: ["issue", "pr"]`, and updates connection with merged `deliveryConfig`

#### Scenario: User enables semantic inference with custom threshold
- **WHEN** user calls with `inferenceEnabled: true`, `config: { confidenceThreshold: 0.8 }`
- **THEN** system sets `semanticInference.enabled: true`, `confidenceThreshold: 0.8` in deliveryConfig

#### Scenario: Invalid sync interval defaults to 300
- **WHEN** `syncIntervalSeconds` is non-positive or non-numeric
- **THEN** system uses default 300 seconds

#### Scenario: Confidence threshold clamped to [0,1]
- **WHEN** `confidenceThreshold` is negative or >1
- **THEN** system uses default 0.75

#### Scenario: User sets custom ontology prompt
- **WHEN** user calls with `ontologyPrompt: "custom prompt text"`
- **THEN** system persists prompt under `semanticInference.ontologyPrompt`

#### Scenario: Clearing a custom prompt with empty string
- **WHEN** user calls with `ontologyPrompt: ""` (empty string)
- **THEN** system does NOT include the key in the final config (omits it), preserving prior value if unspecified

#### Scenario: Integration not found returns error
- **WHEN** integration does not exist
- **THEN** system throws error "integration.configure: integration not found: [id]"

---

### Requirement: Queue integration sync job with cadence context
<!-- id: integration.sync.ts.integrationSyncHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: integration.sync.ts.integrationSyncHandler() -->
<!-- depends_on: Configure integration filters and sync cadence -->

When a user manually triggers a sync or the system schedules a poll, the system SHALL resolve the connection, determine the sync method (polling/webhook/manual) from deliveryConfig, generate a jobId, and dispatch an Inngest event with sync context for the worker to pick up.

#### Scenario: User manually syncs a webhook connection
- **WHEN** user calls `integration.sync` with `integrationId`, `mode: "manual"`
- **THEN** system finds connection, reads `deliveryConfig.syncMethod` (or falls back to `deliveryMethod` or "manual"), generates jobId, fires Inngest event `ingestion/sync.requested` with jobId, connectionId, orgId, workspaceId, integrationId, mode, syncMethod, syncIntervalSeconds, and returns `{ jobId, status: "queued", integrationId, mode }`

#### Scenario: Polling cadence is resolved from deliveryConfig
- **WHEN** connection has `deliveryConfig.syncMethod: "polling"` and `syncIntervalSeconds: 1200`
- **THEN** system queues the job with `syncIntervalSeconds: 1200` so Inngest can apply the correct backoff

#### Scenario: Manual sync default
- **WHEN** `syncMethod` is not set in deliveryConfig or deliveryMethod
- **THEN** system defaults to "manual"

#### Scenario: Integration not found returns error
- **WHEN** integration does not exist
- **THEN** system throws error "integration.sync: integration not found: [id]"

---

### Requirement: Fetch integration sync metrics and health
<!-- id: integration.metrics.ts.integrationMetricsHandler -->
<!-- entities: SourceConnection -->
<!-- enforced: integration.metrics.ts.integrationMetricsHandler() -->

When a user queries integration health/metrics, the system SHALL return the current connection state: status (mapped from DB enum to contract enum), entity count, last sync timestamp, and last error. No per-type breakdown or duration metrics are available (honest null/empty, not fabricated).

#### Scenario: User checks metrics for an active integration
- **WHEN** user calls `integration.metrics` with `integrationId`
- **THEN** system finds connection and returns: `integrationId`, `pluginId` (connectorId), `displayName`, `status` (mapped: connected→active, paused→paused, error→failed, pending_setup/deleting/deleted→pending_setup), `entityCount`, `entityCountByType: {}` (empty; no per-type tracking in DB), `lastSyncAt` (ISO or null), `lastSyncDurationMs: null` (no dedicated column), `lastErrorAt` (ISO if status is error with message, else null), `errorMessage` (string or null)

#### Scenario: Pending setup connection with no sync history
- **WHEN** connection is in `pending_setup` with no prior syncs
- **THEN** system returns `lastSyncAt: null`, `entityCount: 0`, `errorMessage: null`

#### Scenario: Error state with message
- **WHEN** connection is in `error` status with `errorMessage` set
- **THEN** system returns `status: "failed"` and `lastErrorAt` using connection's `updatedAt` as proxy

#### Scenario: Integration not found returns error
- **WHEN** integration does not exist
- **THEN** system throws error "integration.metrics: integration not found: [id]"

---

### Requirement: Repository configuration updates sync settings (stub)
<!-- id: repo.configure.ts.repoConfigureHandler -->
<!-- entities: Repository -->
<!-- enforced: repo.configure.ts.repoConfigureHandler() -->

When a user configures a repository connection, the system SHALL accept record types, path filters, label filters, and inference settings, and persist them to the connection. Currently a stub: TODO wire to actual DB update and re-index if needed.

#### Scenario: User configures repo record types and filters
- **WHEN** user calls `repo.configure` with `repoId`, `recordTypes: ["pull_request", "commit"]`, `pathFilters: {include: [], exclude: []}`, `inferenceEnabled: true`
- **THEN** system returns configuration summary with the provided values (or defaults if omitted)

#### Scenario: Default record types
- **WHEN** `recordTypes` is not provided
- **THEN** system returns default `["pull_request", "issue", "commit"]`

#### Scenario: Default sync cadence
- **WHEN** `syncCadence` is not provided
- **THEN** system returns `"manual"`

---

### Requirement: Repository sync triggers async git operations (stub)
<!-- id: repo.sync.ts.repoSyncHandler -->
<!-- entities: Repository -->
<!-- enforced: repo.sync.ts.repoSyncHandler() -->

When a user syncs a repository, the system SHALL queue an async job to fetch repo state and apply diffs. Currently a stub: TODO implement actual Inngest job trigger and diff cursor logic.

#### Scenario: User manually syncs a repository
- **WHEN** user calls `repo.sync` with `repoId`, `mode: "manual"`
- **THEN** system generates jobId, logs request, returns `{ jobId, status: "queued", mode: "manual", estimatedRecords: 0 }`

---

### Invariant: Encrypted credentials are always stored separately from connection metadata
<!-- entities: SourceConnection, AuthCredential -->
<!-- enforced: connection.create.ts (line 52-58), connection.preview.ts (line 16-29) -->

The system SHALL never store plaintext auth credentials in `source_connections`. All credentials are encrypted with a key ID and stored in `auth_credentials` as a separate row keyed by `connectionId`. Decryption happens only when explicitly needed (preview, sync worker).

---

### Invariant: Connection status transitions respect valid state graph
<!-- entities: SourceConnection -->
<!-- enforced: schema.ingestion.sourceConnections (line 40: CHECK constraint) -->

The system SHALL only allow connection status values from the defined enum: `pending_setup`, `connected`, `paused`, `error`, `deleting`, or `deleted`. No other values may be written. A connection in `deleting` transitions to `deleted` only via async purge job. `paused` may transition to `connected` and vice versa only via `connection.pause`. `error` is written by sync workers on failure.

---

### Invariant: Tenant scope is always enforced (org + workspace)
<!-- entities: SourceConnection, EntityTypeMapping, SetupSuggestion, DeletionJob -->
<!-- enforced: connection.*.ts (all handlers use withTenantDb + orgId/workspaceId checks) -->

All queries against ingestion tables MUST include `WHERE orgId = ctx.orgId AND workspaceId = ctx.workspaceId` to prevent cross-tenant data leakage. Soft-deleted rows (deletedAt IS NOT NULL) are excluded in retrieval operations.

---

### Invariant: Entity type mapping is unique per (connection, sourceRecordType) pair
<!-- entities: EntityTypeMapping -->
<!-- enforced: schema.ingestion.entityTypeMappings (line 184: unique constraint) -->

The system SHALL enforce at the database level that only one active mapping exists per (connectionId, sourceRecordType) combination. Upserts are safe: if the pair exists, UPDATE; if not, INSERT.

---

### Invariant: Delivery config merging preserves unrelated fields
<!-- entities: SourceConnection -->
<!-- enforced: integration.configure.ts (line 98-113) -->

When updating `deliveryConfig`, the system SHALL preserve connector-specific fields (owner, repo, installationId, selectedRepos, etc.) set during the connection wizard. Merging is done via object spread: existing fields first, then new typed fields override. Fields not mentioned in input are retained.

---

### Invariant: Setup suggestions are persisted before return
<!-- entities: SetupSuggestion -->
<!-- enforced: connection.mappings.suggest.ts (line 80-98) -->

Every suggestion returned to the user is persisted in `setup_suggestions` with status `pending` so that downstream accept/reject operations can reference them by publicId. Suggestions are never transient.

---

<!-- deferred: No further cross-module dependencies detected; connection/integration/repo handlers are self-contained. Event client (Inngest) invocation scope already sampled. -->

<!-- uncertainty: integration.install and repo.configure/repo.sync are currently stubs (TODO markers in code). Actual database persistence and Inngest job logic are not yet implemented; specs above document the intended behavior as expressed in comments and return types. -->

