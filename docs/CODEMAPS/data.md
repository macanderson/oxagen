<!-- Generated: 2025-07-10 | Files scanned: 49 (database pkg) | Token estimate: ~850 -->

# Data Architecture

## Primary Store — PostgreSQL (Neon / local port 5433)
ORM: **Drizzle** (`packages/database/src/`)
Schema files: `packages/database/src/schema/`
Client: `packages/database/src/client.ts`
Tenant mock: `packages/database/src/tenant.mock.ts`

### Schema: auth.ts
```
users               id, email, name, image, createdAt, updatedAt
credentials         userId, type (password/passkey), data
apiKeys             id, orgId, workspaceId, userId, keyHash, prefix, name, expiresAt
sessions            id, userId, token, expiresAt
accounts            userId, provider, providerAccountId
verifications       identifier, value, expiresAt
rateLimitTable      key, count, lastRequest
userPreferences     userId, theme, locale, notifications, ...
```

### Schema: org.ts
```
organizations       id, slug, name, plan, createdAt
orgUsers            orgId, userId, role (owner|admin|member)
orgSlugHistory      orgId, oldSlug, newSlug, changedAt
invitations         id, orgId, email, role, token, expiresAt
```

### Schema: workspace.ts
```
workspaces          id, orgId, slug, name, settings (JSON), createdAt
workspaceSlugHistory
workspaceUsers      workspaceId, userId, role
workspaceMemoryPolicy workspaceId, policy (JSON)
```

### Schema: chat.ts
```
conversations       id, orgId, workspaceId, userId, title, archivedAt
messages            id, conversationId, role, content (JSON), toolCalls (JSON), createdAt
```

### Schema: agent.ts
```
agents              id, orgId, workspaceId, name, description, config (JSON)
agentTriggers       agentId, type, config (JSON), enabled
agentVersions       agentId, version, config (JSON), publishedAt
skills              id, orgId, name, slug, description
skillVersions       skillId, version, content, status
backgroundTasks     id, orgId, workspaceId, agentId, status, result, startedAt, endedAt
approvalRequests    id, agentId, taskId, type, payload, status, resolvedAt
subagentFanouts     id, parentTaskId, orgId, workspaceId, status
subagentRuns        fanoutId, agentId, status, result, logs
agentExecutions     id, agentId, conversationId, status, startedAt, endedAt
agentExecutionSteps executionId, stepIndex, type, input, output, durationMs
agentToolCalls      executionId, stepId, tool, input, output, durationMs
sandboxSessions     id, orgId, workspaceId, agentId, sandboxId, status
agentPlans          id, agentId, taskId, steps (JSON), status
```

### Schema: billing.ts
```
plans               id, name, stripePriceId, limits (JSON)
subscriptions       orgId, planId, stripeSubId, status, currentPeriodEnd
paymentMethods      orgId, stripePaymentMethodId, last4, brand
invoices            id, orgId, stripeInvoiceId, amount, status, paidAt
invoiceLineItems    invoiceId, description, amount
usageRecords        orgId, workspaceId, metric, quantity, recordedAt
creditBalances      orgId, balanceCents
creditLedger        orgId, delta, reason, createdAt
creditLots          orgId, amountCents, expiresAt, usedCents
stripeEvents        stripeEventId, type, processed, processedAt
orgBillingProfiles  orgId, stripeCustomerId, email
orgBillingSettings  orgId, autoreload (JSON), taxId
billingDisputes     orgId, stripeDisputeId, status
stripeEventProcessing id, eventId, status, attempts
```

### Schema: ingestion.ts
```
sourceConnections   id, orgId, workspaceId, connectorId, config (JSON), status
authCredentials     connectionId, type, encryptedData
oauthTokens         connectionId, accessToken (encrypted), refreshToken, expiresAt
webhookSubscriptions connectionId, webhookId, secret, events
oauthAccounts       connectionId, accountId, accountName
entityTypes         id, connectionId, name, config (JSON)
entityTypeMappings  entityTypeId, targetSchema
setupSuggestions    connectionId, suggestions (JSON)
deletionJobs        id, connectionId, status
connectorSchemas    connectorId, schema (JSON)
```

### Schema: mcp.ts
```
mcpRegistries       id, orgId, workspaceId, url, name
mcpCredentials      registryId, type, encryptedData
mcpServers          id, registryId, name, toolCount, enabled
mcpConsents         id, orgId, workspaceId, userId, tool, granted, expiresAt
mcpCatalogServers   id, name, url, description, tags
mcpToolSnapshots    id, mcpServerId, tools (JSON), capturedAt
```

### Schema: iam.ts
```
principals          id, orgId, type (user|agent|service), externalId
roles               id, orgId, name, permissions (JSON)
roleGrants          principalId, roleId, grantedAt, expiresAt
accessRequests      id, principalId, resource, action, status, requestedAt
principalRoleAssignments principalId, roleId, assignedAt
```

### Schema: workflow.ts (Playbooks)
```
playbooks           id, orgId, workspaceId, name, description
playbookVersions    playbookId, version, definition (JSON)
playbookSteps       id, playbookId, type, config (JSON)
playbookEdges       fromStepId, toStepId, condition
playbookTriggers    playbookId, type, config (JSON)
playbookRuns        id, playbookId, status, startedAt, endedAt
playbookStepRuns    runId, stepId, status, input, output
playbookEvents      runId, type, payload, createdAt
playbookApprovals   runId, stepId, status, resolvedAt
```

### Schema: schema-registry.ts (Ontology)
```
schemaRegistries    id, orgId, workspaceId, name
schemaVersions      registryId, version, status (draft|active|archived)
schemas             registryId, versionId, definition (JSON)
schemaActivations   registryId, versionId, activatedAt
nodeLabels          registryId, label, properties (JSON)
relationshipTypes   registryId, type, fromLabel, toLabel
schemaProperties    nodeLabel, name, type, required
```

### Schema: environments.ts
```
environments        id, orgId, workspaceId, name, isDefault
secretKeys          id, environmentId, name, description
secretValues        keyId, environmentId, encryptedValue
secretAccessLog     keyId, userId, accessedAt, action
```

### Schema: Other
```
-- content.ts
generatedAssets     id, orgId, workspaceId, type, url, metadata (JSON)
documents           id, orgId, workspaceId, title, content, format

-- notification.ts
notifications       id, orgId, userId, type, payload (JSON), readAt

-- plugin.ts
pluginInstalledPlugins orgId, workspaceId, pluginId, config (JSON), enabled

-- security.ts
securityEvents      id, orgId, type, severity, payload (JSON), createdAt
orgSecurityPolicy   orgId, policy (JSON)
mcpServerChanges    id, mcpServerId, changeType, before, after, changedAt

-- privacy.ts
privacyExportRequests  id, orgId, userId, status, downloadUrl, expiresAt
privacyErasureRequests id, orgId, userId, status, completedAt
```

## Graph Store — Neo4j
```
URI:      NEO4J_URI (env)
Database: NEO4J_DATABASE
Usage:
  - Knowledge graph nodes + relationships
  - Agent execution lineage
  - Memory nodes (synced from Engram)
  - Semantic edges / ontology
  - Code graph (packages/code-graph/)
Packages: packages/engram/src/store/graph-store.ts
          packages/agent/src/memory/neo4j.ts
          packages/agent/src/adapters/graph-sync.ts
```

## Memory Store — Engram (packages/engram/)
```
Backends:
  - DuckDB (local episodic store)         engram/src/store/duckdb-adapter.ts
  - ClickHouse (analytics/telemetry)      engram/src/store/clickhouse-adapter.ts
  - Neo4j (graph sync)                    engram/src/store/graph-store.ts
  - PostgreSQL (via @oxagen/database)

Subsystems:
  embed/        → vector embedding pipeline + quantization
  retrieval/    → fusion (vector+lexical+graph+temporal)
  blackboard/   → multi-agent shared working memory
  consolidation → dedup, distill, promote
  compiler/     → context window packing
  session/      → session event log, fork, replay
  sync/         → CRDT merge, Merkle sync, protocol
  api/          → remember, recall, pin, relate, assert
```

## Storage — Vercel Blob
```
VERCEL_BLOB_READ_WRITE_TOKEN (env)
Package: packages/storage/src/
Usage: avatar uploads, generated assets, skill exports, archives
```

## Migrations
```
Location: packages/database/migrations/
Tool:     Drizzle Kit (pnpm migrate in database package)
Count:    0 SQL files tracked (migrations generated on demand)
```

## Encryption
```
Secrets:    AES-256-GCM (env key) OR AWS KMS (AWS_KMS_INGESTION_KEY_ARN)
Package:    packages/crypto/src/
Auth tokens: packages/auth/src/token-encryption.ts
```
