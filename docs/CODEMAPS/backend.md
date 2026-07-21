<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 261 (api) + 270 (handlers) | Token estimate: ~1000 -->

# Backend Architecture

## Entry Points
```
apps/api/src/index.ts       → Hono server bootstrap (port 4000, from PORTS.api in @oxagen/config)
apps/api/src/app.ts         → Route registration (271 route files; 261 under routes/v1)
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

All paths verified line-by-line against `apps/api/src/app.ts` (2026-07-10).

### Public / Webhook (no org/workspace scope; several bypass auth entirely)
```
GET  /health                         → health check
POST /webhooks/stripe                → Stripe events → @oxagen/billing/webhooks
POST /webhooks/github/app            → GitHub App events → @oxagen/github
POST /webhooks                       → Generic connector webhooks (HMAC boundary)
POST /api/inngest                    → Inngest event receiver
GET  /.well-known                    → A2A protocol discovery card (public/optional-auth)
GET  /v1/auth/cli                    → CLI loopback token exchange (PKCE boundary)
POST /v1/telemetry                   → anonymous CLI usage telemetry (rate-limited)
POST /v1/cms                         → anonymous marketing-site lead gate (rate-limited)
GET  /oauth/github                   → GitHub OAuth callback (HMAC-verified)
```

### User-Scoped (/v1) — auth required, no org/workspace scope
```
GET  /v1/auth/whoami                 → session identity (works for API-key too)
POST /v1/organizations               → org create
GET  /v1/user/organizations          → org list
GET  /v1/user/workspaces             → workspace list (pre-org CLI linker)
GET  /v1/user/preferences/read       → user prefs
POST /v1/user/preferences/write      → update prefs
GET  /v1/user/budget/read            → per-user turn budget (default)
POST /v1/user/budget/write           → update per-user turn budget
```

### Org+Workspace-Scoped (/v1/:org_slug/:workspace_slug)

**Chat / Conversations**
```
POST   /chat/messages                → send message → @oxagen/agent runtime (CLI/MCP/API-key path)
POST   /chat/messages/execution      → record execution
GET    /chat/stream                  → SSE stream (same CLI/MCP/API-key path; the app UI's own
                                        chat instead calls POST /api/v1/chat/stream in-process —
                                        see architecture.md Data Flow)
GET    /conversations                → list (also serves /:id/files and /:id/export at the
                                        same prefix — Hono dispatches by method+full path)
POST   /conversations/rename|archive|delete|purge
POST   /conversations/attachments    → link an already-uploaded asset to a conversation
POST   /conversation/chat            → conversationChatRoute
```

**A2A (Agent2Agent) — external agent interop**
```
GET  /a2a/card                       → governed Agent Card read (metered, IAM-gated;
                                        org+workspace scoped) — a2a.card.get.ts
```
The A2A *transport* itself is NOT org/workspace-scoped — see the two standalone
mounts below (`/a2a` JSON-RPC, `/.well-known` discovery).

**Agent**
```
POST   /agent/code/execute           → @oxagen/sandbox code exec
POST   /agent/sandbox/start|exec|snapshot|stop
GET    /agent/sandbox/list           → durable sandbox session list (read-only)
GET    /agent/sandbox/files          GET /agent/sandbox/file    (list vs single-file read)
GET    /agent/sandbox/logs           → captured stdout/stderr for a session
POST   /agent/tools                  → list available tools
POST   /agent/mcp-servers            → register/list MCP server
POST   /agent/mcp-servers/set-enabled|delete
GET    /agent/mcp-consents           → list consent requests
POST   /agent/mcp-consents/resolve
GET    /agent/skills                 → list skills
POST   /agent/skills/load
POST   /agent/plans                  POST /agent/plans/approve
POST   /agent/compose                → run_capability_chain (multi-step)
POST   /agent/subagent/dispatch      → fan-out to Inngest
POST   /agent/subagent/cancel|aggregate
GET    /agent/subagent/fanouts       → list fan-outs
GET    /agent/subagent/fanout        → get one fan-out + child runs
GET    /agent/subagent/logs|siblings|result
POST   /agent/tasks                  GET /agent/tasks           (start vs read background task)
POST   /agent/tasks/cancel
POST   /agent/memory/recall|remember|update|delete|cite|promote
GET    /agent/memory/list            → list memories
POST   /agent/memory                 → write memory (bare POST; NOT a list — mounted after
                                        the more specific /agent/memory/* paths above)
GET    /agent/memory/citations/list  POST /agent/memory/evidence/attach
GET    /agent/memory/promotion/candidates
POST   /agent/memory/import/parse|commit
GET|POST /agent/memory/policy        → read/write memory policy
POST   /agent/approvals/resolve
POST   /agent/execution/record       GET /agent/executions        (list, plural)
GET    /agent/trace                  → get_execution_trace span tree
GET    /agent/debug/trace            → dev-only trace introspection
POST   /agent/file/lock/acquire|release  GET /agent/file/lock/list
GET    /agent/environment/bind|unbind|list  ← agent-to-environment bindings (new, ADR-025-era)
```
`POST /v1/agent/llm/chat/completions` (OpenAI-compat proxy) is OUTSIDE this
group — see "Standalone Top-Level Mounts" below.

**Agent Definitions**
```
POST   /agent/definitions/update|publish|suggest|revise|summarize
POST   /agent/definitions            → create   GET /agent/definitions   (list, then get-by-id)
POST   /agent/deploy
```
`revise` (`agent.definition.revise.ts`, capability `revise_agent_def`) is a
new addition since the last audit — no longer just create/update/publish/get/list/suggest.

**Browser / Code**
```
POST   /browser/navigate|screenshot|fill|submit|click|refresh|read
POST   /code/diff|patch|format|map
```

**Evals** (LLM-as-judge, scoped to metered run traces — not a standalone eval platform)
```
POST   /eval/datasets/from-traces    → build dataset from already-metered runs (hyphenated)
GET    /eval/datasets/get
POST   /eval/datasets/items          → add a dataset item
POST   /eval/datasets                → create   GET /eval/datasets   (list)
GET    /eval/runs/status             GET /eval/runs/get
POST   /eval/runs                    → start a run
```

**Budget / Cost Governance**
```
GET    /v1/user/budget/read          POST /v1/user/budget/write
                                      → PER-USER turn budget default (userScoped group above)
GET    /workspace/budget-policy      POST /workspace/budget-policy
                                      → per-workspace budget policy (hyphenated path)
```

**Knowledge / Graph**
```
POST   /graph/node/upsert|get|delete|search
GET    /graph/nodes
POST   /graph/edge/upsert|delete
POST   /graph/relationship/upsert    → canonical (graph/edge/upsert stays as an alias)
POST   /graph/search|cypher|ingest|export
GET    /graph/stats
POST   /semantic-edges               → canonical semantic.edge.* routes (approve/infer/suggest/list)
POST   /semantic-relationships       → canonical semantic.relationship.* routes
POST   /ontology/query               POST /ontology/neighbors
POST   /schema (+ setup/toggle/validate/version/reconcile — see check_manifest false-positive note)
```

**Ingestion / Connections**
```
GET|POST /connections                → connector CRUD
GET      /connections/github         → GitHub OAuth
GET|POST /repos                      → repository list/ops
GET|POST /integrations               → integration list/install/delete
```

**Skills**
```
POST   /skill/create|edit|enable|export|author|draft|revise
GET    /skill/workspace/list
POST   /skill/workspace/install
GET    /skill/version/list|get
POST   /skill/version/upload|activate
GET    /skill/metrics/read
```
`draft` and `revise` (capability `revise_skill`, `skill.revise.ts`) are new
additions since the last audit.

**Billing**
```
GET    /billing/subscription         → read plan
GET    /billing/usage/breakdown
POST   /billing/subscription/upgrade/start
POST   /billing/credits/purchase
```

**Plugins**
```
GET|POST /plugin/org/list|install|uninstall|install-bulk
POST     /plugin/set-enabled         → single top-level route (set_plugin_enabled(scope));
                                        ADR-025 merged the old org/workspace pair into this one
GET      /plugin/catalog/browse|get
POST     /plugin/catalog/sync
POST     /plugin/credential/set-secret|reauth
POST     /plugin/settings/auth-alerts
GET|POST /plugin-schema              GET|POST /plugin-versions
GET|POST /plugin/registries          → CRUD (plural; add/remove sub-paths)
```

**Environments / Secrets / Sandbox Templates**
```
POST   /environment/create|update|delete|set-default  GET /environment/get|list
POST   /sandbox/template/create|update|delete|set-default|set-tools|export|import
GET    /sandbox/template/list|get
POST   /secret/key/upsert|list|delete
POST   /secret/value/set|unset       → only set/unset live under /secret/value/
POST   /secret/reveal|export         GET /secret/import-env
                                      → reveal, import-env, export are directly under /secret/
```

**Other**
```
POST   /web/search|fetch
POST   /research/swarm/start|status
POST   /documents/generate           POST /documents/pdf     (no /generate/ prefix family)
POST   /markdown/generate            POST /mermaid/generate
POST   /video/generate               POST /svg/generate     POST /image/generate
POST   /image/create|analyze         GET /image/list
POST   /document/create|read         GET /document/list
POST   /forms/fill                   → note plural "forms"
POST   /command/menu/search|suggest
POST   /reference/search
POST   /archive/create
POST   /asset/upload
POST   /audit/log/query
POST   /workspace/prompt-settings    → read + write (was /prompt/settings/*)
POST   /workspace/model-settings     → read + write (hyphenated; was /workspace/model_settings/*)
POST   /workspace/settings           → read + write
POST   /user/workspace-preferences   → read + write; NEW get/update_workspace_user_preferences
                                        capabilities (org+workspace scoped, per user)
GET    /workspace/member/list
POST   /workspace/invite/send
POST   /org/members                  POST /org/members/remove   POST /org/members/role
POST   /org/invitations/accept|decline
GET|POST /org/settings
POST   /automation/list|create|update|enable|disable|trigger
POST   /api-keys (create)  POST /api-keys/revoke  POST /api-keys/rotate
GET    /notifications  POST /notifications/mark
POST   /privacy/export|erase
POST   /workflows
GET    /telemetry/error/cluster      → fleet-wide error-cluster triage (org+workspace scoped)
GET    /system/install-instructions  → one hyphenated segment (was /system/install/instructions)
```
Note: `GET /v1/telemetry` (raw CLI usage events) is a separate, PUBLIC, top-level
mount (see "Public / Webhook" above) — distinct from the org-scoped
`/telemetry/error/cluster` above. The two are easy to conflate; they are
different routes with different auth.

### Standalone Top-Level Mounts (outside the /:org_slug/:workspace_slug group)
```
POST /v1/agent/llm/chat/completions  → OpenAI-compat proxy; the platform API key
                                        carries org+workspace scope so this transport
                                        sits outside the org/workspace path group
POST /a2a                            → A2A JSON-RPC transport (message/send, tasks/get,
                                        tasks/resubscribe, tasks/cancel); same auth-only
                                        scoping rationale as the LLM proxy above
                                      → apps/api/src/routes/a2a/{rpc,bridge,protocol,
                                        stream-registry,task-store,well-known,base-url}.ts
                                      → message.metadata.skillId selects a deployed agent
                                        slug (unknown/inactive falls back to the generic agent)
                                      → runs land in the same execution + trace pipeline
                                        (get_execution_trace) as subagent fan-out
GET  /oauth/github                   → public OAuth callback (see Public / Webhook)
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
@oxagen/handlers    (packages/handlers/src/*.ts)  — 270 non-test files, all domain logic
@oxagen/agent       (packages/agent/src/)          — agent runtime, memory, dispatch (120 files)
@oxagen/agent-engine (packages/agent-engine/src/)  — pipeline, planner, fork, oracle,
                                                       evaluate, fleet, tools-structured (43 files)
@oxagen/billing     (packages/billing/src/)        — Stripe, credits, usage
@oxagen/ingestion   (packages/ingestion/src/)      — connectors, parsers
@oxagen/plugins     (packages/plugins/src/)        — catalog, credentials, entitlements
@oxagen/engram      (packages/engram/src/)         — local DuckDB memory + context compiler
@oxagen/iam         (packages/iam/src/)            — authz, audit emit
```

## Background Jobs (Inngest) — 47 functions (count drifts; verify via
`grep -rl "createFunction(" packages/inngest-functions/src/functions`)
```
agent.aggregate-fanout                → collect subagent results
agent.background-task.execute         → long-running task runner
agent.execute-subagent                → fan-out subagent execution
agent.lease-sweep                     → reclaim stale agent leases
agent.sandbox-reaper                  → reap orphaned/expired durable sandbox sessions (new)
agent.video-render
agent.workflow.supervisor             → playbook orchestration
agent.workflow.task.execute           → individual playbook step
ai-batch-reconcile                    → reconcile AI Gateway batch jobs
auth/session-expiry-audit             → hourly cron; literal id contains a slash
billing.dunning-sweep                 → failed payment retry
billing.rollup-usage                  → usage aggregation
chat.persist-stream                   → save streamed messages
content.sync-generated-file-to-graph
eval.run.execute                      → LLM-as-judge eval run
ingestion-connection-poll             → ingestion-poll-scheduler
ingestion-delete-connection
ingestion-github-commit-files / -infer-domains / -infer-features(-batch) /
  -initial-sync / -parse-file         → GitHub sync pipeline (7 functions)
ingestion-oauth-refresh
ingestion-pipeline                    → document ingestion
ingestion-semantic-edge-infer         → AI edge inference
ingestion-sync-requested
mcp.tool-snapshot-retention
memory.decay-pass                     → salience decay
observability.capture-failure
playbook-run-execute                  → playbook run
playbook-trigger-match                → event → playbook match
plugin.catalog-sync                   → plugin registry refresh
plugin.oauth-refresh-watcher
privacy.erasure-execute               → GDPR erase
privacy.export-process                → GDPR export
schema-reconcile                      → schema version reconcile
security.audit-partition-rollover
stripe.sync-invoice|subscription
web.search.ingest-graph
```
Note: `ingestion.feature-inference.ts` is shared building-block code imported by
several jobs above, not its own registered function — don't count it separately.
The Inngest client id itself (`oxagen-runner`, in `inngest.ts`) is not a job either.
