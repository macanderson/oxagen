<!-- Generated: 2026-07-06, corrections applied 2026-07-10, ADR-041 excision pass 2026-09-07 | Files scanned: ~178 (api) + ~224 (handlers), counts drift | Token estimate: ~1000 -->

# Backend Architecture

## Entry Points
```
apps/api/src/index.ts       → Hono server bootstrap (port 4000, from PORTS.api in @oxagen/config)
apps/api/src/app.ts         → Route registration (~178 route files, count drifts)
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
GET  /v1/auth/cli                    → CLI loopback token exchange (PKCE boundary)
POST /v1/telemetry                   → anonymous CLI usage telemetry (rate-limited)
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

**Agent** (ADR-041 removed the sandbox, skills, plans, compose, subagent
fan-out, background-task, and file-lock route groups that used to live here —
along with the standalone A2A JSON-RPC mount, see below)
```
POST   /agent/tools                  → list available tools
POST   /agent/mcp-servers            → register/list MCP server
POST   /agent/mcp-servers/set-enabled|delete
GET    /agent/mcp-consents           → list consent requests
POST   /agent/mcp-consents/resolve
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
GET    /agent/environment/bind|unbind|list  ← agent-to-environment bindings
POST   /agent/roles/assign|revoke    GET /agent/roles/get   GET /agent/roles  (list)
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

**Environments / Secrets** (ADR-041 removed the sandbox-template routes that
used to live here)
```
POST   /environment/create|update|delete|set-default  GET /environment/get|list
POST   /secret/key/upsert|list|delete
POST   /secret/value/set|unset       → only set/unset live under /secret/value/
POST   /secret/reveal|export         GET /secret/import-env
                                      → reveal, import-env, export are directly under /secret/
```

**Other** (ADR-041 removed the content-generation routes — web search/fetch,
research swarm, documents/markdown/mermaid/video/svg/image, forms/fill,
archive/create — that used to live here; there is no first-party content
generation surface left)
```
POST   /command/menu/search|suggest
POST   /reference/search
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
POST   /api-keys (create)  POST /api-keys/revoke  POST /api-keys/rotate
GET    /notifications  POST /notifications/mark
POST   /privacy/export|erase
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
GET  /oauth/github                   → public OAuth callback (see Public / Webhook)
```
ADR-041 removed the `/a2a` JSON-RPC transport and `/.well-known` A2A discovery
mount entirely (2026-09-07) — see `docs/adr/ADR-041-runtime-excision.md` and
`docs/specs/a2a-agent-identity/spec.md`'s 2026-09-07 note.

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
@oxagen/handlers    (packages/handlers/src/*.ts)  — ~224 non-test files, all domain logic
@oxagen/agent       (packages/agent/src/)          — governed turn loop, MCP gateway,
                                                       agent registry handlers (~73 files)
@oxagen/run-ledger  (packages/run-ledger/src/)     — durable run/attempt/event evidence
                                                       ledger (formerly agent-runner)
@oxagen/billing     (packages/billing/src/)        — Stripe, credits, usage
@oxagen/ingestion   (packages/ingestion/src/)      — connectors, parsers
@oxagen/plugins     (packages/plugins/src/)        — catalog, credentials, entitlements
@oxagen/engram      (packages/engram/src/)         — local DuckDB memory + context compiler
@oxagen/iam         (packages/iam/src/)            — authz, audit emit
```

## Background Jobs (Inngest) — 22 functions (count drifts; verify via
`grep -rl "createFunction(" packages/inngest-functions/src/functions`)

ADR-041 removed every agent-runtime job that used to live here: fan-out
collection/dispatch (`agent.aggregate-fanout`, `agent.execute-subagent`),
background-task execution and lease sweeping, the sandbox reaper, video
rendering, playbook/workflow orchestration (`agent.workflow.supervisor`,
`agent.workflow.task.execute`, `playbook-run-execute`,
`playbook-trigger-match`), the LLM-as-judge eval runner (`eval.run.execute`),
AI Gateway batch-job reconciliation, generated-file graph sync, and
`web.search.ingest-graph`.

```
auth.session-expiry-audit             → hourly cron
billing.dunning-sweep                 → failed payment retry
chat.persist-stream                   → save streamed messages
ingestion.connection-poll             ingestion.poll-scheduler
ingestion.delete                      → delete a connection
ingestion.github-initial-sync
ingestion.oauth-refresh
ingestion.pipeline                    → document ingestion
ingestion.sync-requested
ingestion.webhook-provision           ingestion.webhook-renew
mcp.tool-snapshot-retention
memory.decay-pass                     → salience decay
observability.capture-failure
plugin.catalog-sync                   → plugin registry refresh
plugin.oauth-refresh-watcher
privacy.erasure.execute               → GDPR erase
privacy.export.process                → GDPR export
schema.reconcile                      → schema version reconcile
security.audit-partition-rollover
stripe.sync-invoice
stripe.sync-subscription
```
Note: `ingestion.feature-inference.ts` is shared building-block code imported by
several jobs above, not its own registered function — don't count it separately.
The Inngest client id itself (`oxagen-runner`, in `inngest.ts`) is not a job either.
