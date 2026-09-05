<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 3,092 (ts/tsx, non-test) | Token estimate: ~800 -->

# Architecture — Oxagen v2

## Project Type
**Monorepo** (pnpm workspaces + Turborepo) — 7 apps, 34 packages, 2 tooling packages. See `docs/VISION.md` for product north star: the metered, governed, graph-grounded control plane ("Stripe for agents").

## System Diagram

```
                        ┌───────────────────────────────────────┐
                        │                Clients                  │
                        │  Browser │ CLI │ MCP Client │ A2A Caller │
                        └─────┬────┴──┬──┴─────┬──────┴─────┬─────┘
                              │       │         │            │
                    ┌─────────▼──┐ ┌──▼─────┐ ┌─▼─────────┐  │
                    │  apps/app  │ │apps/cli│ │ apps/mcp  │  │
                    │ Next.js 16 │ │  Ink   │ │  xmcp     │  │
                    │  (RSC+SA)  │ │  REPL  │ │ /mcp SSE  │  │
                    └─────┬──────┘ └───┬────┘ └──┬────────┘  │
                          │            │           │          │
                          └────────────┼───────────┴──────────┘
                                       │  REST + SSE + JSON-RPC (A2A)
                              ┌────────▼────────────┐
                              │      apps/api        │
                              │   Hono on Node.js    │
                              │   api.oxagen.sh       │
                              │  (271 route files —   │
                              │   261 under routes/v1;│
                              │   /a2a JSON-RPC + SSE)│
                              └──┬────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
    ┌─────────▼──────┐  ┌────────▼──────┐  ┌───────▼────────┐
    │  PostgreSQL     │  │   Neo4j       │  │   Inngest      │
    │  (Neon/local)   │  │  Knowledge    │  │  Background    │
    │  Drizzle ORM    │  │   Graph       │  │ Jobs (~48 fns, │
    │                 │  │               │  │  count drifts) │
    └─────────┬───────┘  └───────────────┘  └────────────────┘
              │
    ┌─────────▼──────────────────────────────────────┐
    │              External Services                  │
    │  Stripe · Vercel Blob · GitHub App · AI Gateway │
    │  ClickHouse (telemetry) · DuckDB (local Engram)  │
    └─────────────────────────────────────────────────┘
```

## Service Boundaries

| Service | URL | Stack | Role |
|---------|-----|-------|------|
| `apps/api` | api.oxagen.sh | Hono + Node.js | REST API, webhooks, LLM proxy, A2A JSON-RPC |
| `apps/app` | app.oxagen.sh | Next.js 16 (App Router) | Web UI, Server Actions |
| `apps/mcp` | mcp.oxagen.sh/mcp | xmcp (streamable HTTP) | MCP protocol surface |
| `apps/cli` | npm: `oxagen` | Ink + Commander | Local agent REPL + fleet orchestration |
| `apps/docs` | docs.oxagen.sh | Fumadocs (Next.js) | Documentation site |
| `apps/web` | oxagen.sh | Static | Public site / investor deck (interim) |
| `apps/schemas` | schemas.oxagen.sh | Static host | Generated JSON Schemas (editor autocompletion) |

## Data Flow — Chat / Agent Execution

```
User → apps/app chat UI → POST /api/v1/chat/stream
     (Next.js Route Handler, apps/app/src/app/api/v1/chat/stream/route.ts)
     → calls @oxagen/agent-engine / @oxagen/agent directly in-process
       (via withTenantDb — no HTTP hop to apps/api)
     → SSE stream consumed by use-tool-stream.ts
     → Inngest: chat.persist-stream
     → Engram memory consolidation
     → Neo4j graph sync
```

The app UI's primary chat path is this in-process Next.js Route Handler, not a
round trip through apps/api's Hono `/v1/:org/:ws/chat/messages` route — that
route remains for CLI/MCP/API-key callers (see CLAUDE.md "Main chat path").

## Data Flow — Background Agent / Fleet

```
CLI/MCP/A2A → dispatch_subagent (file: agent.subagent.dispatch.ts)
            → Inngest: agent.execute-subagent
            → @oxagen/agent-engine pipeline (planner/fork/oracle/evaluate)
            → Tool calls (sandbox/browser/code)
            → agent.sync-execution-to-graph
            → Neo4j lineage (get_execution_trace, file: agent.trace.get.ts /
              `oxagen trace`)
```

Post-ADR-025, capability *names* are verb-first snake_case
(`dispatch_subagent`, `get_execution_trace`); the dotted forms above are
still-current contract/route **file stems**, not registered names.

## Data Flow — A2A (Agent2Agent) Interop

```
External caller → POST /v1/:org/:ws/a2a  (JSON-RPC: message/send, tasks/get,
                                            tasks/resubscribe, tasks/cancel)
                → message.metadata.skillId selects a deployed agent slug
                  (unknown/inactive slug falls back to the generic agent)
                → apps/api/src/routes/a2a/{rpc,bridge,protocol,stream-registry}.ts
                → same execution + lineage pipeline as subagent fan-out
                → tasks/resubscribe live-attaches to the in-flight SSE stream
                  instead of polling
```

## Tenancy Model
Hierarchy: **Organization → Workspace → User**
- API keys carry `orgId + workspaceId` scope (no session needed)
- All `orgScoped` routes require `authMiddleware + orgMiddleware + workspaceMiddleware`
- `@oxagen/tenancy` enforces boundary checks

## Key Cross-Cutting Packages

| Package | Role |
|---------|------|
| `@oxagen/oxagen` | Contracts (Zod; 344 non-test contract files, 311 registered capabilities), CapabilityContext type, capability kernel |
| `@oxagen/handlers` | Shared business logic handlers (270 non-test files) |
| `@oxagen/database` | Drizzle schema + client (23 schema files, 55 migrations) |
| `@oxagen/engram` | Local DuckDB memory, context compilation, replay |
| `@oxagen/agent` | Agent runtime, dispatch, memory adapters (120 files) |
| `@oxagen/agent-engine` | Pipeline, planner, fork, oracle, evaluator, fleet (43 files) |
| `@oxagen/iam` | AuthZ, audit, access requests |
| `@oxagen/auth` | Better Auth, session/API-key resolution |
| `@oxagen/billing` | Stripe, credits, usage metering |
| `@oxagen/inngest-functions` | All async background jobs (~48 functions, count drifts) |
