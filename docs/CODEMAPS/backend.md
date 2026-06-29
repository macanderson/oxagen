<!-- Generated: 2025-07-10 | Files scanned: 256 (api) + 398 (handlers) | Token estimate: ~950 -->

# Backend Architecture

## Entry Points
```
apps/api/src/index.ts       → Hono server bootstrap (port 3001)
apps/api/src/app.ts         → Route registration (all 150+ routes)
apps/api/src/bootstrap.ts   → DB connection, Inngest client init
```

## Middleware Chain
```
ALL /*
  requestLogger       (apps/api/src/middleware/logger.ts)
  corsMiddleware       (apps/api/src/middleware/cors.ts)
  onError → errorMiddleware

/v1/:org_slug/:workspace_slug/*  (orgScoped group)
  authMiddleware       (Bearer API-key OR session cookie → @oxagen/auth)
  orgMiddleware        (slug → orgId lookup → @oxagen/database)
  workspaceMiddleware  (slug → workspaceId lookup)
```

## Route Groups

### Public / Webhook
```
GET  /health                         → health check
POST /webhooks/stripe                → Stripe events → @oxagen/billing/webhooks
POST /webhooks/github/app            → GitHub App events → @oxagen/github
POST /webhooks                       → Generic connector webhooks
POST /api/inngest                    → Inngest event receiver
GET  /v1/auth/cli                    → CLI loopback token exchange
GET  /oauth/github                   → GitHub OAuth callback (HMAC-verified)
```

### User-Scoped (/v1)
```
GET  /v1/auth/whoami                 → session identity
GET  /v1/orgs                        → org list
POST /v1/orgs                        → org create
GET  /v1/user/preferences            → user prefs
PUT  /v1/user/preferences            → update prefs
```

### Org+Workspace-Scoped (/v1/:org/:ws)

**Chat / Conversations**
```
POST   /chat/messages                → send message → @oxagen/agent runtime
POST   /chat/messages/execution      → record execution
GET    /chat/stream                  → SSE stream
GET    /conversations                → list / file list
POST   /conversations/rename|archive|delete|purge
POST   /conversation/chat            → conversationChatRoute
```

**Agent**
```
POST   /agent/code/execute           → @oxagen/sandbox code exec
POST   /agent/sandbox/start|exec|snapshot|stop
POST   /agent/tools                  → list available tools
POST   /agent/mcp-servers            → register/list MCP server
POST   /agent/mcp-servers/set-enabled|delete
GET    /agent/mcp-consents           → list consent requests
POST   /agent/mcp-consents/resolve
GET    /agent/skills                 → list skills
POST   /agent/skills/load
POST   /agent/plan/create|approve
POST   /agent/compose                → agent.compose (multi-step)
POST   /agent/subagent/dispatch      → fan-out to Inngest
POST   /agent/subagent/cancel|aggregate
GET    /agent/subagent/fanout        → fanout list/get
GET    /agent/subagent/logs
POST   /agent/task/background/start|cancel
GET    /agent/task/background        → read status
POST   /agent/approval/resolve
POST   /agent/execution/record
POST   /agent/feature/verify
POST   /agent/memory/recall|write|remember|update|delete
GET    /agent/memory                 → list memories
GET|PUT /agent/memory/policy
POST   /agent/trigger/create|delete
GET    /agent/llm/chat/completions   → OpenAI-compat proxy (separate scope)
```

**Agent Definitions**
```
POST   /agent/definition/create|update|publish
GET    /agent/definition|/agent/definition/:id
POST   /agent/deploy
```

**Browser / Code**
```
POST   /browser/navigate|screenshot|fill|submit|click|refresh|read
POST   /code/diff|patch|format|map
```

**Knowledge / Graph**
```
POST   /graph/node/upsert|get|delete|search
GET    /graph/nodes
POST   /graph/edge/upsert|delete
POST   /graph/relationship/upsert
POST   /graph/search|cypher|ingest|sync/push|export
GET    /graph/stats
POST   /semantic-edges|/semantic-relationships (+ approve/infer/suggest/list)
POST   /ontology/query|neighbors
POST   /schema (+ setup/toggle/validate/version/reconcile)
```

**Ingestion / Connections**
```
GET|POST /connections                → connector CRUD
GET      /connections/github         → GitHub OAuth
GET|POST /repos                      → repository list/ops
GET|POST /integrations               → integration list/install/delete
POST     /integrations/metrics
```

**Skills**
```
POST   /skill/create|edit|enable|export|author
GET    /skill/workspace/list
POST   /skill/workspace/install
GET    /skill/version/list|get
POST   /skill/version/upload|activate
GET    /skill/metrics/read
```

**Billing**
```
GET    /billing/subscription         → read plan
POST   /billing/subscription/upgrade → start upgrade
POST   /billing/credits/purchase
```

**Plugins**
```
GET|POST /plugin/org/list|install|uninstall|set-enabled|install-bulk
POST     /plugin/catalog/sync
POST     /plugin/credential/set-secret|reauth
POST     /plugin/settings/auth-alerts
POST     /plugin/workspace/set-enabled
GET|POST /plugin-schema|/plugin-versions
```

**Environments / Secrets**
```
POST   /environment/create|update|delete|set-default
POST   /secret/key/upsert|list|delete
POST   /secret/value/set|unset|reveal|import-env|export
```

**Other**
```
POST   /web/search|fetch
POST   /research/swarm/start|status
POST   /generate/documents|pdf|markdown|mermaid|video|svg|image
POST   /image/create|analyze  GET /image/list
POST   /document/create|read  GET /document/list
POST   /form/fill
POST   /command/menu/search|suggest
POST   /archive/create
POST   /asset/upload
POST   /audit/log/query
POST   /prompt/settings/read|write
POST   /workspace/model/settings/read|write
POST   /workspace/settings/read|write
GET    /workspace/member/list
POST   /workspace/invite/send
POST   /automation/list|create|update|enable|disable|trigger
POST   /api-keys (create|revoke|rotate)
GET    /notifications  POST /notifications/mark
POST   /privacy/export|erase
POST   /workflows
```

## Handler Pattern
```
Route file (apps/api/src/routes/v1/*.ts)
  → validates via @oxagen/oxagen contract (Zod)
  → calls handler in @oxagen/handlers or @oxagen/agent
  → handler uses @oxagen/database (Drizzle) + external services
  → returns typed response
```

## Key Handler Packages
```
@oxagen/handlers    (packages/handlers/src/*.ts)  — 398 files, all domain logic
@oxagen/agent       (packages/agent/src/)          — agent runtime, memory, dispatch
@oxagen/billing     (packages/billing/src/)        — Stripe, credits, usage
@oxagen/ingestion   (packages/ingestion/src/)      — connectors, parsers
@oxagen/plugins     (packages/plugins/src/)        — catalog, credentials, entitlements
@oxagen/engram      (packages/engram/src/)         — memory store/retrieve/embed
@oxagen/iam         (packages/iam/src/)            — authz, audit emit
```

## Background Jobs (Inngest)
```
agent.execute-subagent          → fan-out subagent execution
agent.aggregate-fanout          → collect subagent results
agent.background-task.execute   → long-running task runner
agent.workflow.supervisor       → playbook orchestration
agent.workflow.task.execute     → individual playbook step
agent.sync-execution-to-graph   → write lineage to Neo4j
agent.video-render
billing.dunning-sweep           → failed payment retry
billing.rollup-usage            → usage aggregation
chat.persist-stream             → save streamed messages
engram.consolidation.run        → memory dedup/distill
engram.embed-memory             → vector embedding
engram.sync-memory-to-graph     → Neo4j memory nodes
ingestion.pipeline              → document ingestion
ingestion.github-*              → GitHub sync (5 functions)
ingestion.semantic-edge-infer   → AI edge inference
memory.decay-pass               → salience decay
playbook.run.execute            → playbook run
playbook.trigger.match          → event → playbook match
plugin.catalog-sync             → plugin registry refresh
privacy.erasure.execute         → GDPR erase
privacy.export.process          → GDPR export
schema.reconcile                → schema version reconcile
security.audit-partition-rollover
stripe.sync-invoice|subscription
web.search.ingest-graph
```
