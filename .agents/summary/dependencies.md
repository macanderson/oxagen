# Dependencies

## Runtime Infrastructure

| Dependency | Version | Used In | Purpose |
|---|---|---|---|
| PostgreSQL | 16+ | All apps | Transactional state, RLS |
| Neo4j | 5+ | api, app, agent | Knowledge graph, vector search, lineage |
| ClickHouse | — | telemetry | Append-only events, audit, metrics |
| Inngest | — | api, inngest-functions | Durable background jobs |
| Vercel Blob | — | storage | Asset storage, signed URLs |
| Stripe | — | billing | Payments, subscriptions |

## Key npm Packages by Domain

### Framework & Routing
- `hono` — HTTP API (`apps/api`)
- `next` 16.2.7 — Web app (`apps/app`)
- `react` 19 — UI components
- `@hono/zod-validator` — Route input validation

### AI & LLM
- `ai` (Vercel AI SDK Core) — streaming, structured output
- `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/cohere` — provider adapters
- `@modelcontextprotocol/sdk` — MCP server implementation
- `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-javascript` — code parsing in ingestion

### Database
- `drizzle-orm` 0.45.2 (pinned via workspace override) — Postgres ORM
- `@atlas-go/sdk` — migration management via Atlas
- `neo4j-driver` — Neo4j client
- `@clickhouse/client` — ClickHouse client

### Auth
- `better-auth` — session management, OAuth, passkeys

### Billing
- `stripe` — Stripe API client

### Validation & Types
- `zod` — schema validation throughout (contracts, env, API inputs)

### Jobs
- `inngest` — durable function SDK

### UI
- `tailwindcss`, `@tailwindcss/typography` — styling
- `@radix-ui/*` — accessible primitives
- `framer-motion` — animations
- `reablocks`, `reagraph`, `reaviz` — enterprise UI, graph visualization, charts
- `react-markdown`, `remark-gfm` — markdown rendering

### CLI
- `commander` — CLI argument parsing
- `ink`, `ink-spinner` — terminal React rendering

### Storage & Crypto
- `@vercel/blob` — Blob storage
- `@google-cloud/secret-manager` — production KMS

### Email
- `nodemailer` — SMTP transport

### Code Quality
- `vitest` — unit + integration testing
- `@playwright/test` — E2E testing
- `eslint` 9.x, `typescript-eslint` — linting
- `prettier` 3.8 — formatting
- `lefthook` — git hooks
- `turbo` 2.9 — build orchestration

## Workspace Overrides (pnpm-workspace.yaml)

```yaml
overrides:
  drizzle-orm: 0.45.2        # Pinned — breaking changes in minor releases
  typescript: 6.0.3           # Single TS version across monorepo
  d3-path: 3.1.0
  d3-shape: 3.2.0
```

## Build Dependencies (onlyBuiltDependencies)

Native modules that require compilation: `@swc/core`, `cpu-features`, `esbuild`, `protobufjs`, `sharp`, `ssh2`, `tree-sitter-*`, `unrs-resolver`.

## External Services

| Service | Auth Method | Used By |
|---|---|---|
| Stripe | Secret key + webhook secret | `packages/billing` |
| Google APIs | OAuth2 / Service Account | `packages/ingestion` (gmail, drive, etc.) |
| GitHub API | OAuth App + App installation | `packages/ingestion`, `apps/api` |
| Linear API | OAuth2 | `packages/ingestion` |
| Slack API | OAuth2 + Signing secret | `packages/ingestion` |
| Salesforce | OAuth2 | `packages/ingestion` |
| Microsoft Graph | OAuth2 | `packages/ingestion` |
| Zoom | OAuth2 + Webhook secret | `packages/ingestion` |
| Vercel | API token (deploy + blob) | `tools/scripts/release.ts`, `packages/storage` |
| Inngest | Signing key + Event key | `packages/inngest-functions` |
| SMTP | Username + password | `packages/notifications` |
| Google Cloud KMS / Secret Manager | Service account | `packages/crypto` (prod KMS) |
