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

ADR-043 (runtime excision, 2026-09-07) dropped `skills`, `skillVersions`,
`backgroundTasks`, `subagentFanouts`, `subagentRuns`, `sandboxSessions`,
`agentPlans`, `fileLocks`, `fileLockFences`, `agentRunCheckpoints`, and
`agentRunAttemptLeases`. `a2aTasks` is slated to be dropped along with the
removed A2A transport (see `docs/adr/ADR-043-runtime-excision.md` and
`docs/specs/a2a-agent-identity/spec.md`). What remains (18 tables):

```
agents                          id, orgId, slug, name, agentType, activeVersionId,
                                 status (draft/active/archived), deploymentStatus
agentVersions                   agentId, version, config (JSON), publishedAt
approvalRequests                id, agentId, taskId, type, payload, status, resolvedAt
agentExecutions                 id, agentId, conversationId, status, startedAt, endedAt
agentExecutionSteps             executionId, stepIndex, type, input, output, durationMs
agentToolCalls                  executionId, stepId, tool, input, output, durationMs
a2aTasks                        id, orgId, workspaceId, publicId, skillId, status — being
                                 dropped with the removed A2A transport
agentRuns                       id, orgId, surface, status, spec (JSON), claimedBy,
                                 leaseExpiresAt — the run-ledger evidence root
agentRunEvents                  runId, sequence, type, payload (JSON) — append-only
agentRunAttempts                runId, attemptNumber, status
agentRunAttemptSeals            attemptId, sealedAt, digest — tamper-evidence seal
agentRunFinalizationGrants      runId, grantedAt, grantedBy
agentRunFinalizationObligations runId, obligation, satisfiedAt
tools                           id, orgId, workspaceId, name, activeVersionId
toolVersions                    toolId, version, manifest (JSON), publishedAt
contextRecords                  id, orgId, slug, title, status (active/retired/superseded),
                                 activeVersionId
contextRecordVersions           recordId, version, body, checksum
contextPromotions               recordId, action, chainDigest — hash-chained ledger
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

`aiBatchJobs` was dropped under ADR-043 (AI Gateway batch reconciliation left
with the runtime).

```
aiResponseCache     id, orgId, cacheKey, promptHash, model, surface, responseKind,
                    response (JSON), usage (JSON), embedding (JSON, semantic layer) —
                    layered deterministic-call cache; OPT-IN per call site, NEVER
                    engaged for chat/agent-loop calls (see @oxagen/ai `cache` option)
```

`eval.ts` (Evals v1: `evalDatasets`, `evalDatasetItems`, `evalRuns`) was
dropped entirely under ADR-043 — there is no standalone eval platform.

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

`workflow.ts` (playbooks: definitions/steps/edges/triggers/runs/approvals) was
dropped entirely under ADR-043 — the automation/workflow surface no longer
exists.

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

`sandboxTemplates` and `sandboxTemplateTools` were dropped under ADR-043.

```
environments        id, orgId, workspaceId, name, isDefault
secretKeys          id, environmentId, name, description
secretValues        keyId, environmentId, encryptedValue
secretAccessLog     keyId, userId, accessedAt, action
agentEnvironmentBindings agentId, environmentId, isPrimary — governance metadata:
                    which secret scope an agent identity may resolve
```

### Schema: Other

`cms.ts` (`leads`, `bookEditions`, `bookAccessCodes` — the marketing-site lead
gate and ebook access system) was dropped entirely. `content.ts`'s
`documents` table (the in-app generation path) was dropped under ADR-043;
`generatedAssets` survives, narrowed to the upload/attachment path.

```
-- content.ts
generatedAssets     id, orgId, workspaceId, userId, kind, source (user_upload|generated),
                    accessPolicy, storageProvider/Key/Url, mimeType — blob reference
                    for chat/agent attachments (asset.upload, conversation.attachment.add);
                    'generated' source rows are preserved history from the retired
                    in-app generation path, no longer written

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
Usage: avatar uploads, chat/agent attachment uploads
```

## Migrations
```
Location: packages/database/atlas/migrations/
Tool:     Atlas (pnpm migrate in database package)
Count:    ~90 SQL files tracked (latest: 20260907140000_data_plane_security_event.sql;
          includes 20260907120000_drop_agent_runtime_tables.sql — the ADR-043 cut)
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
