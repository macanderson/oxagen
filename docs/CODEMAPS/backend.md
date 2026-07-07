<!-- Generated: 2026-07-06 | Files scanned: 261 (api) + 245 (handlers) | Token estimate: ~1000 -->

# Backend Architecture

## Entry Points
```
apps/api/src/index.ts       → Hono server bootstrap (port 3001)
apps/api/src/app.ts         → Route registration (238 route files, 247 .route() calls)
apps/api/src/bootstrap.ts   → DB connection, Inngest client init
```

## Middleware Chain
```
ALL /*
  requestLogger       (apps/api/src/middleware/logger.ts)
  corsMiddleware       (apps/api/src/middleware/cors.ts)
  onError → errorMiddleware
  rate-limit           (apps/api/src/middleware/rate-limit.ts)

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
POST   /conversations/rename|archive|delete|purge|export
POST   /conversation/chat            → conversationChatRoute
POST   /conversation/attachment/add
```

**A2A (Agent2Agent) — external agent interop**
```
GET  /a2a/card                       → agent card (capabilities) — a2a.card.get.ts
POST /a2a                            → JSON-RPC: message/send, tasks/get,
                                        tasks/resubscribe (SSE resubscribe to a
                                        live task), tasks/cancel
                                      → apps/api/src/routes/a2a/{rpc,bridge,
                                        protocol,stream-registry,task-store,
                                        well-known,base-url}.ts
                                      → message.metadata.skillId selects a
                                        deployed agent slug (unknown/inactive
                                        slug falls back to the generic agent)
                                      → runs land in agent.trace.get lineage
                                        the same as subagent fan-out
```

**Agent**
```
POST   /agent/code/execute           → @oxagen/sandbox code exec
POST   /agent/sandbox/start|exec|snapshot|stop
GET    /agent/sandbox_file/list      GET /agent/sandbox_file/read
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
GET    /agent/subagent/logs|siblings|result
POST   /agent/task/background/start|cancel
GET    /agent/task/background        → read status
POST   /agent/approval/resolve
POST   /agent/execution/record       GET /agent/execution/list
GET    /agent/execution/lineage      GET /agent/trace/:executionId
POST   /agent/feature/verify
POST   /agent/memory/recall|write|remember|update|delete|cite|promote
GET    /agent/memory                 → list memories
GET    /agent/memory_citation/list   GET /agent/memory_promotion/list
POST   /agent/memory_evidence/attach
POST   /agent/memory_import/parse|commit
GET|PUT /agent/memory_policy         → read/write
POST   /agent/trigger/create|delete  GET|PUT /agent/trigger/list|update
POST   /agent/file_lock/acquire|release  GET /agent/file_lock/list
GET    /agent/llm/chat/completions   → OpenAI-compat proxy (separate scope)
GET    /agent/debug/trace            → dev-only trace introspection
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

**Evals** (LLM-as-judge, scoped to metered run traces — not a standalone eval platform)
```
POST   /eval/dataset/create          GET /eval/dataset/list|get
POST   /eval/dataset/from_traces     → build dataset from already-metered runs
POST   /eval/dataset_item/add
POST   /eval/run/start               GET /eval/run/get|status
```

**Budget / Cost Governance**
```
GET|PUT /budget/policy               → org-level budget policy
GET|PUT /workspace/budget_policy     → per-workspace budget policy
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
GET    /billing/usage/breakdown
POST   /billing/subscription/upgrade → start upgrade
POST   /billing/credits/purchase
```

**Plugins**
```
GET|POST /plugin/org/list|install|uninstall|set-enabled|install-bulk
GET      /plugin/catalog/browse|get
POST     /plugin/catalog/sync
POST     /plugin/credential/set-secret|reauth
POST     /plugin/settings/auth-alerts
POST     /plugin/workspace/set-enabled
GET|POST /plugin-schema|/plugin/registry (add/list/remove)
```

**Environments / Secrets**
```
POST   /environment/create|update|delete|set-default  GET /environment/get|list
POST   /secret/key/upsert|list|delete
POST   /secret/value/set|unset|reveal|import-env|export
```

**Other**
```
POST   /web/search|fetch
POST   /research/swarm/start|status
POST   /generate/documents|pdf|markdown|mermaid|video|svg|image
POST   /image/create|analyze|generate  GET /image/list
POST   /document/create|read|generate|pdf/create  GET /document/list
POST   /form/fill
POST   /command/menu/search|suggest
POST   /archive/create
POST   /asset/upload
POST   /audit/log/query
POST   /prompt/settings/read|write
POST   /workspace/model_settings/read|write
POST   /workspace/settings/read|write
GET    /workspace/member/list
POST   /workspace/invite/send
POST   /org/member/add|remove  POST /org/member_role/change
POST   /org/member_invite/accept|decline
GET|PUT /org/settings
POST   /automation/list|create|update|enable|disable|trigger
POST   /api-keys (create|revoke|rotate)
GET    /notifications  POST /notifications/mark
POST   /privacy/export|erase
POST   /workflows
GET    /telemetry/error/cluster  GET /telemetry/usage
GET    /system/install/instructions
```

## Handler Pattern
```
Route file (apps/api/src/routes/v1/*.ts)
  → validates via @oxagen/oxagen contract (Zod)
  → invoke(contractName, input, ctx, { surface }) → capability kernel
  → calls handler in @oxagen/handlers or @oxagen/agent
  → handler uses @oxagen/database (Drizzle) + external services
  → returns typed response
```

## Key Handler Packages
```
@oxagen/handlers    (packages/handlers/src/*.ts)  — 245 files, all domain logic
@oxagen/agent       (packages/agent/src/)          — agent runtime, memory, dispatch (111 files)
@oxagen/agent-engine (packages/agent-engine/src/)  — pipeline, planner, fork, oracle,
                                                       evaluate, fleet, tools-structured (39 files)
@oxagen/billing     (packages/billing/src/)        — Stripe, credits, usage
@oxagen/ingestion   (packages/ingestion/src/)      — connectors, parsers
@oxagen/plugins     (packages/plugins/src/)        — catalog, credentials, entitlements
@oxagen/engram      (packages/engram/src/)         — memory store/retrieve/embed
@oxagen/iam         (packages/iam/src/)            — authz, audit emit
```

## Background Jobs (Inngest) — 49 functions
```
agent.aggregate-fanout                → collect subagent results
agent.background-task.execute         → long-running task runner
agent.execute-subagent                → fan-out subagent execution
agent.lease-sweep                     → reclaim stale agent leases
agent.project-file-lock-to-graph      → sync file locks to Neo4j
agent.sync-execution-to-graph         → write lineage to Neo4j (incl. A2A runs)
agent.video-render
agent.workflow.supervisor             → playbook orchestration
agent.workflow.task.execute           → individual playbook step
ai.batch-reconcile                    → reconcile AI Gateway batch jobs
auth.session-expiry-audit
billing.dunning-sweep                 → failed payment retry
billing.rollup-usage                  → usage aggregation
chat.persist-stream                   → save streamed messages
content.sync-generated-file-to-graph
engram.consolidation.impl / .run      → memory dedup/distill
engram.embed-memory                   → vector embedding
engram.sync-memory-to-graph           → Neo4j memory nodes
eval.run.execute                      → LLM-as-judge eval run
ingestion.connection-poll             → ingestion.poll-scheduler
ingestion.delete
ingestion.feature-inference
ingestion.github-commit-files / -infer-domains / -infer-features(-batch) /
  -initial-sync / -parse-file         → GitHub sync pipeline (7 functions)
ingestion.oauth-refresh
ingestion.pipeline                    → document ingestion
ingestion.semantic-edge-infer         → AI edge inference
ingestion.sync-requested
mcp.tool-snapshot-retention
memory.decay-pass                     → salience decay
observability.capture-failure
playbook.run.execute                  → playbook run
playbook.trigger.match                → event → playbook match
plugin.catalog-sync                   → plugin registry refresh
plugin.oauth-refresh-watcher
privacy.erasure.execute               → GDPR erase
privacy.export.process                → GDPR export
schema.reconcile                      → schema version reconcile
security.audit-partition-rollover
stripe.sync-invoice|subscription
web.search.ingest-graph
```
