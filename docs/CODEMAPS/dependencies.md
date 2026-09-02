<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: all package.json | Token estimate: ~700 -->

# Dependencies & Integrations

## External Services

| Service | Purpose | Config Keys | Package |
|---------|---------|-------------|---------|
| **PostgreSQL** (Neon) | Primary data store | `DATABASE_URL` | `@oxagen/database` (Drizzle) |
| **Neo4j** | Knowledge graph, lineage, governed AgentMemory | `NEO4J_URI/USERNAME/PASSWORD/DATABASE` | `@oxagen/agent` |
| **Inngest** | Background job orchestration | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | `@oxagen/inngest-functions` |
| **Stripe** | Billing, subscriptions, credits | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `@oxagen/billing` |
| **Vercel Blob** | File/asset storage | `BLOB_READ_WRITE_TOKEN` | `@oxagen/storage` |
| **Vercel Sandbox** | Code execution sandbox | `VERCEL_SANDBOX_*` | `@oxagen/sandbox` |
| **AI Gateway** | LLM proxy (all models) | `AI_GATEWAY_API_KEY` | `@oxagen/ai` |
| **GitHub App** | OAuth, webhooks, repo sync | `GITHUB_APP_*` | `@oxagen/github` |
| **AWS KMS** | Credential encryption (optional) | `AWS_KMS_INGESTION_KEY_ARN` | `@oxagen/crypto` |

## AI / LLM

| Env Var | Role |
|---------|------|
| `OXAGEN_LLM_FAST` | Fast model (Haiku-class) |
| `OXAGEN_LLM_BALANCED` | Balanced model (Sonnet-class) |
| `OXAGEN_LLM_PRECISE` | Precise model (Opus-class) |
| `OXAGEN_LLM_ADVISOR` | Advisor/evaluator model |
| `OXAGEN_LLM_EVALUATOR` | Evaluation tasks |
| `OXAGEN_LLM_IMAGE_BASIC/ADVANCED` | Image generation |
| `OXAGEN_LLM_VIDEO_BASIC/ADVANCED` | Video generation |

All inference routes through **Vercel AI Gateway** (`@ai-sdk/openai-compatible`).
Package: `packages/ai/src/` — stream, generate-object, prompts registry.

## Key Third-Party Libraries

### API (`apps/api`)
```
hono                    HTTP framework
@hono/node-server       Node.js adapter
drizzle-orm             ORM
ai (Vercel AI SDK, 7.0.14) LLM streaming
inngest                 Background jobs
stripe                  Payments
better-auth             Auth sessions
```

### App (`apps/app`)
```
next (16.2.10)          React framework
@base-ui/react          Accessible primitives
@dnd-kit/*              Drag and drop
@modelcontextprotocol/sdk  MCP client
reagraph                WebGL graph visualization (knowledge graph)
reaviz                  Charts / visualizations
reablocks               Table + block layouts
```

### CLI (`apps/cli`)
```
ink                     React-based terminal UI
commander               CLI argument parsing
@ai-sdk/openai-compatible  LLM via API gateway
```

### MCP (`apps/mcp`)
```
xmcp                    MCP server framework (streamable HTTP)
@modelcontextprotocol/sdk  MCP protocol
```

## Internal Workspace Packages

| Package | Consumers | Role |
|---------|-----------|------|
| `@oxagen/oxagen` | api, app, mcp, handlers | Contracts (Zod schemas), CapabilityContext |
| `@oxagen/handlers` | api, app, mcp | Business logic handlers (473 total .ts incl. tests / 270 non-test) |
| `@oxagen/database` | api, app, handlers, agent, billing, ... | Drizzle schema + client |
| `@oxagen/auth` | api, app, mcp | Better Auth, session/API-key resolution |
| `@oxagen/agent` | api, app | Agent runtime, memory, dispatch |
| `@oxagen/agent-engine` | agent, api | Pipeline, planner, fleet, evaluator |
| `@oxagen/engram` | cli, agent | Local DuckDB memory, context compilation, replay |
| `@oxagen/ai` | api, app, cli, mcp | AI SDK wrappers, prompt registry |
| `@oxagen/billing` | api, app | Stripe, credits, usage |
| `@oxagen/iam` | api, handlers | AuthZ, audit emission |
| `@oxagen/ingestion` | api, handlers | Connectors, parsers, pipeline |
| `@oxagen/plugins` | api, app | Plugin catalog, credentials, entitlements |
| `@oxagen/inngest-functions` | api, app | All Inngest function definitions |
| `@oxagen/tenancy` | api, mcp, handlers | Org/workspace boundary enforcement |
| `@oxagen/sandbox` | api, agent | Code execution sandbox (Vercel) |
| `@oxagen/storage` | api, app, handlers | Vercel Blob abstraction |
| `@oxagen/crypto` | api, plugins, ingestion | AES-256-GCM / KMS encryption |
| `@oxagen/github` | api, ingestion | GitHub App client, OAuth |
| `@oxagen/notifications` | api, app | Notification delivery |
| `@oxagen/compliance` | app | SOC-2 compliance helpers |
| `@oxagen/telemetry` | api, app, cli | OpenTelemetry tracing |
| `@oxagen/config` | api, app, cli, mcp | Shared runtime config |
| `@oxagen/ontology` | api, handlers | Ontology query/management |
| `@oxagen/skills` | api, cli | Skill filesystem scanner |
| `@oxagen/ui` | app | coss ui component system (Base UI–based; migrated off shadcn/Radix) |
| `@oxagen/web` | app | Shared web utilities |
| `@oxagen/code-graph` | cli, api | Code graph indexing |
| `@oxagen/functions` | api, app | Shared function utilities |
| `@oxagen/mcp-config` | cli, mcp | MCP server config schema |
| `@oxagen/bench` | bench/web | Deterministic eval/replay benchmark engine (`runBenchmark()`) |

## Tooling Packages

| Package | Role |
|---------|------|
| `tools/env-manager` | Environment variable management |
| `tools/scripts` | Dev scripts, env-check, migration helpers |

## Build / CI

| Tool | Role |
|------|------|
| **Turborepo** | Monorepo task orchestration (build/test/lint) |
| **pnpm** | Package manager (workspaces) |
| **Vitest** | Unit + integration tests |
| **Playwright** | E2E tests (`apps/app/e2e/`) |
| **ESLint** | Linting (zero-warning gate) |
| **TypeScript** | Strict mode across all packages |
| **Drizzle Kit** | DB schema management |
| **Lefthook** | Git hooks (pre-push checks) |
| **Biome** | Formatter (biome.json) |

## Production Infrastructure

| Component | Provider |
|-----------|---------|
| API hosting | Vercel (Node.js runtime) |
| App hosting | Vercel (Next.js) |
| MCP hosting | Vercel |
| Database | Neon (PostgreSQL serverless) |
| Graph DB | Neo4j AuraDB |
| Job queue | Inngest Cloud |
| File storage | Vercel Blob |
| CDN / DNS | Vercel (oxagen.sh) |
