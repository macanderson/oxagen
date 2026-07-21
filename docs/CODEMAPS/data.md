<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 23 (database pkg schema/), 55 migrations | Token estimate: ~900 -->

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
twoFactorTable      userId, secret, backupCodes
userPreferences     userId, theme, locale, notifications, ...
workspaceUserPreferences userId, workspaceId, coding-agent defaults (JSON) — per
                    (user, workspace) preferences (get/update_workspace_user_preferences)
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
workspaces            id, orgId, slug, name, settings (JSON), createdAt
workspaceSlugHistory
workspaceUsers        workspaceId, userId, role
workspaceMemoryPolicy workspaceId, policy (JSON)
workspaceBudgetPolicy workspaceId, limits (JSON) — per-workspace cost governance
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
a2aTasks            id, orgId, workspaceId, publicId, skillId, status — A2A
                    JSON-RPC task state; `public_id` backs the SSE
                    tasks/resubscribe live-attach in apps/api/src/routes/a2a/
                    stream-registry.ts
fileLocks           id, orgId, workspaceId, path, agentId, acquiredAt — cross-agent
                    file lock for parallel fleet work
fileLockFences      lockId, fenceToken, expiresAt — lease/fencing tokens
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

### Schema: ai.ts
```
aiResponseCache     id, orgId, cacheKey, promptHash, model, surface, responseKind,
                    response (JSON), usage (JSON), embedding (JSON, semantic layer) —
                    layered deterministic-call cache; OPT-IN per call site, NEVER
                    engaged for chat/agent-loop calls (see @oxagen/ai `cache` option)
aiBatchJobs         id, orgId, provider batch job id, status — AI Gateway batch
                    reconciliation state (ai.batch-reconcile Inngest fn)
```

### Schema: eval.ts (Evals v1 — LLM-as-judge, scoped to metered run traces)
```
evalDatasets        id, orgId, workspaceId, name, description
evalDatasetItems    datasetId, input, expected (JSON)
evalRuns            id, datasetId, orgId, workspaceId, status, judgeModel, results (JSON)
```

### Schema: ingestion.ts
```
sourceConnections   id, orgId, workspaceId, connectorId, config (JSON), status
authCredentials     connectionId, type, encryptedData
oauthTokens         connectionId, accessToken (encrypted), refreshToken, expiresAt
webhookSubscriptions connectionId, webhookId, secret, events
oauthAccounts       connectionId, accountId, accountName
entityTypeMappings  entityTypeId, targetSchema
setupSuggestions    connectionId, suggestions (JSON)
deletionJobs        id, connectionId, status
connectorSchemas    connectorId, schema (JSON)
githubInstallations id, orgId, installationId, accountLogin, accountType — GitHub
                    App installation registry (multi-tenant connect, ADR-027)
```

### Schema: mcp.ts
```
mcpRegistries       id, orgId, workspaceId, url, name
mcpCredentials      registryId, type, encryptedData
mcpServers          id, registryId, name, toolCount, enabled
mcpConsents         id, orgId, workspaceId, userId, tool, granted, expiresAt
mcpCatalogServers   id, name, url, description, tags
mcpToolSnapshots    id, mcpServerId, tools (JSON), capturedAt — retained per
                    mcp.tool-snapshot-retention Inngest fn
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
sandboxTemplates    id, environmentId, provider, runtimeImage, resources (JSON),
                    network posture, isDefault — portable sandbox templates
                    (create/list/get/update/delete/set_default/set_tools/export/import)
sandboxTemplateTools templateId, tool, config (JSON) — preloaded tools per template
```

### Schema: Other
```
-- cms.ts (marketing-site lead gate, unauthenticated /v1/cms surface)
leads               id, email, companySize, referralSource, createdAt
bookEditions        id, slug, title — ebook editions (field-manual/page-flip-reader)
bookAccessCodes     id, editionId, code, status (active|consumed|revoked)

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
  - IAM-governed AgentMemory nodes
  - Semantic edges / ontology
  - Governed canonical repository domain/code-scope projection
  - NOT the exact checkout graph or the authoritative run-evidence ledger
Packages: packages/agent/src/memory/neo4j.ts
```

## Local Memory Store — Engram (packages/engram/)
```
Backends:
  - DuckDB (local episodic store)         engram/src/store/duckdb-adapter.ts

Subsystems:
  retrieval/    → lexical + temporal retrieval and fusion
  consolidation → local dedup, distill, promote primitives
  compiler/     → context window packing
  session/      → session event log, fork, replay (analyzeReplay)
  sync/         → CRDT merge, Merkle sync, protocol
  api/          → remember, pin, relate, assert
```

## Telemetry Store — ClickHouse
```
Purpose: usage/cost metering events, token_usage, error clustering — the
         ClickHouse→Stripe loop that turns observed usage into billing.
Package: packages/telemetry/src/ (migrate.ts runs schema.sql then every
         numbered migrations/*.sql file on each startup — comment-only .sql
         files are valid no-op migrations used to record decisions)
```

## Storage — Vercel Blob
```
BLOB_READ_WRITE_TOKEN (env)
Package: packages/storage/src/
Usage: avatar uploads, generated assets, skill exports, archives
```

## Migrations
```
Location: packages/database/atlas/migrations/
Tool:     Atlas (pnpm migrate in database package)
Count:    55 SQL files tracked (latest: 20260721120000_source_connections_poll_due_partial_idx.sql)
          — count drifts fast; verify via `ls packages/database/atlas/migrations/*.sql | wc -l`
Checksum: atlas.sum — regenerate via `atlas migrate hash --dir "file://atlas/migrations"`
          from packages/database after adding/renaming a migration; never hand-edit.
```

## Encryption
```
Secrets:    AES-256-GCM (env key) OR AWS KMS (AWS_KMS_INGESTION_KEY_ARN)
Package:    packages/crypto/src/
Auth tokens: packages/auth/src/token-encryption.ts
```
