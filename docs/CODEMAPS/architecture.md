<!-- Generated: 2025-07-10 | Files scanned: 1,543 | Token estimate: ~750 -->

# Architecture — Oxagen v2

## Project Type
**Monorepo** (pnpm workspaces + Turborepo) — 5 apps, 31 packages, 2 tooling packages.

## System Diagram

```
                        ┌─────────────────────────────────┐
                        │           Clients                │
                        │  Browser  │  CLI  │  MCP Client  │
                        └─────┬─────┴───┬───┴──────┬───────┘
                              │         │           │
                    ┌─────────▼──┐  ┌───▼────┐  ┌──▼────────┐
                    │  apps/app  │  │apps/cli│  │ apps/mcp  │
                    │ Next.js 15 │  │  Ink   │  │  xmcp     │
                    │  (RSC+SA)  │  │  REPL  │  │ /mcp SSE  │
                    └─────┬──────┘  └───┬────┘  └──┬────────┘
                          │             │            │
                          └─────────────┼────────────┘
                                        │  REST + SSE
                              ┌─────────▼──────────┐
                              │      apps/api       │
                              │   Hono on Node.js   │
                              │   api.oxagen.sh     │
                              └──┬──────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
    ┌─────────▼──────┐  ┌────────▼──────┐  ┌───────▼────────┐
    │  PostgreSQL     │  │   Neo4j       │  │   Inngest      │
    │  (Neon/local)   │  │  Knowledge    │  │  Background    │
    │  Drizzle ORM    │  │   Graph       │  │   Jobs         │
    └─────────────────┘  └───────────────┘  └────────────────┘
              │
    ┌─────────▼──────────────────────────────────────┐
    │              External Services                  │
    │  Stripe · Vercel Blob · GitHub App · AI Gateway │
    └─────────────────────────────────────────────────┘
```

## Service Boundaries

| Service | URL | Stack | Role |
|---------|-----|-------|------|
| `apps/api` | api.oxagen.sh | Hono + Node.js | REST API, webhooks, LLM proxy |
| `apps/app` | app.oxagen.sh | Next.js 15 (App Router) | Web UI, Server Actions |
| `apps/mcp` | mcp.oxagen.sh/mcp | xmcp (streamable HTTP) | MCP protocol surface |
| `apps/cli` | npm: `oxagen` | Ink + Commander | Local agent REPL + fleet |
| `apps/docs` | docs.oxagen.sh | — | Documentation site |

## Data Flow — Chat / Agent Execution

```
User → app/chat → SA: chatMessageSendRoute
     → POST /v1/:org/:ws/chat/messages
     → @oxagen/agent runtime
     → SSE stream back to client
     → Inngest: chat.persist-stream
     → Engram memory consolidation
     → Neo4j graph sync
```

## Data Flow — Background Agent

```
CLI/MCP → agent.subagent.dispatch
        → Inngest: agent.execute-subagent
        → @oxagen/agent-engine pipeline
        → Tool calls (sandbox/browser/code)
        → agent.sync-execution-to-graph
        → Neo4j lineage
```

## Tenancy Model
Hierarchy: **Organization → Workspace → User**
- API keys carry `orgId + workspaceId` scope (no session needed)
- All `orgScoped` routes require `authMiddleware + orgMiddleware + workspaceMiddleware`
- `@oxagen/tenancy` enforces boundary checks

## Key Cross-Cutting Packages

| Package | Role |
|---------|------|
| `@oxagen/oxagen` | Contracts (509 files), CapabilityContext type |
| `@oxagen/handlers` | Shared business logic handlers (398 files) |
| `@oxagen/database` | Drizzle schema + client (49 files) |
| `@oxagen/engram` | Memory system: embed/store/retrieve/sync (106 files) |
| `@oxagen/agent` | Agent runtime, dispatch, memory adapters (147 files) |
| `@oxagen/iam` | AuthZ, audit, access requests |
| `@oxagen/auth` | Better Auth, session/API-key resolution |
| `@oxagen/billing` | Stripe, credits, usage metering |
| `@oxagen/inngest-functions` | All async background jobs (82 files) |
